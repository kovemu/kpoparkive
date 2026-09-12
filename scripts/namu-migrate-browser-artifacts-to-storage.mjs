import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

const ROOT_DIR = process.cwd();
const BUCKET = process.env.KPOPARKIVE_BROWSER_ARTIFACT_BUCKET || "wiki-browser-artifacts";

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

function arg(name, fallback) {
  const prefix = "--" + name + "=";
  const inline = process.argv.find((item) => item.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf("--" + name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const rootFilter = String(arg("root", "")).normalize("NFKC").trim();
const maxDocs = Math.max(1, Number(arg("limit", "5000")) || 5000);

function headers(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + pathname, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
  });
  const body = await response.text();
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + body);
  return body ? JSON.parse(body) : null;
}

function encodedStoragePath(value) {
  return String(value || "").split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function upload(storagePath, bytes) {
  const response = await fetch(
    SUPABASE_URL + "/storage/v1/object/" + encodeURIComponent(BUCKET) + "/" + encodedStoragePath(storagePath),
    {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: "Bearer " + SERVICE_ROLE_KEY,
        "Content-Type": "application/gzip",
        "Cache-Control": "31536000, immutable",
        "x-upsert": "true",
      },
      body: bytes,
    },
  );
  if (!response.ok) throw new Error("storage upload " + response.status + ": " + await response.text());
}

function artifactPath(docId, kind, hash) {
  return "browser-artifacts/" + docId + "/" + hash + "." + kind + ".gz";
}

async function listCandidates() {
  let pathname =
    "source_documents?source=eq.namu_mirror" +
    "&or=(source_browser_article_html.not.is.null,source_browser_style_css.not.is.null)" +
    "&select=id,source_title,root_title,source_browser_capture_meta,source_browser_captured_at" +
    "&order=source_browser_captured_at.desc.nullslast" +
    "&limit=" + maxDocs;
  if (rootFilter) pathname += "&root_title=eq." + encodeURIComponent(rootFilter);
  return (await db(pathname)) || [];
}

async function migrate(row, index, total) {
  const docs = await db(
    "source_documents?id=eq." + encodeURIComponent(row.id) +
    "&select=id,source_title,source_browser_article_html,source_browser_style_css,source_browser_capture_meta&limit=1",
  );
  const doc = docs && docs[0];
  if (!doc) return { skipped: true };

  const html = String(doc.source_browser_article_html || "");
  const css = String(doc.source_browser_style_css || "");
  if (!html && !css) return { skipped: true };

  const oldStorage = doc.source_browser_capture_meta && doc.source_browser_capture_meta.artifact_storage || {};
  let articlePath = String(oldStorage.article_path || "") || null;
  let articleHash = String(oldStorage.article_sha256 || "") || null;
  let articleStoredBytes = Number(oldStorage.article_stored_bytes || 0) || 0;
  let stylePath = String(oldStorage.style_path || "") || null;
  let styleHash = String(oldStorage.style_sha256 || "") || null;
  let styleStoredBytes = Number(oldStorage.style_stored_bytes || 0) || 0;

  if (html) {
    const bytes = Buffer.from(html, "utf8");
    articleHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const gz = gzipSync(bytes, { level: 6 });
    articlePath = artifactPath(doc.id, "html", articleHash);
    articleStoredBytes = gz.length;
    await upload(articlePath, gz);
  }

  if (css) {
    const bytes = Buffer.from(css, "utf8");
    styleHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const gz = gzipSync(bytes, { level: 6 });
    stylePath = artifactPath(doc.id, "css", styleHash);
    styleStoredBytes = gz.length;
    await upload(stylePath, gz);
  }

  const meta = {
    ...(doc.source_browser_capture_meta || {}),
    artifact_storage: {
      version: "browser-artifact-storage-v1",
      bucket: BUCKET,
      encoding: "gzip",
      article_path: articlePath,
      article_sha256: articleHash,
      article_stored_bytes: articleStoredBytes,
      style_path: stylePath,
      style_sha256: styleHash,
      style_stored_bytes: styleStoredBytes,
      migrated_at: new Date().toISOString(),
    },
  };

  await db("source_documents?id=eq." + encodeURIComponent(doc.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_browser_article_html: null,
      source_browser_style_css: null,
      source_browser_capture_meta: meta,
      updated_at: new Date().toISOString(),
    }),
  });

  const original = Buffer.byteLength(html, "utf8") + Buffer.byteLength(css, "utf8");
  const stored = articleStoredBytes + styleStoredBytes;
  console.log(
    "[" + index + "/" + total + "] " + doc.source_title + ": " +
    (original / 1024 / 1024).toFixed(2) + " MB DB -> " +
    (stored / 1024 / 1024).toFixed(2) + " MB Storage gzip",
  );
  return { skipped: false, original, stored };
}

const rows = await listCandidates();
console.log("Kpoparkive browser artifact migration: " + rows.length + " document(s)" + (rootFilter ? " under " + rootFilter : ""));

let migrated = 0;
let skipped = 0;
let failed = 0;
let originalBytes = 0;
let storedBytes = 0;

for (let i = 0; i < rows.length; i += 1) {
  try {
    const result = await migrate(rows[i], i + 1, rows.length);
    if (result.skipped) skipped += 1;
    else {
      migrated += 1;
      originalBytes += result.original || 0;
      storedBytes += result.stored || 0;
    }
  } catch (error) {
    failed += 1;
    console.error("[" + (i + 1) + "/" + rows.length + "] FAILED " + (rows[i].source_title || rows[i].id) + ": " + (error?.message || error));
  }
}

console.log("");
console.log(
  "MIGRATION COMPLETE migrated=" + migrated +
  " skipped=" + skipped +
  " failed=" + failed +
  " DB payload " + (originalBytes / 1024 / 1024).toFixed(1) + " MB" +
  " -> Storage gzip " + (storedBytes / 1024 / 1024).toFixed(1) + " MB",
);
if (failed) process.exitCode = 1;
