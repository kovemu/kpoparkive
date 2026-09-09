import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { MessageChannel } from "node:worker_threads";

const ROOT_DIR = process.cwd();
const THETREE_REPO = "https://github.com/wjdgustn/thetree.git";
const THETREE_COMMIT = "7435e93e4d695e666aee5eddbabf68533f7b7b21";
const ENGINE_NAME = "thetree-unmodified-render-poc";
const CACHE_DIR = path.resolve(ROOT_DIR, ".cache", "thetree-render-poc");
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

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function run(command, args, cwd = ROOT_DIR) {
  let executable = command;
  let finalArgs = args;
  if (process.platform === "win32" && ["npm", "npx"].includes(command)) {
    executable = process.env.ComSpec || "cmd.exe";
    finalArgs = ["/d", "/s", "/c", `${command}.cmd ${args.map(quoteWindowsCmdArg).join(" ")}`];
  }
  const result = spawnSync(executable, finalArgs, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function ensureEngine() {
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (!fs.existsSync(path.join(CACHE_DIR, ".git"))) {
    run("git", ["clone", "--no-checkout", THETREE_REPO, CACHE_DIR]);
  }
  run("git", ["fetch", "--depth", "1", "origin", THETREE_COMMIT], CACHE_DIR);
  run("git", ["checkout", "--detach", "--force", THETREE_COMMIT], CACHE_DIR);

  if (!fs.existsSync(path.join(CACHE_DIR, "node_modules", "piscina"))) {
    console.log("Installing The Tree dependencies in .cache (first run only)...");
    run("npm", ["ci", "--no-audit", "--no-fund"], CACHE_DIR);
  }
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

const config = {
  lang: "ko",
  namespaces: ["문서", "사용자", "파일", "틀", "분류", "나무위키", "특수기능", "휴지통", "투표"],
  localNamespaces: null,
  document_maximum_time: 30000,
};

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseDocumentName(value) {
  const full = normalizeTitle(value).slice(0, 255);
  const colon = full.indexOf(":");
  if (colon > 0) {
    const maybeNamespace = full.slice(0, colon);
    if (config.namespaces.includes(maybeNamespace)) {
      return { namespace: maybeNamespace, title: full.slice(colon + 1) };
    }
  }
  return { namespace: "문서", title: full };
}

function fullTitle(doc) {
  return doc.namespace === "문서" ? doc.title : `${doc.namespace}:${doc.title}`;
}

function stableUuid(value) {
  const hex = crypto.createHash("sha256").update(String(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function comparable(value) {
  return typeof value === "string" ? normalizeTitle(value) : value;
}

function equalComparable(left, right) {
  return comparable(left) === comparable(right);
}

function mongoMatch(value, condition) {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    if (Array.isArray(condition.$in)) return condition.$in.some((candidate) => equalComparable(value, candidate));
    if (Object.prototype.hasOwnProperty.call(condition, "$eq")) return equalComparable(value, condition.$eq);
  }
  return equalComparable(value, condition);
}

function documentMatches(doc, query) {
  if (!query || !Object.keys(query).length) return true;
  if (Array.isArray(query.$or) && !query.$or.some((part) => documentMatches(doc, part))) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") continue;
    if (!mongoMatch(doc[key], condition)) return false;
  }
  return true;
}

function historyMatches(rev, query) {
  if (!query || !Object.keys(query).length) return true;
  if (Array.isArray(query.$or) && !query.$or.some((part) => historyMatches(rev, part))) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") continue;
    if (!mongoMatch(rev[key], condition)) return false;
  }
  return true;
}

function assetName(ref) {
  return normalizeTitle(ref).replace(/^(?:파일|File):/i, "");
}

function assetUrl(row) {
  if (typeof row.resolved_url === "string" && row.resolved_url) return row.resolved_url;
  if (typeof row.metadata?.enrichment_url === "string" && row.metadata.enrichment_url) return row.metadata.enrichment_url;
  return null;
}

function numberFromMeta(row, ...keys) {
  for (const key of keys) {
    const value = Number(row.metadata?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

function makeVirtualWiki(rawRows, assetRows) {
  const docs = [];
  const histories = [];
  const byFullTitle = new Map();

  const ensureDoc = (name) => {
    const parsed = parseDocumentName(name);
    const key = fullTitle(parsed);
    if (byFullTitle.has(key)) return byFullTitle.get(key);
    const doc = {
      uuid: stableUuid(`doc:${key}`),
      namespace: parsed.namespace,
      title: parsed.title,
      contentExists: false,
      lastReadACL: 0,
      backlinks: [],
      categories: [],
    };
    docs.push(doc);
    byFullTitle.set(key, doc);
    return doc;
  };

  for (const row of rawRows || []) {
    if (!row?.source_title || !row?.source_wikitext) continue;
    const doc = ensureDoc(row.source_title);
    doc.contentExists = true;
    histories.push({
      uuid: stableUuid(`rev:${fullTitle(doc)}:1`),
      document: doc.uuid,
      namespace: doc.namespace,
      rev: 1,
      content: String(row.source_wikitext),
      fileKey: null,
      videoFileKey: null,
      fileWidth: 1,
      fileHeight: 1,
      fileSize: 0,
    });
  }

  for (const row of assetRows || []) {
    const name = assetName(row?.source_ref || row?.label || "");
    const url = assetUrl(row);
    if (!name || !url) continue;
    const doc = ensureDoc(`파일:${name}`);
    doc.contentExists = true;
    let rev = histories.find((item) => item.document === doc.uuid);
    if (!rev) {
      rev = {
        uuid: stableUuid(`rev:${fullTitle(doc)}:1`),
        document: doc.uuid,
        namespace: doc.namespace,
        rev: 1,
        content: "",
        videoFileKey: null,
      };
      histories.push(rev);
    }
    rev.fileKey = url;
    rev.fileWidth = numberFromMeta(row, "width", "naturalWidth", "image_width");
    rev.fileHeight = numberFromMeta(row, "height", "naturalHeight", "image_height");
    rev.fileSize = Number(row.metadata?.size || row.metadata?.bytes || 0) || 0;
  }

  return { docs, histories, byFullTitle };
}

function translation(key) {
  const known = {
    "namumark.toc_title": "목차",
    "namumark.heading_edit": "편집",
  };
  return known[key] || key;
}

function uniqueNormalizedStrings(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeTitle(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function hasRenderableFile(virtualWiki, name) {
  const parsed = parseDocumentName(/^파일:/i.test(name) ? name : `파일:${name}`);
  const doc = virtualWiki.byFullTitle.get(fullTitle(parsed));
  if (!doc) return false;
  return virtualWiki.histories.some((rev) => rev.document === doc.uuid && Boolean(rev.fileKey || rev.videoFileKey));
}

async function main() {
  ensureEngine();

  const rawRows = await db("source_documents?source=eq.namu_mirror&source_wikitext=not.is.null&select=id,source_title,root_title,source_wikitext&limit=5000");
  const target = (rawRows || []).find((row) => normalizeTitle(row.source_title) === normalizeTitle(title));
  if (!target?.id || !target?.source_wikitext) throw new Error(`No captured source_wikitext for ${title}`);

  const assetRows = await db(
    `source_asset_queue?root_title=eq.${encodeURIComponent(target.root_title || title)}&asset_type=eq.image` +
      "&select=source_ref,label,status,resolved_url,storage_path,metadata&limit=5000",
  );

  const virtualWiki = makeVirtualWiki(rawRows || [], assetRows || []);
  const targetDoc = virtualWiki.byFullTitle.get(fullTitle(parseDocumentName(title)));
  const targetRev = virtualWiki.histories.find((item) => item.document === targetDoc?.uuid);
  if (!targetDoc || !targetRev) throw new Error(`Virtual The Tree document was not built for ${title}`);

  process.chdir(CACHE_DIR);
  global.config = config;
  global.plugins = { macro: [] };
  process.env.S3_PUBLIC_HOST = process.env.S3_PUBLIC_HOST || "https://invalid.local/";
  process.env.S3_PUBLIC_HOST_PREFIX = "";

  const requireFromTree = createRequire(path.join(CACHE_DIR, "package.json"));
  const parser = requireFromTree("./utils/namumark/parser");
  const Piscina = requireFromTree("piscina");
  const workerPath = requireFromTree.resolve("./utils/namumark/toHtmlWorker");

  const parsed = parser(String(target.source_wikitext));
  const pool = new Piscina({
    filename: workerPath,
    workerData: { config, macroPluginPaths: [] },
    minThreads: 1,
    maxThreads: 1,
  });

  const channel = new MessageChannel();
  channel.port2.on("message", (msg) => {
    const reply = (result) => channel.port2.postMessage({ id: msg.id, result });
    try {
      if (msg.type === "db") {
        const query = msg.data || {};
        if (msg.model === "Document") {
          let result = virtualWiki.docs.filter((doc) => documentMatches(doc, query));
          if (msg.action === "countDocuments") return reply(result.length);
          return reply(result);
        }
        if (msg.model === "History") {
          let result = virtualWiki.histories.filter((rev) => historyMatches(rev, query));
          if (msg.sort?.rev) result = result.sort((a, b) => msg.sort.rev < 0 ? b.rev - a.rev : a.rev - b.rev);
          return reply(result);
        }
        return reply(msg.action === "countDocuments" ? 0 : []);
      }
      if (msg.type === "aclCheck") return reply({ result: true });
      if (msg.type === "t") return reply(translation(msg.key));
      return reply(null);
    } catch (error) {
      console.warn("The Tree virtual parent action failed:", error?.message || String(error));
      return reply(null);
    }
  });

  const options = {
    document: { namespace: targetDoc.namespace, title: targetDoc.title },
    originalDocument: { namespace: targetDoc.namespace, title: targetDoc.title },
    dbDocument: targetDoc,
    rev: targetRev,
    aclData: {},
    config,
    port: channel.port1,
    isInternal: false,
  };

  const started = performance.now();
  let result;
  try {
    result = await pool.run([parsed, options], { transferList: [channel.port1] });
  } finally {
    await pool.destroy();
    channel.port2.close();
  }
  const elapsed = Math.round(performance.now() - started);
  const html = String(result?.html || "");
  if (html.length < 100) throw new Error(`The Tree returned only ${html.length} chars of HTML`);

  const requiredFiles = uniqueNormalizedStrings(Array.isArray(result?.files) ? result.files : []);
  const missingFiles = requiredFiles.filter((file) => !hasRenderableFile(virtualWiki, file));
  const renderedAt = new Date().toISOString();
  const meta = {
    purpose: "raw-source architecture POC using unmodified The Tree renderer",
    engineRepo: THETREE_REPO,
    engineCommit: THETREE_COMMIT,
    rawChars: String(target.source_wikitext).length,
    htmlChars: html.length,
    renderMs: elapsed,
    hasError: Boolean(result?.hasError),
    errorCode: result?.errorCode || null,
    links: Array.isArray(result?.links) ? result.links.length : 0,
    files: requiredFiles.length,
    requiredFiles,
    missingFiles,
    missingFileCount: missingFiles.length,
    categories: Array.isArray(result?.categories) ? result.categories.length : 0,
    headings: Array.isArray(result?.headings) ? result.headings.length : 0,
    virtualDocuments: virtualWiki.docs.length,
    virtualRevisions: virtualWiki.histories.length,
    capturedRawDocuments: (rawRows || []).filter((row) => row?.source_wikitext).length,
    capturedAssets: (assetRows || []).filter((row) => assetUrl(row)).length,
    renderedAt,
  };

  process.chdir(ROOT_DIR);
  await db(`source_documents?id=eq.${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_namumark_html: html,
      source_namumark_js: null,
      source_namumark_meta: meta,
      source_namumark_engine: ENGINE_NAME,
      source_namumark_engine_version: THETREE_COMMIT,
      source_namumark_rendered_at: renderedAt,
      updated_at: renderedAt,
    }),
  });

  console.log(`THE TREE POC SAVED ${title}`);
  console.log(`raw=${meta.rawChars} html=${meta.htmlChars} render=${meta.renderMs}ms hasError=${meta.hasError}`);
  console.log(`raw-docs=${meta.capturedRawDocuments} assets=${meta.capturedAssets} virtual-docs=${meta.virtualDocuments}`);
  console.log(`links=${meta.links} files=${meta.files} missing-files=${meta.missingFileCount} categories=${meta.categories} headings=${meta.headings}`);
  if (missingFiles.length) console.log(`missing: ${missingFiles.slice(0, 30).join(" | ")}${missingFiles.length > 30 ? ` | +${missingFiles.length - 30} more` : ""}`);
  console.log(`Preview: https://kpoparkive.vercel.app/admin/namumark-poc/${encodeURIComponent(title)}`);
  console.log(`Frontend baseline: https://kpoparkive.vercel.app/admin/thetree-frontend-poc/${encodeURIComponent(title)}`);
}

main().catch((error) => {
  try { process.chdir(ROOT_DIR); } catch {}
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});