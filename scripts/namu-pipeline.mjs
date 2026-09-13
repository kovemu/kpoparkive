#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  findVisibleKoreanLinkLabels,
  findVisibleKoreanText,
} from "./namu-english-link-localizer.mjs";

const ROOT = process.cwd();
const DEFAULT_SUPABASE_URL = "https://hukrrzhltiyirtkxmotj.supabase.co";
const COMPATIBILITY_TARGET_VERSION = "modern-namu-compat-v8";
const ENGINE_PATCHSET_TARGET = "modern-namu-v2";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT, ".env.local"));
loadEnv(path.join(ROOT, ".env"));

const args = process.argv.slice(2);
const rootArg = args.find((arg) => arg.startsWith("--root="));
const positionalRoot = args.find((arg) => !arg.startsWith("--"));
const rootTitle = decodeURIComponent(
  rootArg ? rootArg.slice("--root=".length) : positionalRoot || "",
)
  .normalize("NFKC")
  .trim();
const json = args.includes("--json");
const expectedArg = args.find((arg) => arg.startsWith("--expected-count="));
const expectedCount = expectedArg ? Number(expectedArg.split("=")[1]) : null;

if (!rootTitle) {
  console.error('Usage: npm run namu:pipeline -- --root="방탄소년단"');
  process.exit(2);
}

const supabaseUrl = String(
  process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
).replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!serviceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(2);
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function textPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function metaCount(meta, countKey, arrayKey = countKey) {
  if (!meta || typeof meta !== "object") return 0;
  const numeric = Number(meta[countKey]);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Array.isArray(meta[arrayKey]) ? meta[arrayKey].length : 0;
}

