import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const { parse: parseHtml } = createRequire(import.meta.url)("node-html-parser");

const ROOT_DIR = process.cwd();
const ROOT_TITLE = decodeURIComponent(
  process.argv.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) || "RESCENE"
).normalize("NFKC").trim();
const MODE = String(
  process.argv.find((arg) => arg.startsWith("--mode="))?.slice("--mode=".length) || "both"
).toLowerCase();
if (!["source", "content", "both"].includes(MODE)) {
  throw new Error("--mode must be source, content, or both");
}
const SHOULD_RENDER = process.argv.includes("--render");
const JSON_ONLY = process.argv.includes("--json");
const explicitExpected = Number(
  process.argv.find((arg) => arg.startsWith("--expected="))?.slice("--expected=".length) || 0
);
const EXPECTED_SCOPE = explicitExpected || (ROOT_TITLE === "방탄소년단" ? 33 : 0);
const SOURCE_RENDERER = path.join(ROOT_DIR, "scripts", "namumark-thetree-compat-poc.mjs");
const CONTENT_RENDERER = path.join(ROOT_DIR, "scripts", "namumark-thetree-content.mjs");
const EXPECTED_COMPAT_VERSION = String(
  process.env.KPOPARKIVE_EXPECTED_COMPAT_VERSION || "modern-namu-compat-v8"
);
const EXPECTED_ENGINE_PATCHSET = String(
  process.env.KPOPARKIVE_EXPECTED_ENGINE_PATCHSET || "modern-namu-v2"
);

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");

