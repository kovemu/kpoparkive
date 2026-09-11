import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.NAMU_RAW_ASSET_PORT || 43120) || 43120;
const BUCKET = "wiki-media";
const MAX_JSON_BYTES = 512 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;

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
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing in .env.local");

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
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function dbAll(pathname, pageSize = 1000, maxRows = 20000) {
  const rows = [];
  const separator = pathname.includes("?") ? "&" : "?";
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db(`${pathname}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...(batch || []));
    if (!batch || batch.length < pageSize) return rows;
  }
  throw new Error(`Supabase pagination reached ${maxRows} rows for ${pathname}`);
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

function readJson(req) {
  return readBody(req, MAX_JSON_BYTES).then((bytes) => {
    try { return bytes.length ? JSON.parse(bytes.toString("utf8")) : {}; }
    catch { throw new Error("request body is not valid JSON"); }
  });
}

function decodeMeta(value) {
  if (!value) return {};
  try { return JSON.parse(Buffer.from(String(value), "base64").toString("utf8")); }
  catch { throw new Error("X-Kpoparkive-Meta is not valid base64 JSON"); }
}

function canonicalFileKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[?#].*$/, "")
    .replace(/[ \t]+/g, " ")
    .toLowerCase();
}

function displayFileName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[ \t]+/g, " ");
}

function extractRawFileLinks(raw) {
  const result = [];
  const seen = new Set();
  for (const match of String(raw || "").matchAll(/\[\[(?:파일|File):([^\]|]+)(?=[\]|])/gi)) {
    const fileName = displayFileName(match[1]);
    const key = canonicalFileKey(fileName);
    if (!fileName || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(`파일:${fileName}`);
  }
  return result;
}

function storageBacked(row) {
  if (!row || row.status !== "resolved") return false;
  if (String(row.storage_path || "").trim()) return true;
  const resolvedUrl = String(row.resolved_url || "");
  return resolvedUrl.startsWith(`${SUPABASE_URL}/storage/v1/object/`);
}

function requiredFilesForDocument(doc) {
  const fromMeta = Array.isArray(doc?.source_namumark_meta?.requiredFiles)
    ? doc.source_namumark_meta.requiredFiles.map(String)
    : [];
  const source = fromMeta.length ? fromMeta : extractRawFileLinks(doc?.source_wikitext || "");
  const result = [];
  const seen = new Set();
  for (const raw of source) {
    const fileName = displayFileName(raw);
    const key = canonicalFileKey(fileName);
    if (!fileName || !key || seen.has(key)) continue;
    seen.add(key);
    result.push({ key, fileName, sourceRef: `파일:${fileName}` });
  }
  return result;
}

async function insertRequiredQueueRow(doc, rootTitle, item) {
  const created = await db("source_asset_queue", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      source_document_id: doc.id,
      root_title: rootTitle,
      source_title: doc.source_title,
      asset_type: "image",
      source_ref: item.sourceRef,
      label: item.fileName,
      provider: "namuwiki",
      role: "raw_required",
      status: "unresolved",
      metadata: {
        origin: "raw-asset-resolver-v2",
        filename: item.fileName,
        required_by: doc.source_title,
      },
    }),
  });
  return created?.[0] || null;
}

async function buildPlan(payload) {
  const sourceTitle = String(payload?.sourceTitle || payload?.rootTitle || "").normalize("NFKC").trim();
  if (!sourceTitle) throw new Error("sourceTitle/rootTitle is required");

  const docs = await db(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(sourceTitle)}` +
    `&select=id,source_title,root_title,source_wikitext,source_namumark_meta&limit=1`,
  );
  const doc = docs?.[0];
  if (!doc) throw new Error(`No raw source_document found for ${sourceTitle}`);

  const rootTitle = String(payload?.rootTitle || doc.root_title || sourceTitle).normalize("NFKC").trim() || sourceTitle;
  const requiredMap = new Map();
  for (const item of requiredFilesForDocument(doc)) {
    requiredMap.set(item.key, item);
  }
  for (const rawRef of Array.isArray(payload?.requiredFiles) ? payload.requiredFiles : []) {
    const fileName = displayFileName(rawRef);
    const key = canonicalFileKey(fileName);
    if (!fileName || !key) continue;
    requiredMap.set(key, { key, fileName, sourceRef: `파일:${fileName}` });
  }
  const required = [...requiredMap.values()];
  if (!required.length) {
    return { ok: true, rootTitle, sourceTitle: doc.source_title, requiredCount: 0, resolvedCount: 0, missingCount: 0, requiredFiles: [], resolvedFiles: [], missingFiles: [], warning: "No requiredFiles metadata is available yet. Run the The Tree render once first." };
  }

  const rows = await dbAll(
    `source_asset_queue?asset_type=eq.image` +
    `&select=id,source_document_id,root_title,source_title,source_ref,label,status,resolved_url,storage_path,metadata&order=id.asc`,
  );
  const byKey = new Map();
  for (const row of rows) {
    for (const raw of [row.source_ref, row.label, row.metadata?.filename]) {
      const key = canonicalFileKey(raw);
      if (!key) continue;
      const group = byKey.get(key) || [];
      if (!group.some((existing) => existing.id === row.id)) group.push(row);
      byKey.set(key, group);
    }
  }

  const resolvedFiles = [];
  const missingFiles = [];
  let queueRowsCreated = 0;

  for (const item of required) {
    let group = byKey.get(item.key) || [];
    const resolved = group.find(storageBacked);
    if (resolved) {
      resolvedFiles.push({
        fileName: item.fileName,
        sourceRef: item.sourceRef,
        queueRowId: resolved.id,
        storagePath: resolved.storage_path || null,
        resolvedUrl: resolved.resolved_url || null,
        contentType: resolved.metadata?.content_type || null,
      });
      continue;
    }

    if (!group.length) {
      try {
        const created = await insertRequiredQueueRow(doc, rootTitle, item);
        if (created) {
          group = [created];
          byKey.set(item.key, group);
          queueRowsCreated += 1;
        }
      } catch (error) {
        const refreshed = await db(
          `source_asset_queue?source_document_id=eq.${encodeURIComponent(doc.id)}` +
          `&asset_type=eq.image&source_ref=eq.${encodeURIComponent(item.sourceRef)}` +
          `&select=id,source_document_id,source_title,source_ref,label,status,resolved_url,storage_path,metadata&limit=1`,
        );
        if (refreshed?.[0]) group = [refreshed[0]];
        else throw error;
      }
    }

    const hasResolvedButExternalOnly = group.some((row) => row.status === "resolved" && !storageBacked(row));
    missingFiles.push({
      fileName: item.fileName,
      sourceRef: item.sourceRef,
      sourceTitle: doc.source_title,
      queueRowIds: group.map((row) => row.id),
      reason: !group.length ? "queue-row-missing" : hasResolvedButExternalOnly ? "not-storage-backed" : "unresolved",
    });
  }

  return {
    ok: true,
    rootTitle,
    sourceTitle: doc.source_title,
    requiredCount: required.length,
    resolvedCount: resolvedFiles.length,
    missingCount: missingFiles.length,
    queueRowsCreated,
    requiredFiles: required.map((item) => item.sourceRef),
    resolvedFiles,
    missingFiles,
  };
}

