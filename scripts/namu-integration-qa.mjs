#!/usr/bin/env node

import { findVisibleKoreanLinkLabels, findVisibleKoreanText } from "./namu-english-link-localizer.mjs";

const DEFAULT_SUPABASE_URL = "https://hukrrzhltiyirtkxmotj.supabase.co";
const DEFAULT_BASE_URL = "https://kpoparkive.vercel.app";

const args = process.argv.slice(2);
const rootTitle = String(args.find((arg) => !arg.startsWith("--")) || "RESCENE").normalize("NFKC").trim();
const strict = args.includes("--strict");
const json = args.includes("--json");
const prepublish = args.includes("--prepublish");
const skipHttp = args.includes("--skip-http") || prepublish;
const expectedArg = args.find((arg) => arg.startsWith("--expected-count="));
const expectedCount = expectedArg ? Number(expectedArg.split("=")[1]) : null;

const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const baseUrl = String(process.env.KPOPARKIVE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");

if (!serviceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(2);
}

function enc(value) {
  return encodeURIComponent(String(value));
}

function publicPath(title) {
  return "/w/" + String(title).split("/").map((part) => encodeURIComponent(part)).join("/");
}

function textPresent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function metaCount(meta, key) {
  const value = meta && typeof meta === "object" ? meta[key] : null;
  if (Array.isArray(value)) return value.length;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

async function db(path) {
  const response = await fetch(supabaseUrl + "/rest/v1/" + path, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: "Bearer " + serviceRoleKey,
    },
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + body.slice(0, 500));
  return body ? JSON.parse(body) : null;
}

async function fetchDocuments(ids) {
  const rows = [];
  for (let index = 0; index < ids.length; index += 20) {
    const batch = ids.slice(index, index + 20);
    const filter = "(" + batch.join(",") + ")";
    const path =
      "source_documents?id=in." + enc(filter) +
      "&select=id,source_title,root_title,source_wikitext,source_namumark_meta,source_namumark_rendered_at,content_wikitext,content_language,content_status,translation_status,content_revision_no,published_revision_no,translated_title,content_namumark_html,published_namumark_html,content_namumark_meta,published_namumark_meta,content_namumark_rendered_at";
    rows.push(...await db(path));
  }
  return rows;
}

function internalWikiTargets(html) {
  const targets = new Set();
  const pattern = /href=["']\/w\/([^"'#?]+)/gi;
  for (const match of String(html || "").matchAll(pattern)) {
    try {
      const target = String(match[1] || "")
        .split("/")
        .map((part) => decodeURIComponent(part))
        .join("/")
        .normalize("NFKC")
        .trim();
      if (target) targets.add(target);
    } catch {
      // Malformed links are caught separately by syntax/route checks.
    }
  }
  return [...targets];
}

function inspectHtml(html) {
  const leaks = [];
  const checks = [
    ["raw-link", /\[\[[^\]]+\]\]/],
    ["include", /\[include\s*\(/i],
    ["wiki-directive", /\{\{\{#!(?:wiki|folding|if)/i],
    ["raw-table", /(?:^|[>\n])\|\|[^<\n]{1,300}\|\|/m],
  ];
  for (const [name, pattern] of checks) if (pattern.test(html)) leaks.push(name);

  return {
    leaks,
    externalNamuLinks: (html.match(/href=["']https:\/\/namu\.wiki\/w\//gi) || []).length,
    loadingImages: (html.match(/\bwiki-image-loading\b/g) || []).length,
    koreanUi: [
      />\s*목차\s*</.test(html) ? "목차" : null,
      />\s*편집\s*</.test(html) ? "편집" : null,
    ].filter(Boolean),
  };
}

async function inspectRoute(title, published) {
  const url = baseUrl + publicPath(title);
  try {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": "kpoparkive-integration-qa/1.0" },
    });
    const html = await response.text();
    const inspected = inspectHtml(html);
    const placeholder =
      /This document has not been published yet\.|This Kpoparkive document has not been imported yet\./.test(html);
    const ok = published
      ? response.status === 200 && !placeholder && inspected.externalNamuLinks === 0 && inspected.leaks.length === 0
      : response.status === 404;
    return { url, status: response.status, ok, placeholder, ...inspected };
  } catch (error) {
    return {
      url,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      leaks: [],
      externalNamuLinks: 0,
      loadingImages: 0,
      koreanUi: [],
    };
  }
}

const scope = (await db(
  "namu_raw_requirements?root_title=eq." + enc(rootTitle) +
  "&status=neq.ignored" +
  "&select=source_document_id,source_title,status,reason_codes" +
  "&order=source_title.asc"
)).filter((row) => !String(row.source_title || "").normalize("NFKC").startsWith("틀:"));

const ids = [...new Set(scope.map((row) => row.source_document_id).filter(Boolean))];
const docs = await fetchDocuments(ids);
const byId = new Map(docs.map((row) => [row.id, row]));
const coreTitles = new Set(scope.map((row) => String(row.source_title || "").normalize("NFKC").trim()));
const publishedCoreTitles = new Set(
  docs
    .filter((row) => Number(row.published_revision_no || 0) > 0 && textPresent(row.published_namumark_html))
    .map((row) => String(row.source_title || "").normalize("NFKC").trim())
);
const results = [];

for (const requirement of scope) {
  const doc = byId.get(requirement.source_document_id);
  if (!doc) {
    results.push({
      sourceTitle: requirement.source_title,
      readiness: "FAIL",
      blockers: ["missing_source_document"],
      warnings: [],
      route: null,
    });
    continue;
  }

  const blockers = [];
  const warnings = [];

  if (!textPresent(doc.source_wikitext)) blockers.push("missing_canonical_raw");
  if (!doc.source_namumark_rendered_at) blockers.push("missing_source_render");
  const sourceMeta = doc.source_namumark_meta && typeof doc.source_namumark_meta === "object"
    ? doc.source_namumark_meta
    : null;
  if (!sourceMeta) {
    blockers.push("missing_source_render_meta");
  } else {
    const sourceMissingFiles = metaCount(sourceMeta, "missingFileCount") || metaCount(sourceMeta, "missingFiles");
    const sourceMissingTemplates = metaCount(sourceMeta, "missingTemplateCount") || metaCount(sourceMeta, "missingTemplates");
    const sourceMissingYouTube = metaCount(sourceMeta, "missingYouTubeEmbeds");
    if (sourceMissingFiles > 0) blockers.push("source_missing_files:" + sourceMissingFiles);
    if (sourceMissingTemplates > 0) blockers.push("source_missing_templates:" + sourceMissingTemplates);
    if (sourceMissingYouTube > 0) blockers.push("source_missing_youtube:" + sourceMissingYouTube);

    const compatVersion = String(sourceMeta?.compatibility?.version || "");
    const enginePatchset = String(
      sourceMeta?.compatibility?.enginePatchset || sourceMeta?.enginePatchset || "",
    );
    if (compatVersion !== "modern-namu-compat-v8") {
      blockers.push("source_stale_compat:" + (compatVersion || "none"));
    }
    if (enginePatchset !== "modern-namu-v2") {
      blockers.push("source_stale_patchset:" + (enginePatchset || "none"));
    }
  }
  if (doc.content_language !== "en" || !textPresent(doc.content_wikitext)) blockers.push("missing_english_revision");
  if (doc.translation_status === "failed") blockers.push("translation_failed");
  if (!textPresent(doc.content_namumark_html)) blockers.push("missing_current_render");
  if (!doc.content_namumark_rendered_at) blockers.push("missing_current_render_timestamp");

  if (textPresent(doc.content_namumark_html)) {
    const currentTargets = internalWikiTargets(doc.content_namumark_html);
    const missingCoreTargets = currentTargets.filter((target) => coreTitles.has(target) && !publishedCoreTitles.has(target));
    const outsideCoreTargets = currentTargets.filter((target) => !coreTitles.has(target));
    if (missingCoreTargets.length > 0) {
      if (prepublish) warnings.push("core_links_pending_publish:" + missingCoreTargets.length);
      else blockers.push("core_links_unpublished:" + missingCoreTargets.length);
    }
    if (outsideCoreTargets.length > 0) warnings.push("outside_core_links:" + outsideCoreTargets.length);

    const meta = doc.content_namumark_meta;
    if (!meta || typeof meta !== "object") blockers.push("missing_render_meta");
    else {
      const renderedRevision = Number(meta?.editableContent?.revisionNo || 0) || 0;
      const contentRevision = Number(doc.content_revision_no || 0) || 0;
      if (!renderedRevision) blockers.push("missing_render_revision");
      else if (renderedRevision !== contentRevision) {
        blockers.push("stale_current_render:r" + renderedRevision + "->r" + contentRevision);
      }
      if (meta.hasError === true) blockers.push("render_error");
      const missingFiles = metaCount(meta, "missingFileCount") || metaCount(meta, "missingFiles");
      const missingTemplates = metaCount(meta, "missingTemplateCount") || metaCount(meta, "missingTemplates");
      const missingYouTube = metaCount(meta, "missingYouTubeEmbeds");
      if (missingFiles > 0) blockers.push("missing_files:" + missingFiles);
      if (missingTemplates > 0) blockers.push("missing_templates:" + missingTemplates);
      if (missingYouTube > 0) blockers.push("missing_youtube:" + missingYouTube);
    }

    const currentHtml = inspectHtml(doc.content_namumark_html);
    if (currentHtml.leaks.length > 0) blockers.push("current_syntax_leak:" + currentHtml.leaks.join("+"));

    const visibleKoreanLinks = findVisibleKoreanLinkLabels(doc.content_namumark_html, { limit: 50 });
    if (visibleKoreanLinks.length > 0) {
      blockers.push("visible_korean_links:" + visibleKoreanLinks.length);
    }

    const visibleKoreanText = findVisibleKoreanText(doc.content_namumark_html, { limit: 50 });
    if (visibleKoreanText.length > 0) {
      blockers.push("visible_korean_text:" + visibleKoreanText.length);
    }
  }

  const published =
    Number(doc.published_revision_no || 0) > 0 &&
    textPresent(doc.published_namumark_html);
  if (!published) {
    if (prepublish) warnings.push("pending_publish");
    else blockers.push("not_published");
  }

  const translatedTitle = String(doc.translated_title || "").normalize("NFKC").trim();
  if (!translatedTitle) blockers.push("missing_translated_title");
  else if (/[가-힣]/.test(translatedTitle)) blockers.push("translated_title_contains_hangul");

  const route = skipHttp ? null : await inspectRoute(doc.source_title, published);
  if (route && !route.ok) blockers.push(published ? "public_route_failed" : "unpublished_route_not_404");
  if (route?.loadingImages > 0) warnings.push("loading_images:" + route.loadingImages);
  if (route?.koreanUi.length > 0) warnings.push("korean_ui:" + route.koreanUi.join(","));

  results.push({
    sourceTitle: doc.source_title,
    translatedTitle: translatedTitle || null,
    contentLanguage: doc.content_language,
    contentStatus: doc.content_status,
    translationStatus: doc.translation_status,
    contentRevision: Number(doc.content_revision_no || 0),
    publishedRevision: Number(doc.published_revision_no || 0),
    published,
    readiness: blockers.length === 0 ? "PASS" : "BLOCKED",
    blockers,
    warnings,
    route,
  });
}

const summary = {
  rootTitle,
  baseUrl,
  scopeCount: results.length,
  expectedCount,
  scopeCountMatches: expectedCount == null ? null : results.length === expectedCount,
  pass: results.filter((row) => row.readiness === "PASS").length,
  blocked: results.filter((row) => row.readiness !== "PASS").length,
  published: results.filter((row) => row.published).length,
  canonicalRaw: results.filter((row) => !row.blockers.includes("missing_canonical_raw")).length,
  sourceRender: results.filter((row) =>
    !row.blockers.some((value) =>
      value === "missing_source_render" ||
      value === "missing_source_render_meta" ||
      value.startsWith("source_stale_compat:") ||
      value.startsWith("source_stale_patchset:")
    )
  ).length,
  sourceDependenciesClean: results.filter((row) =>
    !row.blockers.some((value) =>
      value.startsWith("source_missing_files:") ||
      value.startsWith("source_missing_templates:") ||
      value.startsWith("source_missing_youtube:")
    )
  ).length,
  englishRevision: results.filter((row) => !row.blockers.includes("missing_english_revision")).length,
  currentRender: results.filter((row) => !row.blockers.includes("missing_current_render")).length,
  freshRender: results.filter((row) =>
    !row.blockers.some((value) =>
      value === "missing_current_render" ||
      value === "missing_current_render_timestamp" ||
      value === "missing_render_revision" ||
      value.startsWith("stale_current_render:")
    )
  ).length,
  coreLinkFailures: results.filter((row) =>
    row.blockers.some((value) => value.startsWith("core_links_unpublished:"))
  ).length,
  outsideCoreLinkDocs: results.filter((row) =>
    row.warnings.some((value) => value.startsWith("outside_core_links:"))
  ).length,
  integrationFailures: results.filter((row) =>
    row.blockers.some((value) => value === "public_route_failed" || value === "unpublished_route_not_404")
  ).length,
  httpChecksSkipped: skipHttp,
  prepublish,
};

if (json) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log("Kpoparkive integration QA · " + rootTitle);
  console.log(
    "base=" + baseUrl +
    (prepublish ? " (prepublish; HTTP checks skipped)" : skipHttp ? " (HTTP checks skipped)" : "")
  );
  console.log(
    "scope=" + summary.scopeCount + (expectedCount == null ? "" : "/" + expectedCount) +
    " raw=" + summary.canonicalRaw + "/" + summary.scopeCount +
    " source-render=" + summary.sourceRender + "/" + summary.scopeCount +
    " source-deps=" + summary.sourceDependenciesClean + "/" + summary.scopeCount +
    " english=" + summary.englishRevision + "/" + summary.scopeCount +
    " render=" + summary.currentRender + "/" + summary.scopeCount +
    " fresh=" + summary.freshRender + "/" + summary.scopeCount +
    " published=" + summary.published + "/" + summary.scopeCount +
    " pass=" + summary.pass + "/" + summary.scopeCount
  );

  for (const row of results) {
    const marker = row.readiness === "PASS" ? "PASS" : "WAIT";
    const route = row.route ? "HTTP " + row.route.status : "NO ROUTE";
    const details = row.blockers.length ? row.blockers.join(",") : "ready";
    const warnings = row.warnings.length ? " · warn=" + row.warnings.join(",") : "";
    console.log(marker.padEnd(4) + " " + row.sourceTitle + " · " + route + " · " + details + warnings);
  }
}

const countFailed = expectedCount != null && results.length !== expectedCount;
const integrationFailed = summary.integrationFailures > 0;
const acceptanceFailed = summary.blocked > 0;

if (countFailed || integrationFailed || (strict && acceptanceFailed)) process.exitCode = 1;