async function db(pathname) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function dbAll(pathname, pageSize = 1000) {
  const rows = [];
  const separator = pathname.includes("?") ? "&" : "?";
  for (let offset = 0; offset < 30000; offset += pageSize) {
    const batch = await db(`${pathname}${separator}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(batch)) throw new Error("Expected array response");
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`Pagination limit reached for ${pathname}`);
}

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function canonicalAssetKey(value) {
  return normalizeTitle(value)
    .replace(/^(?:파일|File):/i, "")
    .replace(/[?#].*$/, "")
    .toLowerCase();
}

function canonicalRevision(rawValue) {
  return `sha256:${crypto.createHash("sha256").update(String(rawValue || "")).digest("hex")}`;
}

function countMatches(value, pattern) {
  return (String(value || "").match(pattern) || []).length;
}

function activeSource(rawValue) {
  return String(rawValue || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*##/.test(line))
    .join("\n");
}

function sourceFeatures(rawValue) {
  const raw = activeSource(rawValue);
  const articleLinks = [...raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)]
    .map((match) => normalizeTitle(match[1]))
    .filter((target) => target && !/^(?:파일|File|분류|Category):/i.test(target));
  const fileRefs = [...raw.matchAll(/\[\[(?:파일|File):([^\]|]+)/gi)]
    .map((match) => canonicalAssetKey(match[1]))
    .filter(Boolean);
  return {
    tableLines: countMatches(raw, /(?:^|\n)[^\n]*\|\|/g),
    folding: countMatches(raw, /#!folding\b/g),
    include: countMatches(raw, /\[include\(/gi),
    wiki: countMatches(raw, /#!wiki\b/g),
    if: countMatches(raw, /#!if\b/g),
    footnote: countMatches(raw, /\[\*(?!\*)/g),
    youtube: countMatches(raw, /\[youtube\(/gi),
    colspan: countMatches(raw, /<-\d+>/g),
    rowspan: countMatches(raw, /<(?:\^|v)?\|\d+>/g),
    headings: countMatches(raw, /(?:^|\n)={1,6}\s*[^\n=].*?\s*={1,6}(?=\n|$)/g),
    toc: countMatches(raw, /\[(?:목차|tableofcontents)\]/gi),
    links: articleLinks.length,
    fileRefs: fileRefs.length,
    category: countMatches(raw, /\[\[(?:분류|Category):/gi),
  };
}

function renderedFeatures(htmlValue) {
  const html = String(htmlValue || "");
  if (!html) {
    return {
      tables: 0, details: 0, footnotes: 0, youtube: 0, colspan: 0, rowspan: 0,
      headings: 0, toc: 0, links: 0, images: 0, svg: 0, parseError: false,
    };
  }
  let root;
  try {
    root = parseHtml(`<div id="kpoparkive-render-audit-root">${html}</div>`, { comment: false });
  } catch {
    return {
      tables: 0, details: 0, footnotes: 0, youtube: 0, colspan: 0, rowspan: 0,
      headings: 0, toc: 0, links: 0, images: 0, svg: 0, parseError: true,
    };
  }
  return {
    tables: root.querySelectorAll("table").length,
    details: root.querySelectorAll("details").length,
    footnotes: root.querySelectorAll(".wiki-fn-content").length,
    youtube: root.querySelectorAll('iframe[src*="youtube.com/embed/"],iframe[src*="youtube-nocookie.com/embed/"]').length,
    colspan: root.querySelectorAll("[colspan]").length,
    rowspan: root.querySelectorAll("[rowspan]").length,
    headings: root.querySelectorAll(".wiki-heading,h1,h2,h3,h4,h5,h6").length,
    toc: root.querySelectorAll(".wiki-macro-toc").length,
    links: root.querySelectorAll("a.wiki-link-internal").length,
    images: root.querySelectorAll("img").length,
    svg: root.querySelectorAll("svg").length,
    parseError: false,
  };
}

const LEAK_PATTERNS = [
  ["directive", /#!(?:wiki|if|folding)\b/gi],
  ["include", /\[include\(/gi],
  ["file-link", /\[\[(?:파일|File):/gi],
  ["youtube-macro", /\[youtube\(/gi],
  ["table-param", /<(?:table)?(?:align|width|height|bordercolor|bgcolor|color|class)\s*=\s*[^>]{0,180}>/gi],
  ["cell-param", /<(?:col|row)?(?:bgcolor|color|class|keepall|nopad|width|height)\b[^>]{0,180}>/gi],
  ["bare-color-param", /<\s*#[0-9a-f]{3,8}\s*(?:,\s*#[0-9a-f]{3,8}\s*)?>/gi],
  ["table-span-param", /<(?:-\d+|(?:\^|v)?\|\d+|[:()])>/g],
];

function visibleRenderText(htmlValue) {
  try {
    const root = parseHtml(`<div id="kpoparkive-render-audit-root">${String(htmlValue || "")}</div>`, { comment: false });
    for (const node of root.querySelectorAll("script,style,noscript")) node.remove();
    return String(root.innerText || root.text || "");
  } catch {
    return String(htmlValue || "");
  }
}

function scanCriticalSyntaxLeaks(htmlValue) {
  const text = visibleRenderText(htmlValue);
  const leaks = [];
  for (const [kind, pattern] of LEAK_PATTERNS) {
    pattern.lastIndex = 0;
    const samples = [];
    let count = 0;
    let match;
    while ((match = pattern.exec(text))) {
      count += 1;
      if (samples.length < 5) {
        const start = Math.max(0, match.index - 45);
        const end = Math.min(text.length, match.index + match[0].length + 75);
        samples.push(text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 180));
      }
      if (pattern.lastIndex === match.index) pattern.lastIndex += 1;
    }
    if (count) leaks.push({ kind, count, samples: [...new Set(samples)] });
  }
  return leaks;
}

function listMeta(meta, key) {
  return Array.isArray(meta?.[key]) ? meta[key].map(String) : [];
}

function englishReady(document) {
  return document?.content_language === "en"
    && Number(document?.content_revision_no || 0) > 0
    && typeof document?.content_wikitext === "string"
    && document.content_wikitext.trim().length > 0;
}

function renderTitle(title, mode) {
  const renderer = mode === "content" ? CONTENT_RENDERER : SOURCE_RENDERER;
  const result = spawnSync(
    process.execPath,
    ["--no-node-snapshot", renderer, title],
    { cwd: ROOT_DIR, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${mode} renderer failed for ${title} with exit code ${result.status}`);
  }
}

async function loadScope() {
  const requirements = await db(
    "namu_raw_requirements?root_title=eq." + encodeURIComponent(ROOT_TITLE)
      + "&status=eq.captured"
      + "&select=source_document_id,source_title,status,priority,score,reason_codes"
      + "&order=source_title.asc"
  );
  if (!Array.isArray(requirements) || !requirements.length) {
    throw new Error(`No captured canonical core documents found for ${ROOT_TITLE}`);
  }
  if (EXPECTED_SCOPE && requirements.length !== EXPECTED_SCOPE) {
    throw new Error(
      `Core scope drift for ${ROOT_TITLE}: expected ${EXPECTED_SCOPE}, got ${requirements.length}. Refusing to render.`
    );
  }

  const output = [];
  for (const requirement of requirements) {
    const rows = await db(
      "source_documents?id=eq." + encodeURIComponent(requirement.source_document_id)
        + "&select=id,source_title,source_wikitext,raw_extracted_at,"
        + "source_namumark_html,source_namumark_meta,source_namumark_engine,source_namumark_engine_version,source_namumark_rendered_at,"
        + "content_wikitext,content_language,content_status,content_revision_no,translation_status,"
        + "content_namumark_html,content_namumark_meta,content_namumark_engine,content_namumark_engine_version,content_namumark_rendered_at"
        + "&limit=1"
    );
    output.push({ requirement, document: rows?.[0] || null });
  }
  return output;
}