function safePart(value) {
  const part = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return part || "asset";
}

function extForContentType(contentType) {
  return ({
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  })[contentType] || "bin";
}

async function uploadVideo(bytes, meta, contentType) {
  const rootTitle = String(meta?.rootTitle || "").normalize("NFKC").trim();
  const sourceTitle = String(meta?.sourceTitle || rootTitle).normalize("NFKC").trim();
  const fileName = displayFileName(meta?.fileName || meta?.semanticFileName || "");
  if (!rootTitle || !sourceTitle || !fileName) throw new Error("media upload metadata is missing rootTitle/sourceTitle/fileName");
  if (!/^video\/(?:mp4|webm|quicktime)$/i.test(contentType)) throw new Error(`unsupported media type: ${contentType}`);
  if (!bytes.length) throw new Error("empty media payload");

  const rows = await dbAll(
    `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image` +
    `&select=id,source_ref,label,status,resolved_url,storage_path,metadata&order=id.asc`,
  );
  const targetKey = canonicalFileKey(fileName);
  const matched = rows.filter((row) => [row.source_ref, row.label, row.metadata?.filename].some((value) => canonicalFileKey(value) === targetKey));
  if (!matched.length) throw new Error(`No source_asset_queue row matches ${fileName}`);

  const sourceUrl = String(meta?.sourceUrl || "");
  const hash = crypto.createHash("sha256").update(`${rootTitle}|${targetKey}|${sourceUrl}|${bytes.length}`).digest("hex").slice(0, 16);
  const ext = extForContentType(contentType);
  const storagePath = `imports/${safePart(rootTitle)}/${safePart(sourceTitle)}-${hash}.${ext}`;
  const storageResponse = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!storageResponse.ok) throw new Error(`storage upload ${storageResponse.status}: ${await storageResponse.text()}`);

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`;
  const capturedAt = new Date().toISOString();
  for (const row of matched) {
    await db(`source_asset_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "resolved",
        resolved_url: publicUrl,
        storage_path: storagePath,
        confidence: 0.999,
        metadata: {
          ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
          filename: fileName,
          content_type: contentType,
          width: Number(meta?.width || 0),
          height: Number(meta?.height || 0),
          duration: meta?.duration ?? null,
          bytes: bytes.length,
          original_url: sourceUrl || null,
          browser_source_page: String(meta?.pageUrl || ""),
          browser_capture_at: capturedAt,
          resolved_from: "raw-video-capture-v2",
          resolution_error: null,
        },
        updated_at: capturedAt,
      }),
    });
  }

  console.log(`RAW VIDEO RESOLVED ${fileName} -> ${contentType}, ${(bytes.length / 1024).toFixed(1)} KB (${matched.length} queue rows)`);
  console.log(`  ${storagePath}`);
  return {
    ok: true,
    status: "resolved",
    fileName,
    contentType,
    matchedRows: matched.length,
    storagePath,
    resolvedUrl: publicUrl,
    bytes: bytes.length,
    width: Number(meta?.width || 0),
    height: Number(meta?.height || 0),
    duration: meta?.duration ?? null,
  };
}