async function db(pathname) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${pathname}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${body.slice(0, 1000)}`);
  }
  return body ? JSON.parse(body) : null;
}

function inspectHtml(html) {
  const value = String(html || "");
  const leaks = [];
  const checks = [
    ["raw-link", /\[\[[^\]]+\]\]/],
    ["include", /\[include\s*\(/i],
    ["wiki-directive", /\{\{\{#!(?:wiki|folding|if)/i],
    ["raw-table", /(?:^|[>\n])\|\|[^<\n]{1,300}\|\|/m],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(value)) leaks.push(name);
  }

  return {
    leaks,
    externalNamuLinks: (
      value.match(/href=["']https:\/\/namu\.wiki\/w\//gi) || []
    ).length,
  };
}

function sourceChecks(doc) {
  const blockers = [];
  if (!textPresent(doc?.source_wikitext)) {
    blockers.push("missing_canonical_raw");
    return { pass: false, blockers };
  }

  if (!doc?.source_namumark_rendered_at) blockers.push("missing_source_render");

  const meta =
    doc?.source_namumark_meta && typeof doc.source_namumark_meta === "object"
      ? doc.source_namumark_meta
      : null;

  if (!meta) {
    blockers.push("missing_source_render_meta");
  } else {
    if (meta.hasError === true) blockers.push("source_render_error");

    const compatVersion = String(meta?.compatibility?.version || "");
    const patchset = String(
      meta?.compatibility?.enginePatchset || meta?.enginePatchset || "",
    );

    if (compatVersion !== COMPATIBILITY_TARGET_VERSION) {
      blockers.push(
        "source_stale_compat:" + (compatVersion || "none"),
      );
    }
    if (patchset !== ENGINE_PATCHSET_TARGET) {
      blockers.push("source_stale_patchset:" + (patchset || "none"));
    }

    const missingFiles =
      metaCount(meta, "missingFileCount", "missingFiles");
    const missingTemplates =
      metaCount(meta, "missingTemplateCount", "missingTemplates");
    const missingYouTube = metaCount(
      meta,
      "missingYouTubeCount",
      "missingYouTubeEmbeds",
    );

    if (missingFiles > 0) blockers.push("source_missing_files:" + missingFiles);
    if (missingTemplates > 0) {
      blockers.push("source_missing_templates:" + missingTemplates);
    }
    if (missingYouTube > 0) {
      blockers.push("source_missing_youtube:" + missingYouTube);
    }
  }

  return { pass: blockers.length === 0, blockers };
}

function translationChecks(doc) {
  const blockers = [];

  if (doc?.content_language !== "en" || !textPresent(doc?.content_wikitext)) {
    blockers.push("missing_english_revision");
  }

  if (!["translated_by_chatgpt", "reviewed"].includes(
    String(doc?.translation_status || ""),
  )) {
    blockers.push(
      "translation_status:" + String(doc?.translation_status || "null"),
    );
  }

  if (Number(doc?.content_revision_no || 0) <= 0) {
    blockers.push("missing_content_revision");
  }

  const translatedTitle = String(doc?.translated_title || "")
    .normalize("NFKC")
    .trim();

  if (!translatedTitle) blockers.push("missing_translated_title");
  else if (/[가-힣]/.test(translatedTitle)) {
    blockers.push("translated_title_contains_hangul");
  }

  const sourceHash = String(doc?.source_hash || "");
  const translationSourceHash = String(doc?.translation_source_hash || "");
  if (
    sourceHash &&
    translationSourceHash &&
    sourceHash !== translationSourceHash
  ) {
    blockers.push("translation_stale_source_hash");
  }

  return { pass: blockers.length === 0, blockers };
}

function englishRenderChecks(doc) {
  const blockers = [];
  const html = String(doc?.content_namumark_html || "");

  if (html.length < 100) blockers.push("missing_current_render");
  if (!doc?.content_namumark_rendered_at) {
    blockers.push("missing_current_render_timestamp");
  }

  const meta =
    doc?.content_namumark_meta && typeof doc.content_namumark_meta === "object"
      ? doc.content_namumark_meta
      : null;

  if (!meta) {
    blockers.push("missing_current_render_meta");
  } else {
    const renderedRevision =
      Number(meta?.editableContent?.revisionNo || 0) || 0;
    const contentRevision = Number(doc?.content_revision_no || 0) || 0;

    if (!renderedRevision) blockers.push("missing_render_revision");
    else if (renderedRevision !== contentRevision) {
      blockers.push(
        `stale_current_render:r${renderedRevision}->r${contentRevision}`,
      );
    }

    if (meta.hasError === true) blockers.push("render_error");

    const missingFiles =
      metaCount(meta, "missingFileCount", "missingFiles");
    const missingTemplates =
      metaCount(meta, "missingTemplateCount", "missingTemplates");
    const missingYouTube = metaCount(
      meta,
      "missingYouTubeCount",
      "missingYouTubeEmbeds",
    );

    if (missingFiles > 0) blockers.push("missing_files:" + missingFiles);
    if (missingTemplates > 0) {
      blockers.push("missing_templates:" + missingTemplates);
    }
    if (missingYouTube > 0) {
      blockers.push("missing_youtube:" + missingYouTube);
    }
  }

  if (html) {
    const inspected = inspectHtml(html);
    if (inspected.leaks.length > 0) {
      blockers.push("syntax_leak:" + inspected.leaks.join("+"));
    }
    if (inspected.externalNamuLinks > 0) {
      blockers.push("absolute_namuwiki_links:" + inspected.externalNamuLinks);
    }

    const visibleKoreanLinks = findVisibleKoreanLinkLabels(html, { limit: 50 });
    if (visibleKoreanLinks.length > 0) {
      blockers.push("visible_korean_links:" + visibleKoreanLinks.length);
    }

    const visibleKoreanText = findVisibleKoreanText(html, { limit: 50 });
    if (visibleKoreanText.length > 0) {
      blockers.push("visible_korean_text:" + visibleKoreanText.length);
    }
  }

  return { pass: blockers.length === 0, blockers };
}

function publishChecks(doc) {
  const blockers = [];
  const contentRevision = Number(doc?.content_revision_no || 0) || 0;
  const publishedRevision = Number(doc?.published_revision_no || 0) || 0;

  if (!publishedRevision) blockers.push("not_published");
  else if (publishedRevision !== contentRevision) {
    blockers.push(
      `stale_publish:r${publishedRevision}->r${contentRevision}`,
    );
  }

  if (doc?.published_content_language !== "en") {
    blockers.push("published_language_not_en");
  }
  if (!textPresent(doc?.published_namumark_html)) {
    blockers.push("missing_published_html");
  }

  return { pass: blockers.length === 0, blockers };
}

function assessDocument(requirement, doc) {
  if (!doc) {
    return {
      sourceTitle: requirement.source_title,
      sourceDocumentId: requirement.source_document_id,
      stage: "RAW",
      status: "BLOCKED",
      nextAction: "capture_or_restore_document",
      blockers: ["missing_source_document"],
      checks: {
        raw: false,
        sourceRender: false,
        translation: false,
        englishRender: false,
        publish: false,
      },
    };
  }

  const hasRaw = textPresent(doc.source_wikitext);
  const source = sourceChecks(doc);
  const translation = translationChecks(doc);
  const englishRender = englishRenderChecks(doc);
  const publish = publishChecks(doc);

  let stage = "COMPLETE";
  let nextAction = "none";
  let blockers = [];

  if (!hasRaw) {
    stage = "RAW";
    nextAction = "capture_raw";
    blockers = ["missing_canonical_raw"];
  } else if (!source.pass) {
    stage = "SOURCE_RENDER";
    nextAction = "repair_or_render_source";
    blockers = source.blockers;
  } else if (!translation.pass) {
    stage = "TRANSLATION";
    nextAction = "translate_or_repair_translation";
    blockers = translation.blockers;
  } else if (!englishRender.pass) {
    stage = "EN_RENDER";
    nextAction = "render_or_repair_english";
    blockers = englishRender.blockers;
  } else if (!publish.pass) {
    stage = "PUBLISH";
    nextAction = "publish";
    blockers = publish.blockers;
  }

  return {
    sourceTitle: doc.source_title,
    translatedTitle: doc.translated_title || null,
    sourceDocumentId: doc.id,
    stage,
    status: stage === "COMPLETE" ? "PASS" : "WAIT",
    nextAction,
    blockers,
    contentRevision: Number(doc.content_revision_no || 0),
    publishedRevision: Number(doc.published_revision_no || 0),
    checks: {
      raw: hasRaw,
      sourceRender: source.pass,
      translation: translation.pass,
      englishRender: englishRender.pass,
      publish: publish.pass,
    },
  };
}

async function fetchScope(root) {
  const rows = await db(
    "namu_raw_requirements?root_title=eq." +
      enc(root) +
      "&status=neq.ignored" +
      "&select=source_document_id,source_title,status,priority,reason_codes" +
      "&order=priority.asc,source_title.asc",
  );

  return (rows || []).filter((row) => {
    const title = String(row?.source_title || "").normalize("NFKC").trim();
    return title && !title.startsWith("틀:");
  });
}

async function fetchDocuments(ids) {
  const rows = [];
  const select = [
    "id",
    "source_title",
    "root_title",
    "source_hash",
    "source_wikitext",
    "source_namumark_rendered_at",
    "source_namumark_meta",
    "translation_source_hash",
    "translation_status",
    "translated_title",
    "content_wikitext",
    "content_language",
    "content_status",
    "content_revision_no",
    "content_namumark_html",
    "content_namumark_meta",
    "content_namumark_rendered_at",
    "published_content_language",
    "published_revision_no",
    "published_namumark_html",
    "published_namumark_meta",
    "published_at",
  ].join(",");

  for (let index = 0; index < ids.length; index += 20) {
    const batch = ids.slice(index, index + 20);
    const filter = "(" + batch.join(",") + ")";
    const fetched = await db(
      "source_documents?id=in." +
        enc(filter) +
        "&select=" +
        select,
    );
    rows.push(...(fetched || []));
  }

  return rows;
}

const scope = await fetchScope(rootTitle);
const ids = [
  ...new Set(scope.map((row) => row.source_document_id).filter(Boolean)),
];
const docs = await fetchDocuments(ids);
const byId = new Map(docs.map((row) => [row.id, row]));
const results = scope.map((requirement) =>
  assessDocument(requirement, byId.get(requirement.source_document_id)),
);

const stages = [
  "RAW",
  "SOURCE_RENDER",
  "TRANSLATION",
  "EN_RENDER",
  "PUBLISH",
  "COMPLETE",
];

const stageCounts = Object.fromEntries(
  stages.map((stage) => [
    stage,
    results.filter((row) => row.stage === stage).length,
  ]),
);

const summary = {
  rootTitle,
  mode: "status-only",
  scopeCount: results.length,
  expectedCount,
  scopeCountMatches:
    expectedCount == null ? null : results.length === expectedCount,
  complete: stageCounts.COMPLETE,
  waiting: results.length - stageCounts.COMPLETE,
  stageCounts,
  generatedAt: new Date().toISOString(),
};

if (json) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log("");
  console.log("Kpoparkive Pipeline Controller · STATUS ONLY");
  console.log("root=" + rootTitle);
  console.log(
    "scope=" +
      summary.scopeCount +
      (expectedCount == null ? "" : "/" + expectedCount) +
      " complete=" +
      summary.complete +
      " waiting=" +
      summary.waiting,
  );
  console.log(
    stages
      .map((stage) => stage + "=" + stageCounts[stage])
      .join(" · "),
  );
  console.log("");

  for (const row of results) {
    const marker = row.stage === "COMPLETE" ? "PASS" : "WAIT";
    const details =
      row.blockers.length > 0 ? row.blockers.join(",") : "ready";
    console.log(
      marker.padEnd(4) +
        " " +
        row.stage.padEnd(13) +
        " " +
        row.sourceTitle +
        " · " +
        row.nextAction +
        " · " +
        details,
    );
  }

  console.log("");
  console.log(
    "This command is read-only. It does not translate, render, publish, or modify database rows.",
  );
}

const countMismatch =
  expectedCount != null && results.length !== expectedCount;
if (countMismatch) process.exitCode = 1;
