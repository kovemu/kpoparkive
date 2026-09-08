import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.NAMU_CAPTURE_PORT || 43117) || 43117;
const ASSET_WORKER_PORT = PORT + 1;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;
const DOCUMENT_CAPTURE_VERSION = "chrome-rendered-artifact-v2";

function loadEnvFile(filePath) {
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

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_HOST = (() => {
  try { return new URL(SUPABASE_URL).host; } catch { return SUPABASE_URL; }
})();

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is missing in .env.local");
  process.exit(1);
}

function dbHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: { ...dbHeaders(), ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Kpoparkive-Meta",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validateNamuPageUrl(value) {
  const url = new URL(String(value || ""));
  if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) throw new Error("capture page is not namu.wiki");
  if (!/^\/w\//.test(url.pathname)) throw new Error("capture page is not a NamuWiki document");
  return url.toString();
}

const stats = {
  documentsSaved: 0,
  documentErrors: 0,
  proxiedAssets: 0,
  proxyErrors: 0,
};

async function saveRenderedDocument(payload) {
  const rootTitle = String(payload?.rootTitle || "").normalize("NFKC").trim();
  const sourceTitle = String(payload?.sourceTitle || "").normalize("NFKC").trim();
  const articleHtml = String(payload?.articleHtml || "");
  const styleCss = String(payload?.styleCss || "");
  const pageUrl = validateNamuPageUrl(payload?.pageUrl);
  const captureVersion = String(payload?.captureVersion || DOCUMENT_CAPTURE_VERSION).trim() || DOCUMENT_CAPTURE_VERSION;

  if (!rootTitle || !sourceTitle) throw new Error("document capture is missing rootTitle/sourceTitle");
  if (articleHtml.length < 200) throw new Error("rendered article HTML is unexpectedly small");
  if (!/<(?:article|main)\b/i.test(articleHtml)) throw new Error("rendered capture does not contain an article/main root");
  if (captureVersion !== DOCUMENT_CAPTURE_VERSION) throw new Error(`capture version mismatch: expected ${DOCUMENT_CAPTURE_VERSION}, got ${captureVersion}`);

  const docs = await db(
    `source_documents?source=eq.namu_mirror` +
    `&root_title=eq.${encodeURIComponent(rootTitle)}` +
    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +
    `&select=id,source_title,root_title&limit=1`,
  );
  const doc = docs?.[0];
  if (!doc?.id) throw new Error(`No imported source_document matched ${rootTitle} / ${sourceTitle}. Import the document cluster first.`);

  const capturedAt = new Date().toISOString();
  const articleBytes = Buffer.byteLength(articleHtml, "utf8");
  const styleBytes = Buffer.byteLength(styleCss, "utf8");
  const meta = {
    ...(payload?.meta && typeof payload.meta === "object" ? payload.meta : {}),
    page_url: pageUrl,
    page_title: String(payload?.pageTitle || ""),
    article_bytes: articleBytes,
    style_bytes: styleBytes,
    captured_by: "normal-chrome-extension",
    presentation_mode: "final-dom-plus-computed-layout",
  };

  await db(`source_documents?id=eq.${encodeURIComponent(doc.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_browser_article_html: articleHtml,
      source_browser_style_css: styleCss || null,
      source_browser_capture_meta: meta,
      source_browser_capture_version: captureVersion,
      source_browser_captured_at: capturedAt,
    }),
  });

  stats.documentsSaved += 1;
  console.log(`BROWSER ARTIFACT SAVED ${sourceTitle} -> HTML ${(articleBytes / 1024).toFixed(1)} KB + CSS ${(styleBytes / 1024).toFixed(1)} KB`);
  return {
    ok: true,
    status: "saved",
    sourceTitle,
    rootTitle,
    captureVersion,
    capturedAt,
    articleBytes,
    styleBytes,
    nodeCount: Number(meta.nodeCount || 0),
    styledNodes: Number(meta.styledNodes || 0),
    pseudoRuleCount: Number(meta.pseudoRuleCount || 0),
    imageCount: Number(meta.imageCount || 0),
    tableCount: Number(meta.tableCount || 0),
  };
}

async function proxyAsset(req, res) {
  const body = await readBody(req, MAX_IMAGE_BYTES);
  let lastError = "asset worker unavailable";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://${HOST}:${ASSET_WORKER_PORT}/asset`, {
        method: "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "application/octet-stream",
          "X-Kpoparkive-Meta": req.headers["x-kpoparkive-meta"] || "",
        },
        body,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Content-Length": bytes.length,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(bytes);
      stats.proxiedAssets += 1;
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  stats.proxyErrors += 1;
  throw new Error(lastError);
}

const assetWorker = spawn(process.execPath, [path.resolve("scripts/namu-chrome-capture-helper-v3.mjs")], {
  env: { ...process.env, NAMU_CAPTURE_PORT: String(ASSET_WORKER_PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});

assetWorker.on("exit", (code, signal) => {
  if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
    console.error(`Asset worker exited unexpectedly (code=${code}, signal=${signal || "none"}).`);
  }
});

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Kpoparkive-Meta",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      service: "kpoparkive-namu-chrome-capture-combined-v2",
      port: PORT,
      assetWorkerPort: ASSET_WORKER_PORT,
      supabaseHost: SUPABASE_HOST,
      documentCapture: DOCUMENT_CAPTURE_VERSION,
      stats,
    });
    return;
  }

  try {
    if (req.method === "POST" && url.pathname === "/document") {
      const bytes = await readBody(req, MAX_DOCUMENT_BYTES);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error("document capture payload is not valid JSON"); }
      const result = await saveRenderedDocument(payload);
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/asset") {
      await proxyAsset(req, res);
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (url.pathname === "/document") stats.documentErrors += 1;
    else stats.proxyErrors += 1;
    console.error(`CAPTURE COMBINED ERROR: ${message}`);
    json(res, 400, { ok: false, error: message });
  }
});

function shutdown() {
  try { assetWorker.kill("SIGTERM"); } catch {}
  try { server.close(); } catch {}
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log("Kpoparkive Namu Chrome capture helper v5 (DOM + computed layout + images)");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Image worker proxy: http://${HOST}:${ASSET_WORKER_PORT}`);
  console.log(`Supabase: ${SUPABASE_HOST}`);
  console.log(`Artifact format: ${DOCUMENT_CAPTURE_VERSION}`);
  console.log("Capture stores the final rendered DOM, computed styles/layout snapshot, pseudo-element CSS and verified image bytes.");
});
