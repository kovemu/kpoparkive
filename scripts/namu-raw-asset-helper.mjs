import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.NAMU_RAW_ASSET_PORT || 43120) || 43120;
const MAX_JSON_BYTES = 512 * 1024;

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
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error("request exceeds 512 KB"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); }
      catch { reject(new Error("request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
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
        origin: "raw-asset-resolver",
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
  const required = requiredFilesForDocument(doc);
  if (!required.length) {
    return {
      ok: true,
      rootTitle,
      sourceTitle: doc.source_title,
      requiredCount: 0,
      resolvedCount: 0,
      missingCount: 0,
      requiredFiles: [],
      resolvedFiles: [],
      missingFiles: [],
      warning: "No requiredFiles metadata is available yet. Run the The Tree render once first.",
    };
  }

  const rows = await dbAll(
    `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image` +
    `&select=id,source_document_id,source_title,source_ref,label,status,resolved_url,storage_path,metadata&order=id.asc`,
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
        // A concurrent resolver may have inserted the row after the initial read.
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
      reason: !group.length
        ? "queue-row-missing"
        : hasResolvedButExternalOnly
          ? "not-storage-backed"
          : "unresolved",
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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, service: "kpoparkive-raw-asset-helper-v1", port: PORT });
      return;
    }

    if (req.method === "POST" && url.pathname === "/plan") {
      const payload = await readJson(req);
      json(res, 200, await buildPlan(payload));
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
  console.log("Kpoparkive Raw Asset helper v1");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log("Plans required The Tree files against storage-backed source_asset_queue rows and creates missing queue rows when necessary.");
});
