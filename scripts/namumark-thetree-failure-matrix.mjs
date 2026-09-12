import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const { parse: parseHtml } = createRequire(import.meta.url)("node-html-parser");

const ROOT_DIR = process.cwd();
const ROOT_TITLE = decodeURIComponent(
  process.argv.find((arg) => arg.startsWith("--root="))?.slice("--root=".length) || "RESCENE"
).normalize("NFKC").trim();
const SHOULD_RENDER = process.argv.includes("--render");
const JSON_ONLY = process.argv.includes("--json");
const COMPAT_RENDERER = path.join(ROOT_DIR, "scripts", "namumark-thetree-compat-poc.mjs");
const EXPECTED_COMPAT_VERSION = String(process.env.KPOPARKIVE_EXPECTED_COMPAT_VERSION || "modern-namu-compat-v8");
const EXPECTED_ENGINE_PATCHSET = String(process.env.KPOPARKIVE_EXPECTED_ENGINE_PATCHSET || "modern-namu-v2");

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

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function countMatches(value, pattern) {
  return (String(value || "").match(pattern) || []).length;
}

function sourceFeatures(rawValue) {
  const raw = String(rawValue || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*##/.test(line))
    .join("\n");
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
    category: countMatches(raw, /\[\[(?:분류|Category):/gi),
  };
}

function renderedFeatures(htmlValue) {
  const html = String(htmlValue || "");
  let root;
  try {
    root = parseHtml(`<div id="kpoparkive-render-audit-root">${html}</div>`, { comment: false });
  } catch {
    return { tables: 0, details: 0, footnotes: 0, youtube: 0, headings: 0, parseError: true };
  }
  return {
    tables: root.querySelectorAll("table").length,
    details: root.querySelectorAll("details").length,
    footnotes: root.querySelectorAll(".wiki-fn-content").length,
    youtube: root.querySelectorAll('iframe[src*="youtube.com/embed/"],iframe[src*="youtube-nocookie.com/embed/"]').length,
    colspan: root.querySelectorAll("[colspan]").length,
    rowspan: root.querySelectorAll("[rowspan]").length,
    headings: root.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
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

function renderTitle(title) {
  const result = spawnSync(
    process.execPath,
    ["--no-node-snapshot", COMPAT_RENDERER, title],
    { cwd: ROOT_DIR, env: process.env, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`renderer failed for ${title} with exit code ${result.status}`);
}

async function loadScope() {
  const requirements = await db(
    "namu_raw_requirements?root_title=eq." + encodeURIComponent(ROOT_TITLE) +
      "&status=eq.captured&select=source_document_id,source_title,status,priority,score,reason_codes&order=source_title.asc"
  );
  if (!Array.isArray(requirements) || !requirements.length) {
    throw new Error(`No captured canonical core documents found for ${ROOT_TITLE}`);
  }

  const output = [];
  for (const requirement of requirements) {
    const rows = await db(
      "source_documents?id=eq." + encodeURIComponent(requirement.source_document_id) +
        "&select=id,source_title,source_wikitext,source_namumark_html,source_namumark_meta,source_namumark_engine,source_namumark_engine_version,source_namumark_rendered_at&limit=1"
    );
    output.push({ requirement, document: rows?.[0] || null });
  }
  return output;
}

function analyze(item) {
  const document = item.document || {};
  const raw = String(document.source_wikitext || "");
  const html = String(document.source_namumark_html || "");
  const meta = document.source_namumark_meta && typeof document.source_namumark_meta === "object"
    ? document.source_namumark_meta
    : {};
  const source = sourceFeatures(raw);
  const rendered = renderedFeatures(html);
  const leaks = scanCriticalSyntaxLeaks(html);
  const missingTemplates = listMeta(meta, "missingTemplates");
  const missingFiles = listMeta(meta, "missingFiles");
  const missingYouTube = listMeta(meta, "missingYouTubeEmbeds");
  const compatVersion = String(meta?.compatibility?.version || "");
  const enginePatchset = String(meta?.compatibility?.enginePatchset || meta?.enginePatchset || "");
  const staleEngine =
    compatVersion !== EXPECTED_COMPAT_VERSION ||
    enginePatchset !== EXPECTED_ENGINE_PATCHSET;
  const hasError = Boolean(meta.hasError) || rendered.parseError || !html;
  const leakCount = leaks.reduce((sum, entry) => sum + entry.count, 0);
  const structuralLoss = {
    folding: Math.max(0, source.folding - rendered.details),
    footnotes: Math.max(0, source.footnote - rendered.footnotes),
    youtube: Math.max(0, source.youtube - rendered.youtube),
    colspan: Math.max(0, source.colspan - rendered.colspan),
    rowspan: Math.max(0, source.rowspan - rendered.rowspan),
  };
  const structuralLossCount = Object.values(structuralLoss).reduce((sum, value) => sum + value, 0);
  const engineFailure =
    hasError ||
    leakCount > 0 ||
    missingYouTube.length > 0 ||
    structuralLossCount > 0;
  const dependencyGap = missingTemplates.length > 0 || missingFiles.length > 0;

  return {
    title: item.requirement.source_title,
    rawChars: raw.length,
    htmlChars: html.length,
    engine: document.source_namumark_engine || null,
    engineVersion: document.source_namumark_engine_version || null,
    compatVersion,
    enginePatchset,
    staleEngine,
    renderedAt: document.source_namumark_rendered_at || null,
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
    status: engineFailure ? "ENGINE_FAIL" : staleEngine ? "STALE_ENGINE" : dependencyGap ? "DEPENDENCY" : "OK",
  };
}

function matrixRows(report) {
  return report.documents.map((row) => ({
    Document: row.title,
    Status: row.status,
    Error: row.hasError ? 1 : 0,
    Patch: row.staleEngine ? `${row.compatVersion || "-"}/${row.enginePatchset || "-"}` : "current",
    Tables: row.rendered.tables,
    Folding: `${row.source.folding}/${row.rendered.details}`,
    Footnotes: `${row.source.footnote}/${row.rendered.footnotes}`,
    YouTube: `${row.source.youtube}/${row.rendered.youtube}`,
    Colspan: `${row.source.colspan}/${row.rendered.colspan}`,
    Rowspan: `${row.source.rowspan}/${row.rendered.rowspan}`,
    "Missing Tpl": row.missingTemplates.length,
    "Missing Files": row.missingFiles.length,
    Leaks: row.leakCount,
    Loss: row.structuralLossCount,
  }));
}

async function main() {
  let scope = await loadScope();
  const renderRunFailures = new Map();
  if (SHOULD_RENDER) {
    let index = 0;
    for (const item of scope) {
      index += 1;
      const currentTitle = item.requirement.source_title;
      console.log(`\n[${index}/${scope.length}] RENDER ${currentTitle}`);
      try {
        renderTitle(currentTitle);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        renderRunFailures.set(currentTitle, message);
        console.error(`RENDER PROCESS FAILED ${currentTitle}: ${message}`);
      }
    }
    scope = await loadScope();
  }

  const documents = scope.map(analyze).map((row) => {
    const renderRunError = renderRunFailures.get(row.title) || null;
    if (!renderRunError) return row;
    return {
      ...row,
      renderRunError,
      engineFailure: true,
      status: "ENGINE_FAIL",
    };
  });
  const report = {
    rootTitle: ROOT_TITLE,
    rendered: SHOULD_RENDER,
    generatedAt: new Date().toISOString(),
    total: documents.length,
    engineFailures: documents.filter((row) => row.engineFailure).length,
    staleEngines: documents.filter((row) => row.staleEngine).length,
    dependencyGaps: documents.filter((row) => row.dependencyGap).length,
    clean: documents.filter((row) => !row.engineFailure && !row.staleEngine && !row.dependencyGap).length,
    documents,
  };

  if (JSON_ONLY) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nKpoparkive The Tree failure matrix: ${ROOT_TITLE}`);
    console.table(matrixRows(report));
    console.log(
      `SUMMARY total=${report.total} engine-fail=${report.engineFailures} stale-engine=${report.staleEngines} dependency-gap=${report.dependencyGaps} clean=${report.clean}`
    );
    for (const row of documents.filter((item) => item.engineFailure)) {
      console.log(`\nENGINE FAIL ${row.title}`);
      if (row.hasError) console.log("  renderer hasError / missing render output");
      if (row.renderRunError) console.log(`  render process: ${row.renderRunError}`);
      if (row.missingYouTube.length) console.log(`  youtube missing: ${row.missingYouTube.join(" | ")}`);
      if (row.structuralLossCount > 0) {
        console.log(
          `  structural loss: folding=${row.structuralLoss.folding} footnotes=${row.structuralLoss.footnotes} youtube=${row.structuralLoss.youtube} colspan=${row.structuralLoss.colspan} rowspan=${row.structuralLoss.rowspan}`
        );
      }
      for (const leak of row.leaks) {
        console.log(`  leak ${leak.kind}: ${leak.count}`);
        for (const sample of leak.samples) console.log(`    - ${sample}`);
      }
    }
    const staleOnly = documents.filter((item) => !item.engineFailure && item.staleEngine);
    if (staleOnly.length) {
      console.log(`\nSTALE ENGINE (rerender required; expected ${EXPECTED_COMPAT_VERSION}/${EXPECTED_ENGINE_PATCHSET})`);
      for (const row of staleOnly) {
        console.log(`  ${row.title}: ${row.compatVersion || "-"} / ${row.enginePatchset || "-"}`);
      }
    }

    const dependencyOnly = documents.filter((item) => !item.engineFailure && item.dependencyGap);
    if (dependencyOnly.length) {
      console.log("\nDEPENDENCY-ONLY (owned by Template/Asset rooms)");
      for (const row of dependencyOnly) {
        console.log(
          `  ${row.title}: templates=${row.missingTemplates.length} files=${row.missingFiles.length}`
        );
      }
    }
  }

  if (report.engineFailures > 0 || report.staleEngines > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
