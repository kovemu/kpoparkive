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
const maxCore = Math.max(
  5,
  Math.min(60, Number(valueArg("max-core") || 40) || 40),
);
const DETECTOR_VERSION = "pipeline-core-v2-recursive-templates";

if (!rootTitle) {
  console.error(
    'Usage: npm run namu:scope -- --root="BLACKPINK" [--apply]',
  );
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

  return signals.reduce(
    (sum, pattern) => sum + (pattern.test(text) ? 1 : 0),
    0,
  );
}

function canonicalTemplateTitle(value) {
  const raw = normalized(value);
  if (!raw) return "";

  if (/^틀:/i.test(raw)) return raw;
  if (/^Template:/i.test(raw)) {
    return "틀:" + raw.replace(/^Template:/i, "").trim();
  }

  return "틀:" + raw;
}

function extractTemplateTargets(wikitext) {
  const result = new Set();
  const text = String(wikitext || "");

  for (const match of text.matchAll(
    /\[include\(\s*([^,\)\n]+)/gi,
  )) {
    const target = canonicalTemplateTitle(match[1]);
    if (target) result.add(target);
  }

  return [...result];
}

function rawPresent(doc) {
  return (
    typeof doc?.source_wikitext === "string" &&
    doc.source_wikitext.trim().length > 0
  );
}

async function fetchDocumentsByTitles(titles) {
  const unique = [...new Set(titles.map(normalized).filter(Boolean))];
  const rows = [];

  for (let index = 0; index < unique.length; index += 30) {
    const batch = unique.slice(index, index + 30);
    const filter = "(" + batch.map((value) => '"' + value.replace(/"/g, '\\"') + '"').join(",") + ")";

    const fetched =
      (await pipelineDb(
        "source_documents?source=eq.namu_mirror" +
          "&source_title=in." +
          encodeURIComponent(filter) +
          "&select=id,root_title,source_title,source_wikitext,raw_extracted_at,crawl_depth,discovered_relations",
      )) || [];

    rows.push(...fetched);
  }

  return rows;
}

async function fetchTemplateFallbacks(titles) {
  const unique = [...new Set(titles.map(normalized).filter(Boolean))];
  const rows = [];

  for (let index = 0; index < unique.length; index += 30) {
    const batch = unique.slice(index, index + 30);
    const filter = "(" + batch.map((value) => '"' + value.replace(/"/g, '\\"') + '"').join(",") + ")";

    const fetched =
      (await pipelineDb(
        "template_dom_fallbacks?template_title=in." +
          encodeURIComponent(filter) +
          "&source_html=not.is.null" +
          "&select=id,source_title,template_title,source_html,recovery_status,updated_at" +
          "&order=updated_at.desc",
      )) || [];

    rows.push(
      ...fetched.filter(
        (row) =>
          typeof row?.source_html === "string" &&
          row.source_html.length > 100,
      ),
    );
  }

  const byTemplate = new Map();

  for (const row of rows) {
    const title = normalized(row.template_title);
    if (title && !byTemplate.has(title)) {
      byTemplate.set(title, row);
    }
  }

  return byTemplate;
}

const cluster =
  (await pipelineDb(
    "source_documents?root_title=eq." +
      encodeURIComponent(rootTitle) +
      "&select=id,root_title,source_title,source_wikitext,raw_extracted_at,crawl_depth,discovered_relations" +
      "&order=crawl_depth.asc,source_title.asc",
  )) || [];

if (!cluster.length) {
  console.error(
    "No captured source_documents found for root " + rootTitle,
  );
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

  if (!doc || /^(?:틀|Template):/i.test(key)) return;

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

  if (
    reason === "root-activity-row" &&
    (label.includes("팬덤") || title.includes("팬덤"))
  ) {
    choose(title, "fandom", 88, score || 82);
    continue;
  }

  if (reason === "root-qualified-title") {
    const doc = byTitle.get(title);

    if (memberProfileScore(doc?.source_wikitext) >= 2) {
      choose(
        title,
        "qualified_member_profile",
        90,
        score || 95,
      );
    }
  }
}

// Fallback for captured root subdocuments that lack relation annotations.
for (const doc of cluster) {
  const title = normalized(doc.source_title);

  if (
    !title.startsWith(rootTitle + "/") ||
    /^(?:틀|Template):/i.test(title)
  ) {
    continue;
  }

  const suffix = title.slice(rootTitle.length + 1);

  if (excludedSubdocumentSuffixes.has(suffix)) continue;

  if (Number(doc.crawl_depth || 99) <= 1) {
    choose(title, "root_subdocument_fallback", 80, 80);
  }
}

const ordered = [...selected.values()]
  .sort(
    (a, b) =>
      b.priority - a.priority ||
      b.score - a.score ||
      a.title.localeCompare(b.title, "ko"),
  )
  .slice(0, maxCore);

const coreTitles = new Set(ordered.map((item) => item.title));

// Resolve template dependencies transitively and globally. source_documents is
// unique on (source, source_title), so a shared template may belong to an older
// root_title even though it is reusable for this team.
const requiredTemplates = new Set();
const dependencyDocs = new Map();
const queue = [];

for (const item of ordered) {
  for (const template of extractTemplateTargets(
    item.doc.source_wikitext,
  )) {
    if (!requiredTemplates.has(template)) {
      requiredTemplates.add(template);
      queue.push(template);
    }
  }
}

while (queue.length > 0) {
  const unresolvedBatch = [];

  while (queue.length > 0 && unresolvedBatch.length < 30) {
    const title = queue.shift();

    if (!dependencyDocs.has(title)) {
      unresolvedBatch.push(title);
    }
  }

  if (!unresolvedBatch.length) continue;

  const alreadyLocal = unresolvedBatch
    .map((title) => byTitle.get(title))
    .filter(Boolean);

  for (const doc of alreadyLocal) {
    dependencyDocs.set(normalized(doc.source_title), doc);
  }

  const missingTitles = unresolvedBatch.filter(
    (title) => !dependencyDocs.has(title),
  );

  if (missingTitles.length > 0) {
    const globalDocs = await fetchDocumentsByTitles(missingTitles);

    for (const doc of globalDocs) {
      dependencyDocs.set(normalized(doc.source_title), doc);
    }
  }

  for (const title of unresolvedBatch) {
    const doc = dependencyDocs.get(title);
    if (!doc || !rawPresent(doc)) continue;

    for (const nested of extractTemplateTargets(
      doc.source_wikitext,
    )) {
      if (!requiredTemplates.has(nested)) {
        requiredTemplates.add(nested);
        queue.push(nested);
      }
    }
  }
}

const fallbackByTemplate = await fetchTemplateFallbacks(
  [...requiredTemplates],
);

const allDocuments = new Map(
  cluster.map((doc) => [normalized(doc.source_title), doc]),
);

for (const [title, doc] of dependencyDocs.entries()) {
  allDocuments.set(title, doc);
}

const now = new Date().toISOString();
const rows = [];

for (const [title, doc] of allDocuments.entries()) {
  const isTemplate = /^(?:틀|Template):/i.test(title);
  const core = coreTitles.has(title);
  const templateRequired =
    isTemplate && requiredTemplates.has(title);
  const included = core || templateRequired;

  if (!included && doc.root_title !== rootTitle) {
    continue;
  }

  const hasRaw = rawPresent(doc);
  const fallback = templateRequired
    ? fallbackByTemplate.get(title)
    : null;
  const hasCapturedFallback = Boolean(fallback);

  let reasonCodes;
  let priority = 0;
  let score = 0;
  let status = "ignored";

  if (core) {
    const picked = selected.get(title);
    priority = picked?.priority || 80;
    score = picked?.score || priority;
    reasonCodes = [
      hasRaw ? "canonical_raw_present" : "canonical_raw_missing",
      picked?.reason || "core_scope",
    ];
    status = hasRaw ? "captured" : "needs_raw";
  } else if (templateRequired) {
    priority = 70;
    score = 100;

    if (hasRaw) {
      reasonCodes = [
        "canonical_raw_present",
        "core_template_dependency",
      ];
      status = "captured";
    } else if (hasCapturedFallback) {
      reasonCodes = [
        "captured_dom_fallback",
        "core_template_dependency",
      ];
      status = "captured";
    } else {
      reasonCodes = [
        "canonical_raw_missing",
        "captured_dom_fallback_missing",
        "core_template_dependency",
      ];
      status = "needs_raw";
    }
  } else {
    reasonCodes = ["outside_team_core_scope"];
  }

  rows.push({
    root_title: rootTitle,
    source_document_id: doc.id,
    source_title: title,
    status,
    priority,
    score,
    reason_codes: reasonCodes,
    detector_version: DETECTOR_VERSION,
    detected_at: now,
    raw_captured_at: hasRaw
      ? doc.raw_extracted_at || now
      : null,
    updated_at: now,
  });
}

// Keep ignored rows for root-cluster documents so a previous scope can be
// deterministically narrowed without leaving stale active requirements.
for (const doc of cluster) {
  const title = normalized(doc.source_title);

  if (rows.some((row) => row.source_title === title)) continue;

  rows.push({
    root_title: rootTitle,
    source_document_id: doc.id,
    source_title: title,
    status: "ignored",
    priority: 0,
    score: 0,
    reason_codes: ["outside_team_core_scope"],
    detector_version: DETECTOR_VERSION,
    detected_at: now,
    raw_captured_at: rawPresent(doc)
      ? doc.raw_extracted_at || now
      : null,
    updated_at: now,
  });
}

const missingRaw = rows
  .filter((row) => row.status === "needs_raw")
  .sort(
    (a, b) =>
      b.priority - a.priority ||
      a.source_title.localeCompare(b.source_title, "ko"),
  )
  .map((row) => ({
    title: row.source_title,
    priority: row.priority,
    reasons: row.reason_codes,
  }));

const reusableFallbackCount = rows.filter(
  (row) =>
    row.status === "captured" &&
    row.reason_codes.includes("captured_dom_fallback"),
).length;

const summary = {
  rootTitle,
  detectorVersion: DETECTOR_VERSION,
  apply,
  clusterDocuments: cluster.length,
  coreCount: ordered.length,
  templateDependencyCount: requiredTemplates.size,
  reusableFallbackCount,
  ignoredCount: rows.filter(
    (row) => row.status === "ignored",
  ).length,
  needsRawCount: missingRaw.length,
  missingRaw,
  core: ordered.map(
    ({ title, reason, priority, score }) => ({
      title,
      reason,
      priority,
      score,
    }),
  ),
  templates: [...requiredTemplates].sort((a, b) =>
    a.localeCompare(b, "ko"),
  ),
};

if (apply) {
  await pipelineDb(
    "namu_raw_requirements?on_conflict=root_title,source_title",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    },
  );
}

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    "Kpoparkive Core Scope · " +
      rootTitle +
      (apply ? " · APPLIED" : " · DRY RUN"),
  );

  console.log(
    "cluster=" +
      summary.clusterDocuments +
      " core=" +
      summary.coreCount +
      " templates=" +
      summary.templateDependencyCount +
      " reusableDOM=" +
      summary.reusableFallbackCount +
      " needsRaw=" +
      summary.needsRawCount,
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
    console.log(
      "Dry-run only. Add --apply to write namu_raw_requirements.",
    );
  }
}
