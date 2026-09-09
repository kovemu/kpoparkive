import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const VERSION = "0.1.1";
const ENGINE_NAME = "shapelayer-namumark-preexpanded-poc";
const CACHE_DIR = path.resolve(".cache", "shapelayer-namumark", VERSION);
const DOWNLOAD_URL = `https://github.com/ShapeLayer/namumark/releases/download/${VERSION}/namumark-windows-x86_64-${VERSION}.zip`;
const title = decodeURIComponent(process.argv[2] || "RESCENE").normalize("NFKC").trim();

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

loadEnv(path.resolve(".env.local"));
loadEnv(path.resolve(".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");
if (process.platform !== "win32") throw new Error("This first ShapeLayer POC currently targets the Windows x86_64 release used by the local Kpoparkive workstation.");

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else out.push(full);
  }
  return out;
}

async function ensureEngine() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const existing = walkFiles(CACHE_DIR).find((file) => /namumark\.exe$/i.test(file));
  if (existing) return existing;

  const zipPath = path.join(CACHE_DIR, `namumark-${VERSION}.zip`);
  console.log(`Downloading ShapeLayer namumark ${VERSION}...`);
  const response = await fetch(DOWNLOAD_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`ShapeLayer download failed: ${response.status}`);
  fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()));

  const extractDir = path.join(CACHE_DIR, "bin");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const ps = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`],
    { stdio: "inherit", env: process.env },
  );
  if (ps.error) throw ps.error;
  if (ps.status !== 0) throw new Error(`Expand-Archive failed with exit code ${ps.status}`);

  const exe = walkFiles(extractDir).find((file) => /namumark\.exe$/i.test(file));
  if (!exe) throw new Error("ShapeLayer release archive did not contain namumark.exe");
  return exe;
}

function normalizeTitle(value) {
  return String(value || "").normalize("NFKC").trim();
}

function shouldSkipTemplate(value) {
  const name = normalizeTitle(value);
  if (!/^틀:/i.test(name)) return false;
  if (/[\n\r{}]/.test(name) || name.length > 120) return true;
  return /^틀:(?:접근 제한|설명문서|문서 가져옴|토론 관련 틀|토론 합의(?:\/설명문서)?|다른 뜻|분류 설명|분류 참고|한시적 넘겨주기|상위 문서|하위 문서|관련 문서)$/i.test(name);
}

function splitTopLevel(value) {
  const out = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "(") depth += 1;
    else if (ch === ")" && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function findInclude(raw, from = 0) {
  const lower = raw.toLowerCase();
  const start = lower.indexOf("[include(", from);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start + 9; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth > 0) depth -= 1;
      else if (raw[i + 1] === "]") {
        return { start, end: i + 2, body: raw.slice(start + 9, i) };
      }
    }
  }
  return null;
}

function parseInclude(body) {
  const parts = splitTopLevel(body).map((v) => v.trim());
  const sourceTitle = normalizeTitle(parts.shift());
  const params = new Map();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key) params.set(key, value);
  }
  return { sourceTitle, params };
}

function applyIncludeParams(raw, params) {
  let out = String(raw || "");
  out = out.replace(/@([ㄱ-힣A-Za-z0-9_]+)=([^@\n]*)@/g, (_m, key, fallback) => params.has(key) ? params.get(key) : fallback);
  out = out.replace(/@([ㄱ-힣A-Za-z0-9_]+)@/g, (_m, key) => params.get(key) ?? "");
  return out;
}

function expandIncludes(rootRaw, rawByTitle, options = {}) {
  const maxDepth = Number(options.maxDepth || 8);
  const maxExpansions = Number(options.maxExpansions || 300);
  const unresolved = new Set();
  const skipped = new Set();
  const expanded = new Set();
  let expansionCount = 0;

  function visit(raw, depth, stack) {
    let out = String(raw || "");
    let cursor = 0;
    while (expansionCount < maxExpansions) {
      const hit = findInclude(out, cursor);
      if (!hit) break;
      const parsed = parseInclude(hit.body);
      const name = parsed.sourceTitle;
      let replacement = "";

      if (!name) {
        replacement = "";
      } else if (shouldSkipTemplate(name)) {
        skipped.add(name);
      } else if (depth >= maxDepth || stack.has(name)) {
        unresolved.add(name);
      } else {
        const templateRaw = rawByTitle.get(name);
        if (!templateRaw) {
          unresolved.add(name);
        } else {
          expansionCount += 1;
          expanded.add(name);
          const nextStack = new Set(stack);
          nextStack.add(name);
          replacement = visit(applyIncludeParams(templateRaw, parsed.params), depth + 1, nextStack);
        }
      }

      out = out.slice(0, hit.start) + replacement + out.slice(hit.end);
      cursor = hit.start + replacement.length;
    }
    return out;
  }

  return {
    raw: visit(rootRaw, 0, new Set()),
    unresolved: [...unresolved],
    skipped: [...skipped],
    expanded: [...expanded],
    expansionCount,
  };
}

function renderWithEngine(exe, inputPath) {
  const result = spawnSync(exe, ["--html", inputPath], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`ShapeLayer namumark failed (${result.status}): ${String(result.stderr || "").trim()}`);
  const html = String(result.stdout || "");
  if (html.length < 100) throw new Error(`ShapeLayer namumark returned only ${html.length} chars of HTML`);
  return html;
}

async function main() {
  const exe = await ensureEngine();
  const rows = await db("source_documents?source=eq.namu_mirror&source_wikitext=not.is.null&select=id,source_title,source_wikitext&limit=5000");
  const target = (rows || []).find((row) => normalizeTitle(row.source_title) === title);
  if (!target?.id || !target?.source_wikitext) throw new Error(`No captured source_wikitext for ${title}`);

  const rawByTitle = new Map((rows || []).filter((row) => row?.source_title && row?.source_wikitext).map((row) => [normalizeTitle(row.source_title), String(row.source_wikitext)]));
  const expanded = expandIncludes(String(target.source_wikitext), rawByTitle);
  const inputPath = path.join(CACHE_DIR, `${encodeURIComponent(title)}-expanded.namu`);
  fs.writeFileSync(inputPath, expanded.raw, "utf8");

  const started = performance.now();
  const html = renderWithEngine(exe, inputPath);
  const elapsed = Math.round(performance.now() - started);
  const renderedAt = new Date().toISOString();
  const meta = {
    purpose: "raw-source architecture POC using current ShapeLayer parser",
    engineRepo: "https://github.com/ShapeLayer/namumark",
    engineRelease: VERSION,
    rawChars: String(target.source_wikitext).length,
    expandedRawChars: expanded.raw.length,
    htmlChars: html.length,
    renderMs: elapsed,
    templateExpansions: expanded.expansionCount,
    expandedTemplates: expanded.expanded,
    skippedMetaTemplates: expanded.skipped,
    unresolvedIncludes: expanded.unresolved,
    renderedAt,
  };

  await db(`source_documents?id=eq.${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_namumark_html: html,
      source_namumark_js: null,
      source_namumark_meta: meta,
      source_namumark_engine: ENGINE_NAME,
      source_namumark_engine_version: VERSION,
      source_namumark_rendered_at: renderedAt,
      updated_at: renderedAt,
    }),
  });

  console.log(`SHAPELAYER NAMUMARK POC SAVED ${title}`);
  console.log(`raw=${meta.rawChars} expanded=${meta.expandedRawChars} html=${meta.htmlChars} render=${elapsed}ms`);
  console.log(`template-expansions=${expanded.expansionCount} skipped-meta=${expanded.skipped.length} unresolved=${expanded.unresolved.length}`);
  for (const name of expanded.unresolved.slice(0, 30)) console.log(`  unresolved: ${name}`);
  console.log(`Preview: https://kpoparkive.vercel.app/admin/namumark-poc/${encodeURIComponent(title)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