async function invalidateSourceRender(payload) {
  const sourceTitle = String(payload?.sourceTitle || payload?.rootTitle || "").normalize("NFKC").trim();
  if (!sourceTitle) throw new Error("sourceTitle/rootTitle is required");

  await db(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(sourceTitle)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        source_namumark_rendered_at: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  return { ok: true, sourceTitle };
}

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
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, service: "kpoparkive-raw-asset-helper-v2", port: PORT, videoBackedFiles: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/plan") {
      json(res, 200, await buildPlan(await readJson(req)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/media") {
      const contentType = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
      const meta = decodeMeta(req.headers["x-kpoparkive-meta"] || "");
      const bytes = await readBody(req, MAX_MEDIA_BYTES);
      json(res, 200, await uploadVideo(bytes, meta, contentType));
      return;
    }

    if (req.method === "POST" && url.pathname === "/invalidate-render") {
      json(res, 200, await invalidateSourceRender(await readJson(req)));
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`RAW ASSET HELPER ERROR: ${message}`);
    json(res, 400, { ok: false, error: message });
  }
});

function shutdown() {
  try { server.close(); } catch {}
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log("Kpoparkive Raw Asset helper v2");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log("Supports Namu files whose display payload is video/mp4 even when the wiki filename ends in .gif.");
});