async function loadDependencyIndex() {
  const [documents, assets] = await Promise.all([
    dbAll(
      "source_documents?source=eq.namu_mirror&source_wikitext=not.is.null"
        + "&select=source_title,raw_extracted_at,updated_at"
    ),
    dbAll(
      "source_asset_queue?asset_type=eq.image&status=eq.resolved"
        + "&select=source_ref,label,updated_at"
    ),
  ]);
  const templates = new Map();
  for (const row of documents) {
    const title = normalizeTitle(row?.source_title);
    if (!title || !/^(?:틀|Template):/i.test(title)) continue;
    const timestamp = Date.parse(row?.raw_extracted_at || row?.updated_at || "");
    if (!Number.isFinite(timestamp)) continue;
    templates.set(title, Math.max(templates.get(title) || 0, timestamp));
  }
  const files = new Map();
  for (const row of assets) {
    const key = canonicalAssetKey(row?.source_ref || row?.label || "");
    if (!key) continue;
    const timestamp = Date.parse(row?.updated_at || "");
    if (!Number.isFinite(timestamp)) continue;
    files.set(key, Math.max(files.get(key) || 0, timestamp));
  }
  return { templates, files };
}

function dependencyFreshness(meta, renderedAt, dependencyIndex) {
  const renderedTs = Date.parse(renderedAt || "");
  if (!Number.isFinite(renderedTs)) return { stale: false, latestAt: null, newer: [] };
  let latest = 0;
  const newer = [];
  for (const title of listMeta(meta, "referencedTemplates")) {
    const ts = dependencyIndex.templates.get(normalizeTitle(title)) || 0;
    latest = Math.max(latest, ts);
    if (ts > renderedTs) newer.push(`template:${title}`);
  }
  for (const file of listMeta(meta, "requiredFiles")) {
    const ts = dependencyIndex.files.get(canonicalAssetKey(file)) || 0;
    latest = Math.max(latest, ts);
    if (ts > renderedTs) newer.push(`file:${file}`);
  }
  return {
    stale: newer.length > 0,
    latestAt: latest ? new Date(latest).toISOString() : null,
    newer,
  };
}

