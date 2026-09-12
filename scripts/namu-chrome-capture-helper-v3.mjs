import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BUCKET = "wiki-media";
const HOST = "127.0.0.1";
const PORT = Number(process.env.NAMU_CAPTURE_PORT || 43117) || 43117;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const FORCE_REFRESH_COOLDOWN_MS = 5000;
const IMAGE_EXT_RE = /\.(jpe?g|png|gif|webp|avif|svg)$/i;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m || process.env[m[1]]) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[m[1]] = value;
  }
}

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing in .env.local");

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
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra };
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
    .replace(/[?#].*$/, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function stemKey(value) {
  return canonicalFileKey(value).replace(IMAGE_EXT_RE, "").trim();
}

function cleanHint(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/(?:\.{3}|…)+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSourceTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function hasEllipsis(value) {
  return /(?:\.{3}|…)\s*$/.test(String(value || "").trim());
}

function isAnonymousName(value) {
  return /^__anonymous__\d+/i.test(String(value || "")) || /^anonymous@/i.test(String(value || ""));
}

function representativeLabel(rows, fallback = "") {
  const row = rows?.[0];
  return String(row?.label || row?.source_ref || row?.metadata?.filename || fallback || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:파일|File):/i, "");
}

function safePart(value) {
  const v = String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return v || "asset";
}

function detectContentType(bytes, declared = "", url = "") {
  const header = String(declared || "").split(";", 1)[0].trim().toLowerCase();
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = bytes.subarray(8, 12).toString("ascii");
    if (/^(?:avif|avis)$/i.test(brand)) return "image/avif";
    if (/^(?:isom|iso2|mp41|mp42|avc1|dash|M4V |MSNV)$/i.test(brand)) return "video/mp4";
  }
  const sample = bytes.subarray(0, Math.min(bytes.length, 8192)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[\s\S]{0,1000}?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(sample)) return "image/svg+xml";
  if (/^image\/(?:jpeg|png|gif|webp|avif|svg\+xml)$/.test(header)) return header;
  if (/^video\/(?:mp4|webm|quicktime)$/.test(header)) return header;
  const ext = String(url || "").match(/\.(jpe?g|png|gif|webp|avif|svg|mp4|webm|mov)(?:$|[?#])/i)?.[1]?.toLowerCase();
  return ({
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  })[ext] || "";
}

function extensionFor(contentType) {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
  })[contentType] || "bin";
}

function dimensionsFromBytes(bytes, contentType) {
  try {
    if (contentType === "image/png" && bytes.length >= 24) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    if (contentType === "image/gif" && bytes.length >= 10) return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    if (contentType === "image/jpeg") {
      let i = 2;
      const sof = new Set([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf]);
      while (i + 8 < bytes.length) {
        if (bytes[i] !== 0xff) { i += 1; continue; }
        const marker = bytes[i + 1];
        if (sof.has(marker)) return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
        if (i + 4 > bytes.length) break;
        const len = bytes.readUInt16BE(i + 2);
        if (len < 2) break;
        i += 2 + len;
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
async function loadQueue(rootTitle, sourceTitle = "", force = false) {
  const root = String(rootTitle || "").normalize("NFKC").trim();
  const source = String(sourceTitle || "").normalize("NFKC").trim();
  if (!root) throw new Error("rootTitle is required for asset queue lookup");

  const cacheKey = root + "\u0000" + (source || "*");
  const cached = queueCache.get(cacheKey);
  const age = cached ? Date.now() - cached.loadedAt : Number.POSITIVE_INFINITY;
  if (cached && (!force && age < CACHE_TTL_MS)) return cached;
  if (cached && force && age < FORCE_REFRESH_COOLDOWN_MS) return cached;

  const rows = [];
  for (let offset = 0; offset < 20000; offset += 1000) {
    let query =
      `source_asset_queue?root_title=eq.${encodeURIComponent(root)}&asset_type=eq.image`;
    if (source) query += `&source_title=eq.${encodeURIComponent(source)}`;
    query +=
      `&select=id,root_title,source_title,source_ref,label,status,resolved_url,storage_path,metadata` +
      `&order=id.asc&limit=1000&offset=${offset}`;

    const batch = await db(query);
    rows.push(...batch);
    if (batch.length < 1000) break;
  }

  const byKey = new Map();
  for (const row of rows) {
    for (const raw of [row.label, row.source_ref, row.metadata?.filename]) {
      const key = canonicalFileKey(raw);
      if (!key) continue;
      const group = byKey.get(key) || [];
      if (!group.some((item) => item.id === row.id)) group.push(row);
      byKey.set(key, group);
    }
  }

  const value = { loadedAt: Date.now(), rows, byKey };
  queueCache.set(cacheKey, value);
  return value;
}

function narrowAnonymousCandidates(candidates, meta, preferSvg) {
  let narrowed = candidates;
  let usedSourcePage = false;
  let usedType = false;

  if (narrowed.length > 1) {
    const sourceTitle = normalizeSourceTitle(meta.sourceTitle);
    if (sourceTitle) {
      const sourceScoped = narrowed.filter((entry) =>
        entry.rows.some((row) => normalizeSourceTitle(row.source_title) === sourceTitle),
      );
      if (sourceScoped.length) {
        narrowed = sourceScoped;
        usedSourcePage = true;
      }
    }
  }

  if (narrowed.length > 1) {
    const typed = narrowed.filter((entry) => preferSvg ? entry.key.endsWith(".svg") : !entry.key.endsWith(".svg"));
    if (typed.length) {
      narrowed = typed;
      usedType = true;
    }
  }

  return { candidates: narrowed, usedSourcePage, usedType };
}

function inferAnonymousMatch(cache, meta, contentType) {
  const hints = [meta.semanticFileName, meta.alt, meta.title].filter((v) => String(v || "").trim());
  if (!hints.length) return null;

  const entries = [...cache.byKey.entries()].map(([key, rows]) => ({ key, rows, stem: stemKey(key) }));
  const preferSvg = contentType === "image/svg+xml";

  for (const rawHint of hints) {
    const hint = cleanHint(rawHint);
    if (hint.length < 2) continue;
    const truncated = hasEllipsis(rawHint);

    if (!truncated) {
      const exactRaw = entries.filter((entry) => entry.stem === hint);
      const exact = narrowAnonymousCandidates(exactRaw, meta, preferSvg);
      if (exact.candidates.length === 1) {
        const sourceSuffix = exact.usedSourcePage ? "-source-page" : "";
        const typeSuffix = exact.usedType ? "-type" : "";
        return {
          ...exact.candidates[0],
          method: `alt-stem-exact${sourceSuffix}${typeSuffix}`,
          confidence: exact.usedSourcePage ? 0.998 : 0.995,
          hint: rawHint,
        };
      }
    }

    if (hint.length >= 4) {
      const prefixRaw = entries.filter((entry) => entry.stem.startsWith(hint));
      const prefix = narrowAnonymousCandidates(prefixRaw, meta, preferSvg);
      if (prefix.candidates.length === 1) {
        const sourceSuffix = prefix.usedSourcePage ? "-source-page" : "";
        const typeSuffix = prefix.usedType ? "-type" : "";
        return {
          ...prefix.candidates[0],
          method: `alt-stem-prefix${sourceSuffix}${typeSuffix}`,
          confidence: prefix.usedSourcePage ? 0.985 : 0.965,
          hint: rawHint,
        };
      }
    }
  }
  return null;
}

async function uploadToStorage(bytes, contentType, prefix, rootTitle, sourceTitle, fileKey, sourceUrl) {
  const hash = crypto.createHash("sha256").update(`${rootTitle}|${fileKey}|${sourceUrl}`).digest("hex").slice(0, 16);
  const ext = extensionFor(contentType);
  const storagePath = `${prefix}/${safePart(rootTitle)}/${safePart(sourceTitle)}-${hash}.${ext}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
  });
  if (!response.ok) throw new Error(`storage upload ${response.status}: ${await response.text()}`);
  return { storagePath, publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}` };
}

async function upsertCapture(meta, storagePath, contentType, width, height, byteLength, captureStatus, matchedRows, extra = {}) {
  const body = {
    root_title: meta.rootTitle,
    source_title: meta.sourceTitle,
    file_name: extra.inferredFileName || meta.fileName,
    canonical_key: canonicalFileKey(extra.inferredFileName || meta.fileName),
    page_url: meta.pageUrl,
    source_url: meta.sourceUrl,
    content_type: contentType,
    byte_length: byteLength,
    width,
    height,
    storage_path: storagePath,
    capture_status: captureStatus,
    matched_queue_rows: matchedRows,
    captured_at: new Date().toISOString(),
    metadata: {
      visual: meta.visual || null,
      anonymous: Boolean(meta.anonymous),
      dom_index: meta.domIndex ?? null,
      alt: meta.alt || "",
      title: meta.title || "",
      heading: meta.heading || "",
      context_text: meta.contextText || "",
      semantic_file_name: meta.semanticFileName || null,
      inferred_file_name: extra.inferredFileName || null,
      match_method: extra.matchMethod || null,
      match_hint: extra.matchHint || null,
    },
  };
  await db("namu_capture_staging?on_conflict=root_title,canonical_key,source_url", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(body),
  });
}

async function patchResolved(rows, stored, meta, contentType, width, height, byteLength, confidence, resolutionMethod, inferredFileName) {
  const updatedAt = new Date().toISOString();
  await Promise.all(rows.map((row) => db(`source_asset_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "resolved",
      resolved_url: stored.publicUrl,
      storage_path: stored.storagePath,
      confidence,
      metadata: {
        ...(row.metadata || {}),
        original_url: meta.sourceUrl,
        browser_source_page: meta.pageUrl,
        content_type: contentType,
        media_type: String(meta.mediaType || (contentType.startsWith("video/") ? "video" : "image")),
        bytes: byteLength,
        width,
        height,
        visible_ratio: meta.visual?.visibleRatio ?? null,
        color_range: meta.visual?.colorRange ?? null,
        resolved_from: "manual-chrome-capture-extension-v3",
        resolution_error: null,
        browser_capture_at: updatedAt,
        browser_match_method: resolutionMethod,
        browser_match_hint: meta.alt || meta.title || null,
        browser_inferred_file_name: inferredFileName || null,
      },
      updated_at: updatedAt,
    }),
  })));
}

function reusableResolvedRow(rows) {
  return (rows || []).find((row) =>
    String(row?.status || "") === "resolved" &&
    String(row?.storage_path || "").trim() &&
    String(row?.resolved_url || "").trim()
  ) || null;
}

async function attachUnresolvedRowsToExisting(rows, reusable) {
  const pending = (rows || []).filter((row) =>
    row?.id &&
    !(
      String(row?.status || "") === "resolved" &&
      String(row?.storage_path || "").trim() &&
      String(row?.resolved_url || "").trim()
    )
  );
  if (!pending.length || !reusable) return 0;

  const updatedAt = new Date().toISOString();
  await Promise.all(pending.map((row) => db(`source_asset_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "resolved",
      resolved_url: reusable.resolved_url,
      storage_path: reusable.storage_path,
      confidence: 1,
      metadata: {
        ...(row.metadata || {}),
        reused_existing_asset: true,
        reused_from_queue_id: reusable.id,
      },
      updated_at: updatedAt,
    }),
  })));
  return pending.length;
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
      if (size > MAX_IMAGE_BYTES) { reject(new Error("image exceeds 8 MB")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const stats = { received: 0, resolved: 0, reused: 0, inferred: 0, noQueue: 0, staged: 0, errors: 0 };

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, X-Kpoparkive-Meta", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, service: "kpoparkive-namu-chrome-capture-helper-v3", port: PORT, supabase: SUPABASE_URL, stats });
    return;
  }
  if (req.method !== "POST" || url.pathname !== "/asset") {
    json(res, 404, { ok: false, error: "not found" });
    return;
  }

  stats.received += 1;
  try {
    const meta = decodeMeta(req.headers["x-kpoparkive-meta"]);
    meta.rootTitle = String(meta.rootTitle || "").trim();
    meta.sourceTitle = String(meta.sourceTitle || "").normalize("NFKC").trim();
    meta.fileName = String(meta.fileName || "").normalize("NFKC").trim();
    if (!meta.rootTitle || !meta.sourceTitle || !meta.fileName) throw new Error("missing root/source/file metadata");

    const pageUrl = new URL(String(meta.pageUrl || ""));
    if (!/(^|\.)namu\.wiki$/i.test(pageUrl.hostname)) throw new Error("capture page is not namu.wiki");
    const sourceUrl = new URL(String(meta.sourceUrl || ""));
    if (sourceUrl.protocol !== "https:") throw new Error("image source must be https");
    meta.pageUrl = pageUrl.toString();
    meta.sourceUrl = sourceUrl.toString();

    const bytes = await readBody(req);
    if (!bytes.length) throw new Error("empty image body");
    const contentType = detectContentType(bytes, req.headers["content-type"] || meta.contentType || "", meta.sourceUrl);
    if (!contentType) throw new Error("payload is not a supported image");
    const parsed = dimensionsFromBytes(bytes, contentType);
    const rawWidth = Math.max(Number(meta.width || 0), Number(parsed.width || 0));
    const rawHeight = Math.max(Number(meta.height || 0), Number(parsed.height || 0));
    const width = Number.isFinite(rawWidth) ? Math.max(0, Math.round(rawWidth)) : 0;
    const height = Number.isFinite(rawHeight) ? Math.max(0, Math.round(rawHeight)) : 0;
    if (!contentType.startsWith("video/") && contentType !== "image/svg+xml" && (width < 8 || height < 8)) {
      throw new Error(`placeholder-sized image ${width}x${height}`);
    }
    if (meta.visual?.valid === false) throw new Error(meta.visual.reason || "browser visual validation failed");

    let cache = await loadQueue(meta.rootTitle, meta.sourceTitle);
    let fileKey = canonicalFileKey(meta.fileName);
    let rows = isAnonymousName(meta.fileName) ? [] : (cache.byKey.get(fileKey) || []);
    let matchMethod = rows.length ? "semantic-filename-exact" : null;
    let confidence = rows.length ? 0.999 : 0;
    let inferredFileName = rows.length ? representativeLabel(rows, meta.fileName) : null;
    let matchHint = meta.semanticFileName || meta.alt || meta.title || null;

    if (!rows.length) {
      cache = await loadQueue(meta.rootTitle, meta.sourceTitle, true);
      if (!isAnonymousName(meta.fileName)) rows = cache.byKey.get(fileKey) || [];
    }

    // Current-page rows are normally sufficient and are indexed to a few ms.
    // Fall back to the root cache only when the page queue genuinely lacks the
    // file, preserving cross-document reuse without paying the cost per image.
    if (!rows.length) {
      const rootCache = await loadQueue(meta.rootTitle);
      if (!isAnonymousName(meta.fileName)) {
        rows = rootCache.byKey.get(fileKey) || [];
        if (rows.length) {
          cache = rootCache;
          matchMethod = "root-filename-exact";
          confidence = 0.995;
          inferredFileName = representativeLabel(rows, meta.fileName);
        }
      } else {
        cache = rootCache;
      }
    }

    if (!rows.length && isAnonymousName(meta.fileName)) {
      const inferred = inferAnonymousMatch(cache, meta, contentType);
      if (inferred) {
        fileKey = inferred.key;
        rows = inferred.rows;
        matchMethod = inferred.method;
        confidence = inferred.confidence;
        inferredFileName = representativeLabel(rows, inferred.key);
        matchHint = inferred.hint;
        stats.inferred += 1;
      }
    }

    if (rows.length && !Boolean(meta.refreshExisting)) {
      const reusable = reusableResolvedRow(rows);
      if (reusable) {
        const linkedRows = await attachUnresolvedRowsToExisting(rows, reusable);
        stats.reused += 1;
        console.log(
          `REUSED ${inferredFileName || meta.fileName} <- ${meta.fileName} [${matchMethod || "existing-resolved"}] -> ${reusable.storage_path}` +
          (linkedRows ? ` (+${linkedRows} queue rows linked)` : "")
        );
        json(res, 200, {
          ok: true,
          status: "resolved",
          reused: true,
          fileName: inferredFileName || meta.fileName,
          matchedRows: rows.length,
          storagePath: reusable.storage_path,
          resolvedUrl: reusable.resolved_url,
          bytes: Number(reusable?.metadata?.bytes || 0) || bytes.length,
          width: Number(reusable?.metadata?.width || 0) || width,
          height: Number(reusable?.metadata?.height || 0) || height,
          queueRowsVisible: cache.rows.length,
          matchMethod: matchMethod || "existing-resolved",
          confidence: 1,
        });
        return;
      }
    }

    if (!rows.length) {
      const staged = await uploadToStorage(bytes, contentType, "captures", meta.rootTitle, meta.sourceTitle, fileKey, meta.sourceUrl);
      await upsertCapture(meta, staged.storagePath, contentType, width, height, bytes.length, "unmatched", 0);
      stats.noQueue += 1;
      stats.staged += 1;
      console.log(`STAGED UNMATCHED ${meta.fileName} alt=${JSON.stringify(meta.alt || "")} -> ${width}x${height}, ${(bytes.length / 1024).toFixed(1)} KB`);
      json(res, 200, { ok: true, status: "no_queue", staged: true, storagePath: staged.storagePath, fileName: meta.fileName, bytes: bytes.length, width, height, queueRowsVisible: cache.rows.length });
      return;
    }

    const stored = await uploadToStorage(bytes, contentType, "imports", meta.rootTitle, meta.sourceTitle, fileKey, meta.sourceUrl);
    await patchResolved(rows, stored, meta, contentType, width, height, bytes.length, confidence, matchMethod, inferredFileName);
    await upsertCapture(meta, stored.storagePath, contentType, width, height, bytes.length, "matched", rows.length, { inferredFileName, matchMethod, matchHint });
    stats.resolved += 1;
    console.log(`RESOLVED ${inferredFileName || meta.fileName} <- ${meta.fileName} [${matchMethod}] -> ${width}x${height}, ${(bytes.length / 1024).toFixed(1)} KB (${rows.length} queue rows)`);
    console.log(`  ${stored.storagePath}`);
    json(res, 200, { ok: true, status: "resolved", fileName: inferredFileName || meta.fileName, matchedRows: rows.length, storagePath: stored.storagePath, bytes: bytes.length, width, height, queueRowsVisible: cache.rows.length, matchMethod, matchHint, confidence });
  } catch (error) {
    stats.errors += 1;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`CAPTURE ERROR: ${message}`);
    json(res, 400, { ok: false, status: "error", error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log("Kpoparkive Namu Chrome capture helper v3");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log("Anonymous CDN images are matched back to queue filenames using alt/title, source page, and image type.");
  console.log("Matched captures -> wiki-media/imports/<root>/...");
  console.log("Unmatched captures -> wiki-media/captures/<root>/... + namu_capture_staging");
});
