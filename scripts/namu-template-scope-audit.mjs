import fs from "node:fs";
import path from "node:path";

const ROOT_DIR = process.cwd();

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");

const rootTitle = String(process.argv.slice(2).join(" ") || "").normalize("NFKC").trim();
if (!rootTitle) throw new Error('Usage: npm run namu:template-audit -- "방탄소년단"');

async function db(pathname) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

function extractTemplateDependencies(rawValue) {
  const raw = String(rawValue || "").replace(/\r\n?/g, "\n");
  const lower = raw.toLowerCase();
  const output = [];
  const seen = new Set();
  let cursor = 0;

  while (cursor < raw.length) {
    const start = lower.indexOf("[include(", cursor);
    if (start < 0) break;

    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let i = start + 9; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "(") {
        depth += 1;
        continue;
      }
      if (ch === ")") {
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        if (raw[i + 1] === "]") {
          end = i;
          break;
        }
      }
      if (ch === "," && depth === 0 && comma < 0) comma = i;
    }

    if (end < 0) break;
    const nameEnd = comma >= 0 && comma < end ? comma : end;
    const title = raw.slice(start + 9, nameEnd)
      .normalize("NFKC")
      .replace(/\u00a0/g, " ")
      .replace(/^(틀|Template)\s*:\s*/i, "$1:")
      .replace(/[ \t]+/g, " ")
      .trim();

    if (
      /^틀:/i.test(title) &&
      !/\/설명문서(?:$|\/)/i.test(title) &&
      !/[{}\[\]]/.test(title) &&
      !seen.has(title)
    ) {
      seen.add(title);
      output.push(title);
    }
    cursor = end + 2;
  }

  return output;
}

function isCanonicalRaw(row) {
  return Boolean(
    row?.source_wikitext &&
    row?.raw_extracted_at &&
    row?.source_format === "namuwiki_raw" &&
    /^normal-chrome-(?:raw-view|edit-source)-v1$/.test(String(row?.source_extraction_version || ""))
  );
}

const COMPAT_BUILTINS = new Set([
  "틀:상위 문서",
  "틀:문서 가져옴",
  "틀:노래 세부사항",
  "틀:노래 세부사항2",
]);

const docs = await db(
  "source_documents?source=eq.namu_mirror" +
  "&root_title=eq." + encodeURIComponent(rootTitle) +
  "&source_title=not.like." + encodeURIComponent("틀:%") +
  "&source_wikitext=not.is.null" +
  "&select=id,source_title,source_wikitext,raw_extracted_at,source_format,source_extraction_version" +
  "&order=crawl_depth.asc,source_title.asc&limit=500"
);

const direct = new Map();
for (const doc of docs || []) {
  for (const templateTitle of extractTemplateDependencies(doc.source_wikitext)) {
    const item = direct.get(templateTitle) || { templateTitle, owners: new Set(), refs: 0 };
    item.owners.add(doc.source_title);
    item.refs += 1;
    direct.set(templateTitle, item);
  }
}

const templateRows = await db(
  "source_documents?source=eq.namu_mirror" +
  "&source_title=like." + encodeURIComponent("틀:%") +
  "&select=id,source_title,root_title,source_format,source_extraction_version,source_wikitext,raw_extracted_at,source_browser_captured_at" +
  "&limit=5000"
);

const bestCanonical = new Map();
const browserSeen = new Set();
for (const row of templateRows || []) {
  const title = String(row?.source_title || "").normalize("NFKC").trim();
  if (!title) continue;
  if (row?.source_browser_captured_at) browserSeen.add(title);
  if (!isCanonicalRaw(row)) continue;
  const current = bestCanonical.get(title);
  const currentAt = Date.parse(current?.raw_extracted_at || "") || 0;
  const candidateAt = Date.parse(row?.raw_extracted_at || "") || 0;
  if (!current || candidateAt > currentAt) bestCanonical.set(title, row);
}

const fallbackRows = await db(
  "template_dom_fallbacks?select=template_title,source_title,translation_status,source_html,en_html,recovery_status,recovery_version,recovery_meta&limit=5000"
);
const fallbackByTemplate = new Map();
for (const row of fallbackRows || []) {
  const title = String(row?.template_title || "").normalize("NFKC").trim();
  if (!title) continue;
  const list = fallbackByTemplate.get(title) || [];
  list.push(row);
  fallbackByTemplate.set(title, list);
}

const rows = [...direct.values()].map((item) => {
  const canonical = bestCanonical.get(item.templateTitle) || null;
  const fallbacks = fallbackByTemplate.get(item.templateTitle) || [];
  const reviewed = fallbacks.filter((row) =>
    row?.translation_status === "reviewed" &&
    typeof row?.en_html === "string" &&
    row.en_html.length > 0
  );
  const sourceHtml = fallbacks.filter((row) =>
    typeof row?.source_html === "string" &&
    row.source_html.length > 0
  );

  let resolution = "missing";
  if (canonical) resolution = "canonical_raw";
  else if (COMPAT_BUILTINS.has(item.templateTitle)) resolution = "compat_builtin";
  else if (reviewed.length > 0) resolution = "reviewed_dom_fallback";
  else if (sourceHtml.length > 0) resolution = "dom_fallback_pending";
  else if (browserSeen.has(item.templateTitle)) resolution = "browser_placeholder";

  return {
    templateTitle: item.templateTitle,
    owners: [...item.owners].sort(),
    ownerCount: item.owners.size,
    refs: item.refs,
    resolution,
    canonicalRoot: canonical?.root_title || null,
    fallbackRows: fallbacks.length,
    reviewedFallbackRows: reviewed.length,
  };
}).sort((a, b) => {
  const rank = {
    missing: 0,
    browser_placeholder: 1,
    dom_fallback_pending: 2,
    reviewed_dom_fallback: 3,
    compat_builtin: 4,
    canonical_raw: 5,
  };
  return (rank[a.resolution] - rank[b.resolution]) ||
    (b.ownerCount - a.ownerCount) ||
    a.templateTitle.localeCompare(b.templateTitle, "ko");
});

const counts = {};
for (const row of rows) counts[row.resolution] = (counts[row.resolution] || 0) + 1;

console.log(`Template scope audit · ${rootTitle}`);
console.log(`Core article RAW docs: ${docs.length}`);
console.log(`Direct templates only: ${rows.length}`);
console.log("Recursive template-of-template expansion: OFF");
console.log("");
for (const key of ["canonical_raw","compat_builtin","reviewed_dom_fallback","dom_fallback_pending","browser_placeholder","missing"]) {
  console.log(`${key}: ${counts[key] || 0}`);
}

console.log("");
for (const row of rows) {
  if (row.resolution === "canonical_raw") continue;
  console.log(
    `[${row.resolution}] ${row.templateTitle} · owners=${row.ownerCount} · fallback=${row.reviewedFallbackRows}/${row.fallbackRows}`
  );
  if (row.owners.length <= 8) console.log(`  ${row.owners.join(" · ")}`);
}