function analyze(item, mode, dependencyIndex, renderRunError = null) {
  const document = item.document || {};
  const isContent = mode === "content";
  const inputReady = isContent ? englishReady(document) : Boolean(document.source_wikitext);
  const raw = String(isContent ? document.content_wikitext || "" : document.source_wikitext || "");
  const html = String(isContent ? document.content_namumark_html || "" : document.source_namumark_html || "");
  const metaValue = isContent ? document.content_namumark_meta : document.source_namumark_meta;
  const meta = metaValue && typeof metaValue === "object" ? metaValue : {};
  const renderedAt = isContent ? document.content_namumark_rendered_at : document.source_namumark_rendered_at;
  const source = sourceFeatures(raw);
  const rendered = renderedFeatures(html);
  const leaks = html ? scanCriticalSyntaxLeaks(html) : [];
  const missingTemplates = listMeta(meta, "missingTemplates");
  const missingFiles = listMeta(meta, "missingFiles");
  const missingYouTube = listMeta(meta, "missingYouTubeEmbeds");
  const compatVersion = String(meta?.compatibility?.version || "");
  const enginePatchset = String(meta?.compatibility?.enginePatchset || meta?.enginePatchset || "");
  const missingRender = inputReady && !html;
  const staleEngine = Boolean(html) && (
    compatVersion !== EXPECTED_COMPAT_VERSION
      || enginePatchset !== EXPECTED_ENGINE_PATCHSET
  );

  const currentRevision = isContent
    ? Number(document.content_revision_no || 0) || 0
    : canonicalRevision(raw);
  const renderedRevision = isContent
    ? Number(meta?.renderedRevision ?? meta?.editableContent?.revisionNo ?? 0) || 0
    : String(meta?.renderedRevision || "");
  const staleRevision = Boolean(html) && (
    isContent
      ? renderedRevision !== currentRevision
      : renderedRevision !== currentRevision
  );

  const dependency = dependencyFreshness(meta, renderedAt, dependencyIndex);
  const hasError = Boolean(html) && (Boolean(meta.hasError) || rendered.parseError);
  const leakCount = leaks.reduce((sum, entry) => sum + entry.count, 0);
  const structuralLoss = {
    folding: Math.max(0, source.folding - rendered.details),
    footnotes: Math.max(0, source.footnote - rendered.footnotes),
    youtube: Math.max(0, source.youtube - rendered.youtube),
    colspan: Math.max(0, source.colspan - rendered.colspan),
    rowspan: Math.max(0, source.rowspan - rendered.rowspan),
    headings: Math.max(0, source.headings - rendered.headings),
    toc: Math.max(0, source.toc - rendered.toc),
    links: Math.max(0, source.links - rendered.links),
    images: Math.max(0, source.fileRefs - rendered.images - rendered.svg),
  };
  const structuralLossCount = Object.values(structuralLoss).reduce((sum, value) => sum + value, 0);
  const engineFailure = Boolean(renderRunError)
    || hasError
    || leakCount > 0
    || missingYouTube.length > 0
    || structuralLossCount > 0;
  const dependencyGap = missingTemplates.length > 0 || missingFiles.length > 0;

  let status = "OK";
  if (!inputReady) status = isContent ? "TRANSLATION_PENDING" : "NO_SOURCE";
  else if (missingRender) status = "UNRENDERED";
  else if (staleRevision) status = "STALE_REVISION";
  else if (staleEngine) status = "STALE_ENGINE";
  else if (dependency.stale) status = "STALE_DEPENDENCY";
  else if (engineFailure) status = "ENGINE_FAIL";
  else if (dependencyGap) status = "DEPENDENCY";

  return {
    title: item.requirement.source_title,
    mode,
    inputReady,
    rawChars: raw.length,
    htmlChars: html.length,
    currentRevision,
    renderedRevision,
    renderedAt: renderedAt || null,
    compatVersion,
    enginePatchset,
    staleEngine,
    staleRevision,
    staleDependency: dependency.stale,
    dependency,
    missingRender,
    hasError,
    source,
    rendered,
    missingTemplates,
    missingFiles,
    missingYouTube,
    leaks,
    leakCount,
    structuralLoss,
    structuralLossCount,
    engineFailure,
    dependencyGap,
    renderRunError,
    status,
  };
}

function shortRevision(row) {
  if (row.mode === "content") {
    if (!row.inputReady) return "-";
    return `r${row.renderedRevision || "?"}/r${row.currentRevision || "?"}`;
  }
  const short = (value) => String(value || "-").replace(/^sha256:/, "").slice(0, 10);
  return `${short(row.renderedRevision)}/${short(row.currentRevision)}`;
}

function matrixRows(documents) {
  return documents.map((row) => ({
    Document: row.title,
    Status: row.status,
    Error: row.hasError || row.renderRunError ? 1 : 0,
    Patch: row.staleEngine
      ? `${row.compatVersion || "-"}/${row.enginePatchset || "-"}`
      : row.inputReady && row.htmlChars ? "current" : "-",
    Tables: row.rendered.tables,
    Folding: `${row.source.folding}/${row.rendered.details}`,
    Footnotes: `${row.source.footnote}/${row.rendered.footnotes}`,
    YouTube: `${row.source.youtube}/${row.rendered.youtube}`,
    Colspan: `${row.source.colspan}/${row.rendered.colspan}`,
    Rowspan: `${row.source.rowspan}/${row.rendered.rowspan}`,
    "Missing Templates": row.missingTemplates.length,
    "Missing Files": row.missingFiles.length,
    "Syntax Leaks": row.leakCount,
    "Structural Loss": row.structuralLossCount,
    "Rendered Revision": shortRevision(row),
  }));
}

function summarize(documents) {
  return {
    total: documents.length,
    engineFailures: documents.filter((row) => row.status === "ENGINE_FAIL").length,
    staleEngines: documents.filter((row) => row.status === "STALE_ENGINE").length,
    staleRevisions: documents.filter((row) => row.status === "STALE_REVISION").length,
    staleDependencies: documents.filter((row) => row.status === "STALE_DEPENDENCY").length,
    unrendered: documents.filter((row) => row.status === "UNRENDERED").length,
    translationPending: documents.filter((row) => row.status === "TRANSLATION_PENDING").length,
    dependencyGaps: documents.filter((row) => row.status === "DEPENDENCY").length,
    clean: documents.filter((row) => row.status === "OK").length,
  };
}

