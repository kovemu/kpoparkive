import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ENGINE_REPO = "https://github.com/jhk1090/namumark-clone-core.git";
const ENGINE_COMMIT = "94d0ddfbf35e5791096b3c86ebd9c869471abb13";
const ENGINE_NAME = "namumark-clone-core-poc";
const CACHE_DIR = path.resolve(".cache", "namumark-clone-core");
const ROOT_TSC = path.resolve("node_modules", "typescript", "bin", "tsc");

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

const title = decodeURIComponent(process.argv[2] || "RESCENE").normalize("NFKC").trim();

function run(command, args, cwd = process.cwd()) {
  let executable = command;
  let finalArgs = args;

  // Node 24 on Windows can throw EINVAL when spawnSync receives a .cmd file
  // directly. Route npm/npx through the user's normal cmd.exe instead.
  if (process.platform === "win32" && ["npm", "npx"].includes(command)) {
    executable = process.env.ComSpec || "cmd.exe";
    finalArgs = ["/d", "/s", "/c", `${command}.cmd ${args.map(quoteWindowsCmdArg).join(" ")}`];
  }

  const result = spawnSync(executable, finalArgs, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function ensureEngine() {
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (!fs.existsSync(path.join(CACHE_DIR, ".git"))) run("git", ["clone", "--no-checkout", ENGINE_REPO, CACHE_DIR]);
  run("git", ["fetch", "--depth", "1", "origin", ENGINE_COMMIT], CACHE_DIR);
  run("git", ["checkout", "--detach", "--force", ENGINE_COMMIT], CACHE_DIR);

  if (!fs.existsSync(path.join(CACHE_DIR, "node_modules"))) {
    run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], CACHE_DIR);
  }

  // Compile with the TypeScript already installed by kpoparkive instead of
  // invoking npx (which is both slower and another Windows .cmd boundary).
  if (!fs.existsSync(ROOT_TSC)) {
    throw new Error(`Kpoparkive TypeScript compiler is missing: ${ROOT_TSC}. Run npm.cmd install once in the project root.`);
  }
  run(process.execPath, [ROOT_TSC, "--project", path.join(CACHE_DIR, "tsconfig.json"), "--pretty", "false"], process.cwd());

  const indexPath = path.join(CACHE_DIR, "out", "index.js");
  if (!fs.existsSync(indexPath)) throw new Error(`Engine build did not create ${indexPath}`);
  return indexPath;
}

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

function includeNames(raw) {
  const names = [];
  const seen = new Set();
  const regex = /\[include\(\s*([^,\)\]]+)/gi;
  let match;
  while ((match = regex.exec(raw)) !== null) {
    const name = String(match[1] || "").normalize("NFKC").trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

async function main() {
  const engineIndex = ensureEngine();
  const require = createRequire(import.meta.url);
  const { NamuMark } = require(engineIndex);
  if (typeof NamuMark !== "function") throw new Error("Compiled engine does not export NamuMark");

  const rows = await db("source_documents?source=eq.namu_mirror&source_wikitext=not.is.null&select=id,source_title,source_wikitext&limit=5000");
  const target = (rows || []).find((row) => String(row.source_title || "").normalize("NFKC") === title);
  if (!target?.id || !target?.source_wikitext) throw new Error(`No captured source_wikitext for ${title}`);

  const database = {
    data: (rows || []).filter((row) => row?.source_title && row?.source_wikitext).map((row) => ({
      title: String(row.source_title).normalize("NFKC").trim(),
      data: String(row.source_wikitext),
    })),
  };
  const available = new Set(database.data.map((item) => item.title));
  const includes = includeNames(String(target.source_wikitext));
  const unresolved = includes.filter((name) => !available.has(name));

  const started = performance.now();
  const result = new NamuMark(String(target.source_wikitext), {
    docName: title,
    useIncludeLink: "use",
    useTableScroll: "on",
    useCategorySet: "bottom",
    useFootnoteSet: "normal",
  }, database).parse();
  const elapsed = Math.round(performance.now() - started);
  const html = String(result?.[0] || "");
  const js = String(result?.[1] || "");
  if (html.length < 100) throw new Error(`Engine returned only ${html.length} chars of HTML`);

  const renderedAt = new Date().toISOString();
  const meta = {
    purpose: "raw-source architecture POC only",
    engineRepo: ENGINE_REPO,
    engineCommit: ENGINE_COMMIT,
    rawChars: String(target.source_wikitext).length,
    htmlChars: html.length,
    jsChars: js.length,
    renderMs: elapsed,
    availableRawDocuments: database.data.length,
    includeNames: includes,
    unresolvedIncludes: unresolved,
    renderedAt,
  };

  await db(`source_documents?id=eq.${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_namumark_html: html,
      source_namumark_js: js || null,
      source_namumark_meta: meta,
      source_namumark_engine: ENGINE_NAME,
      source_namumark_engine_version: ENGINE_COMMIT,
      source_namumark_rendered_at: renderedAt,
      updated_at: renderedAt,
    }),
  });

  console.log(`NAMUMARK POC SAVED ${title}`);
  console.log(`raw=${meta.rawChars} html=${meta.htmlChars} js=${meta.jsChars} render=${elapsed}ms`);
  console.log(`includes=${includes.length} unresolved=${unresolved.length}`);
  for (const name of unresolved.slice(0, 30)) console.log(`  unresolved: ${name}`);
  console.log(`Preview: https://kpoparkive.vercel.app/admin/namumark-poc/${encodeURIComponent(title)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
