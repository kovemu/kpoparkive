#!/usr/bin/env node

import {
  pipelineDb,
  requireServiceRole,
} from "./lib/pipeline-db.mjs";

const args = process.argv.slice(2);
const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 3)) : "";
};

const rootTitle = (
  valueArg("root") ||
  args.find((arg) => !arg.startsWith("--")) ||
  ""
).normalize("NFKC").trim();

const apply = args.includes("--apply");
const json = args.includes("--json");
const maxCore = Math.max(5, Math.min(60, Number(valueArg("max-core") || 40) || 40));
const DETECTOR_VERSION = "pipeline-core-v1";

if (!rootTitle) {
  console.error('Usage: npm run namu:scope -- --root="BLACKPINK" [--apply]');
  process.exit(2);
}
requireServiceRole();

const excludedSubdocumentSuffixes = new Set([
  "노래방 수록 목록",
  "유튜브",
]);

function normalized(value) {
  return String(value || "").normalize("NFKC").trim();
}

function memberProfileScore(wikitext) {
  const text = String(wikitext || "");
  const signals = [
    /(?:^|\n)\|?\|?[^\n]{0,30}본명[^\n]{0,80}/m,
    /(?:^|\n)\|?\|?[^\n]{0,30}출생[^\n]{0,80}/m,
    /(?:^|\n)\|?\|?[^\n]{0,30}신체[^\n]{0,80}/m,
    /(?:^|\n)\|?\|?[^\n]{0,30}MBTI[^\n]{0,80}/m,
    /(?:^|\n)\|?\|?[^\n]{0,30}포지션[^\n]{0,80}/m,
    /(?:^|\n)\|?\|?[^\n]{0,30}소속사[^\n]{0,80}/m,
  ];
  return signals.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function extractTemplateTargets(wikitext) {
  const result = new Set();
  const text = String(wikitext || "");
  for (const match of text.matchAll(/\[include\(\s*([^,\)\n]+)/gi)) {
    const target = normalized(match[1]);
    if (target) result.add(target.startsWith("틀:") ? target : "틀:" + target);
  }
  return [...result];
}

function relationRank(reason) {
  switch (reason) {
    case "root": return 100;
    case "root-subdocument": return 95;
    case "root-member-row": return 92;
    case "root-qualified-title": return 90;
    case "root-activity-row": return 88;
    default: return 0;
  }
}

const cluster = await pipelineDb(
  "source_documents?root_title=eq." +
    encodeURIComponent(rootTitle) +
    "&select=id,source_title,source_wikitext,raw_extracted_at,crawl_depth,discovered_relations" +
    "&order=crawl_depth.asc,source_title.asc",
);

if (!cluster?.length) {
  console.error("No source_documents found for root " + rootTitle);
  process.exit(1);
}

const byTitle = new Map(
  cluster.map((row) => [normalized(row.source_title), row]),
);

const rootDoc = byTitle.get(rootTitle);
if (!rootDoc) {
  console.error("Root source document is missing: " + rootTitle);
  process.exit(1);
}

const selected = new Map();

function choose(title, reason, priority, score = priority) {
  const key = normalized(title);
  const doc = byTitle.get(key);
  if (!doc || key.startsWith("틀:")) return;
  const existing = selected.get(key);
  if (!existing || priority > existing.priority) {
    selected.set(key, {
      title: key,
      reason,
      priority,
      score,
      doc,
    });
  }
}

choose(rootTitle, "root", 100, 100);

for (const relation of Array.isArray(rootDoc.discovered_relations)
  ? rootDoc.discovered_relations
  : []) {
  const title = normalized(relation?.title);
  const label = normalized(relation?.label);
  const reason = normalized(relation?.reason);
  const score = Number(relation?.score || 0) || 0;
  if (!title || !byTitle.has(title)) continue;

  if (reason === "root-subdocument") {
    const suffix = title.startsWith(rootTitle + "/")
      ? title.slice(rootTitle.length + 1)
      : "";
    if (!excludedSubdocumentSuffixes.has(suffix)) {
      choose(title, "root_subdocument", 95, score || 100);
    }
    continue;
  }

  if (reason === "root-member-row") {
    choose(title, "member_row", 92, score || 90);
    continue;
  }

  if (reason === "root-activity-row" && (label.includes("팬덤") || title.includes("팬덤"))) {
    choose(title, "fandom", 88, score || 82);
    continue;
  }

  if (reason === "root-qualified-title") {
    const doc = byTitle.get(title);
    if (memberProfileScore(doc?.source_wikitext) >= 2) {
      choose(title, "qualified_member_profile", 90, score || 95);
    }
  }
}

// Some imports can miss relation annotations while still having canonical root subdocuments.
for (const doc of cluster) {
  const title = normalized(doc.source_title);
  if (!title.startsWith(rootTitle + "/") || title.startsWith("틀:")) continue;
  const suffix = title.slice(rootTitle.length + 1);
  if (excludedSubdocumentSuffixes.has(suffix)) continue;
  if (Number(doc.crawl_depth || 99) <= 1) {
    choose(title, "root_subdocument_fallback", 80, 80);
  }
}

const ordered = [...selected.values()]
  .sort((a, b) => b.priority - a.priority || b.score - a.score || a.title.localeCompare(b.title, "ko"))
  .slice(0, maxCore);

const coreTitles = new Set(ordered.map((item) => item.title));
const requiredTemplates = new Set();

for (const item of ordered) {
  for (const template of extractTemplateTargets(item.doc.source_wikitext)) {
    if (byTitle.has(template)) requiredTemplates.add(template);
  }
}

const now = new Date().toISOString();
const rows = [];

for (const doc of cluster) {
  const title = normalized(doc.source_title);
  const isTemplate = title.startsWith("틀:");
  const core = coreTitles.has(title);
  const templateRequired = isTemplate && requiredTemplates.has(title);
  const included = core || templateRequired;
  const rawPresent = typeof doc.source_wikitext === "string" && doc.source_wikitext.trim().length > 0;

  let reasonCodes;
  let priority = 0;
  let score = 0;

  if (core) {
    const picked = selected.get(title);
    priority = picked?.priority || 80;
    score = picked?.score || priority;
    reasonCodes = [picked?.reason || "core_scope"];
    if (rawPresent) reasonCodes.unshift("canonical_raw_present");
    else reasonCodes.unshift("canonical_raw_missing");
  } else if (templateRequired) {
    priority = 70;
    score = 100;
    reasonCodes = [rawPresent ? "canonical_raw_present" : "canonical_raw_missing", "core_template_dependency"];
  } else {
    reasonCodes = ["outside_team_core_scope"];
  }

  rows.push({
    root_title: rootTitle,
    source_document_id: doc.id,
    source_title: title,
    status: included ? (rawPresent ? "captured" : "needs_raw") : "ignored",
    priority,
    score,
    reason_codes: reasonCodes,
    detector_version: DETECTOR_VERSION,
    detected_at: now,
    raw_captured_at: rawPresent ? (doc.raw_extracted_at || now) : null,
    updated_at: now,
  });
}

const missingRaw = rows
  .filter((row) => row.status === "needs_raw")
  .sort((a, b) => b.priority - a.priority || a.source_title.localeCompare(b.source_title, "ko"))
  .map((row) => ({
    title: row.source_title,
    priority: row.priority,
    reasons: row.reason_codes,
  }));

const summary = {
  rootTitle,
  detectorVersion: DETECTOR_VERSION,
  apply,
  clusterDocuments: cluster.length,
  coreCount: ordered.length,
  templateDependencyCount: requiredTemplates.size,
  ignoredCount: rows.filter((row) => row.status === "ignored").length,
  needsRawCount: missingRaw.length,
  missingRaw,
  core: ordered.map(({ title, reason, priority, score }) => ({
    title,
    reason,
    priority,
    score,
  })),
  templates: [...requiredTemplates].sort((a, b) => a.localeCompare(b, "ko")),
};

if (apply) {
  await pipelineDb(
    "namu_raw_requirements?on_conflict=root_title,source_title",
    {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    },
  );
}

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log("Kpoparkive Core Scope · " + rootTitle + (apply ? " · APPLIED" : " · DRY RUN"));
  console.log(
    "cluster=" + summary.clusterDocuments +
      " core=" + summary.coreCount +
      " templates=" + summary.templateDependencyCount +
      " needsRaw=" + summary.needsRawCount,
  );
  for (const item of summary.core) {
    console.log(
      String(item.priority).padStart(3) +
        " " +
        item.title +
        " · " +
        item.reason,
    );
  }
  if (!apply) {
    console.log("");
    console.log("Dry-run only. Add --apply to write namu_raw_requirements.");
  }
}