async function runRenderPass(scope, mode, failures) {
  let index = 0;
  for (const item of scope) {
    index += 1;
    const title = item.requirement.source_title;
    if (mode === "content" && !englishReady(item.document)) {
      console.log(`[${index}/${scope.length}] SKIP EN ${title}: translation not ready`);
      continue;
    }
    console.log(`\n[${index}/${scope.length}] RENDER ${mode.toUpperCase()} ${title}`);
    try {
      renderTitle(title, mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.set(`${mode}:${title}`, message);
      console.error(`RENDER PROCESS FAILED ${mode} ${title}: ${message}`);
    }
  }
}

function printDetailedFailures(label, documents) {
  for (const row of documents.filter((item) => item.status !== "OK" && item.status !== "TRANSLATION_PENDING" && item.status !== "DEPENDENCY")) {
    console.log(`\n${label} ${row.status} ${row.title}`);
    if (row.renderRunError) console.log(`  render process: ${row.renderRunError}`);
    if (row.staleRevision) console.log(`  revision: rendered=${row.renderedRevision || "-"} current=${row.currentRevision || "-"}`);
    if (row.staleEngine) console.log(`  engine: ${row.compatVersion || "-"} / ${row.enginePatchset || "-"}`);
    if (row.staleDependency) {
      console.log(`  dependency changed after render: ${row.dependency.newer.slice(0, 12).join(" | ")}`);
    }
    if (row.missingYouTube.length) console.log(`  youtube missing: ${row.missingYouTube.join(" | ")}`);
    if (row.structuralLossCount > 0) {
      console.log(`  structural loss: ${JSON.stringify(row.structuralLoss)}`);
    }
    for (const leak of row.leaks) {
      console.log(`  leak ${leak.kind}: ${leak.count}`);
      for (const sample of leak.samples) console.log(`    - ${sample}`);
    }
  }
}

async function main() {
  let scope = await loadScope();
  const failures = new Map();

  if (SHOULD_RENDER && (MODE === "source" || MODE === "both")) {
    await runRenderPass(scope, "source", failures);
    scope = await loadScope();
  }
  if (SHOULD_RENDER && (MODE === "content" || MODE === "both")) {
    await runRenderPass(scope, "content", failures);
    scope = await loadScope();
  }

  const dependencyIndex = await loadDependencyIndex();
  const reports = {};

  if (MODE === "source" || MODE === "both") {
    const documents = scope.map((item) =>
      analyze(item, "source", dependencyIndex, failures.get(`source:${item.requirement.source_title}`) || null)
    );
    reports.source = { summary: summarize(documents), documents };
  }
  if (MODE === "content" || MODE === "both") {
    const documents = scope.map((item) =>
      analyze(item, "content", dependencyIndex, failures.get(`content:${item.requirement.source_title}`) || null)
    );
    reports.content = { summary: summarize(documents), documents };
  }

  const report = {
    rootTitle: ROOT_TITLE,
    expectedScope: EXPECTED_SCOPE || null,
    mode: MODE,
    rendered: SHOULD_RENDER,
    generatedAt: new Date().toISOString(),
    ...reports,
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    for (const [key, value] of Object.entries(reports)) {
      const label = key === "source" ? "SOURCE" : "ENGLISH";
      console.log(`\nKpoparkive The Tree failure matrix: ${ROOT_TITLE} · ${label}`);
      console.table(matrixRows(value.documents));
      const s = value.summary;
      console.log(
        `SUMMARY ${label.toLowerCase()} total=${s.total} engine-fail=${s.engineFailures} stale-engine=${s.staleEngines} stale-revision=${s.staleRevisions} stale-dependency=${s.staleDependencies} unrendered=${s.unrendered} translation-pending=${s.translationPending} dependency-gap=${s.dependencyGaps} clean=${s.clean}`
      );
      printDetailedFailures(label, value.documents);

      const dependencyOnly = value.documents.filter((row) => row.status === "DEPENDENCY");
      if (dependencyOnly.length) {
        console.log(`\n${label} DEPENDENCY-ONLY (Template/Asset rooms)`);
        for (const row of dependencyOnly) {
          console.log(`  ${row.title}: templates=${row.missingTemplates.length} files=${row.missingFiles.length}`);
        }
      }
    }
  }

  const blocking = Object.values(reports).some(({ summary }) =>
    summary.engineFailures > 0
      || summary.staleEngines > 0
      || summary.staleRevisions > 0
      || summary.staleDependencies > 0
      || summary.unrendered > 0
  );
  if (blocking) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
