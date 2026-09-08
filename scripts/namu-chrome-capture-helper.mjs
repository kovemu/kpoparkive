import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BUCKET = "wiki-media";
const HOST = "127.0.0.1";
const PORT = Math.max(1, Number(process.env.NAMU_CAPTURE_PORT || 43117) || 43117);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 30_000;

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

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is missing. Put it in .env.local before running the capture helper.");
  process.exit(1);
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

function canonicalFileKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function safePart(value) {
  const ascii = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return ascii || "asset";
}

function detectContentType(bytes, declared = "", url = "") {
  const header = String(declared || "").split(";", 1)[0].trim().toLowerCase();
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && /^(?:avif|avis)$/i.test(bytes.subarray(8, 12).toString("ascii"))) return "image/avif";
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[\s\S]{0,1000}?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(sample)) return "image/svg+xml";
  if (/^image\/(?:jpeg|png|gif|webp|avif|svg\+xml)$/.test(header)) return header;
  const ext = String(url || "").match(/\.(jpe?g|png|gif|webp|avif|svg)(?:$|[?#])/i)?.[1]?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" })[ext] || "";
}

function extensionFor(contentType) {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
  })[contentType] || "bin";
}

function dimensionsFromBytes(bytes, contentType) {
  try {
    if (contentType === "image/png" && bytes.length >= 24) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (contentType === "image/gif" && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if (contentType === "image/jpeg") {
      let i = 2;
      const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
      while (i + 8 < bytes.length) {
        if (bytes[i] !== 0xff) { i += 1; continue; }
        const marker = bytes[i + 1];
        if (sof.has(marker)) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
        if (i + 4 > bytes.length) break;
        const length = bytes.readUInt16BE(i + 2);
        if (length < 2) break;
        i += 2 + length;
      }
    }
    if (contentType === "image/webp" && bytes.length >= 30 && bytes.subarray(12, 16).toString("ascii") === "VP8X") {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return { width, height };
    }
    if (contentType === "image/svg+xml") {
      const sample = bytes.subarray(0, Math.min(bytes.length, 65536)).toString("utf8");
      const svg = sample.match(/<svg\b[^>]*>/i)?.[0] || "";
      const width = Number(svg.match(/\bwidth=["']?([\d.]+)/i)?.[1] || 0);
      const height = Number(svg.match(/\bheight=["']?([\d.]+)/i)?.[1] || 0);
      if (width > 0 && height > 0) return { width, height };
      const viewBox = svg.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)["']/i);
      if (viewBox) return { width: Number(viewBox[1]), height: Number(viewBox[2]) };
    }
  } catch {}
  return { width: 0, height: 0 };
}

const queueCache = new Map();

async function loadQueue(rootTitle, force = false) {
  const cached = queueCache.get(rootTitle);
  if (!force && cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) return cached;

  const rows = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const batch = await db(
      `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}` +
      `&asset_type=eq.image&status=in.(pending,unresolved)` +
      `&select=id,source_title,source_ref,label,status,metadata` +
      `&order=updated_at.asc.nullsfirst,id.asc&limit=1000&offset=${offset}`,
    );
    rows.push(...batch);
    if (batch.length < 1000) break;
  }

  const byKey = new Map();
  for (const row of rows) {
    const key = canonicalFileKey(row.label || row.source_ref);
    if (!key) continue;
    const group = byKey.get(key) || [];
    group.push(row);
    byKey.set(key, group);
  }
  const value = { loadedAt: Date.now(), rows, byKey };
  queueCache.set(rootTitle, value);
  return value;
}

async function uploadToStorage(bytes, contentType, rootTitle, sourceTitle, fileKey, sourceUrl) {
  const hash = crypto.createHash("sha256").update(`${rootTitle}|${fileKey}|${sourceUrl}`).digest("hex").slice(0, 16);
  const ext = extensionFor(contentType);
  const storagePath = `imports/${safePart(rootTitle)}/${safePart(sourceTitle)}-${hash}.${ext}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!response.ok) throw new Error(`storage upload ${response.status}: ${await response.text()}`);
  return { storagePath, publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}` };
}

async function patchResolved(rows, result, meta, contentType, width, height, byteLength) {
  const updatedAt = new Date().toISOString();
  await Promise.all(rows.map((row) => db(`source_asset_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "resolved",
      resolved_url: result.publicUrl,
      storage_path: result.storagePath,
      confidence: 0.999,
      metadata: {
        ...(row.metadata || {}),
        original_url: meta.sourceUrl,
        browser_source_page: meta.pageUrl,
        content_type: contentType,
        bytes: byteLength,
        width,
        height,
        visible_ratio: meta.visual?.visibleRatio ?? null,
        color_range: meta.visual?.colorRange ?? null,
        resolved_from: "manual-chrome-capture-extension",
        resolution_error: null,
        browser_capture_at: updatedAt,
      },
      updated_at: updatedAt,
    }),
  })));
}

function decodeMeta(value) {
  if (!value) throw new Error("missing X-Kpoparkive-Meta header");
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_IMAGE_BYTES) {
        reject(new Error("image exceeds 8 MB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const stats = { received: 0, resolved: 0, noQueue: 0, rejected: 0, errors: 0 };

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
    json(res, 200, { ok: true, service: "kpoparkive-namu-chrome-capture-helper", port: PORT, stats });
    return;
  }

  if (req.method !== "POST" || url.pathname !== "/asset") {
    json(res, 404, { ok: false, error: "not found" });
    return;
  }

  stats.received += 1;
  try {
    const meta = decodeMeta(req.headers["x-kpoparkive-meta"]);
    const rootTitle = String(meta.rootTitle || "").trim();
    const sourceTitle = String(meta.sourceTitle || "").normalize("NFKC").trim();
    const fileName = String(meta.fileName || "").normalize("NFKC").trim();
    if (!rootTitle || !sourceTitle || !fileName) throw new Error("capture metadata is missing rootTitle/sourceTitle/fileName");

    const pageUrl = new URL(String(meta.pageUrl || ""));
    if (!/(^|\.)namu\.wiki$/i.test(pageUrl.hostname)) throw new Error("capture page is not namu.wiki");
    const sourceUrl = new URL(String(meta.sourceUrl || ""));
    if (sourceUrl.protocol !== "https:") throw new Error("image source must be https");

    const bytes = await readBody(req);
    if (!bytes.length) throw new Error("empty image body");
    const contentType = detectContentType(bytes, req.headers["content-type"] || meta.contentType || "", sourceUrl.toString());
    if (!contentType) throw new Error("payload is not a supported image");

    const parsed = dimensionsFromBytes(bytes, contentType);
    const width = Math.max(Number(meta.width || 0), Number(parsed.width || 0));
    const height = Math.max(Number(meta.height || 0), Number(parsed.height || 0));
    if (contentType !== "image/svg+xml" && (width < 8 || height < 8)) throw new Error(`placeholder-sized image ${width}x${height}`);
    if (meta.visual && meta.visual.valid === false) throw new Error(meta.visual.reason || "browser visual validation failed");

    const fileKey = canonicalFileKey(fileName);
    let cache = await loadQueue(rootTitle);
    let rows = cache.byKey.get(fileKey) || [];
    if (!rows.length) {
      cache = await loadQueue(rootTitle, true);
      rows = cache.byKey.get(fileKey) || [];
    }
    if (!rows.length) {
      stats.noQueue += 1;
      json(res, 200, { ok: true, status: "no_queue", fileName, bytes: bytes.length, width, height });
      return;
    }

    const stored = await uploadToStorage(bytes, contentType, rootTitle, sourceTitle, fileKey, sourceUrl.toString());
    await patchResolved(rows, stored, { ...meta, sourceUrl: sourceUrl.toString(), pageUrl: pageUrl.toString() }, contentType, width, height, bytes.length);
    cache.byKey.delete(fileKey);
    stats.resolved += 1;
    console.log(`RESOLVED ${fileName} -> ${width}x${height}, ${(bytes.length / 1024).toFixed(1)} KB (${rows.length} queue rows)`);
    console.log(`  ${stored.storagePath}`);
    json(res, 200, { ok: true, status: "resolved", fileName, matchedRows: rows.length, storagePath: stored.storagePath, bytes: bytes.length, width, height });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stats.errors += 1;
    console.error(`CAPTURE ERROR: ${message}`);
    json(res, 400, { ok: false, status: "error", error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log("Kpoparkive Namu Chrome capture helper");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log("Open NamuWiki in your normal Chrome, then use the unpacked Kpoparkive capture extension.");
  console.log("Resolved files are uploaded to Supabase Storage: wiki-media/imports/<root>/...");
});
