import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const { parse } = createRequire(import.meta.url)("node-html-parser");
const ROOT = process.cwd();

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT, ".env.local"));
loadEnv(path.join(ROOT, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
const BUCKET = "wiki-media";
const MAX_BYTES = 32 * 1024 * 1024;
const sourceTitle = decodeURIComponent(process.argv[2] || "").normalize("NFKC").trim();

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");
if (!sourceTitle) throw new Error('Usage: node scripts/namu-dom-video-recover.mjs "리브(RESCENE)"');

function headers(extra = {}) {
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
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

function normalizeFileName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^파일:/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonical(value) {
  return normalizeFileName(value).toLowerCase();
}

function decodeMaybe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function fileNameFromHref(value) {
  const raw = decodeMaybe(String(value || ""));
  const match = raw.match(/(?:^|\/w\/)(?:파일|File):([^?#]+)/i);
  return match?.[1] ? normalizeFileName(match[1]) : "";
}

function absoluteNamuUrl(value, pageUrl) {
  if (!value || /^(?:data|blob):/i.test(value)) return "";
  try {
    const url = new URL(value, pageUrl);
    if (url.protocol !== "https:" || url.hostname !== "i.namu.wiki") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function nearbyFileName(video) {
  let current = video.parentNode;
  for (let depth = 0; current && depth < 5; depth += 1, current = current.parentNode) {
    const names = [...new Set(
      (current.querySelectorAll?.("a[href]") || [])
        .map((anchor) => fileNameFromHref(anchor.getAttribute("href") || ""))
        .filter(Boolean)
    )];
    if (names.length === 1) return names[0];
    if (names.length > 1) return "";
  }
  return "";
}

function safePart(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "asset";
}

async function upload(bytes, contentType, fileName, sourceUrl) {
  const hash = crypto.createHash("sha256")
    .update(`${sourceTitle}|${fileName}|${sourceUrl}`)
    .digest("hex")
    .slice(0, 16);
  const ext = contentType === "video/webm" ? "webm" : contentType === "video/quicktime" ? "mov" : "mp4";
  const storagePath = `imports/${safePart(sourceTitle)}/${safePart(fileName)}-${hash}.${ext}`;
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
  return {
    storagePath,
    publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`,
  };
}

async function main() {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
      `&source_title=eq.${encodeURIComponent(sourceTitle)}` +
      "&select=id,root_title,source_title,source_url,source_browser_article_html,source_namumark_meta&limit=1",
  );
  const doc = rows?.[0];
  if (!doc?.id || !doc?.source_browser_article_html) {
    console.log("DOM VIDEO RECOVERY: no captured browser DOM");
    process.exitCode = 3;
    return;
  }

  const missingFiles = new Set(
    (Array.isArray(doc.source_namumark_meta?.missingFiles) ? doc.source_namumark_meta.missingFiles : [])
      .map(canonical)
      .filter(Boolean)
  );
  if (!missingFiles.size) {
    console.log("DOM VIDEO RECOVERY: renderer reports no missing files");
    process.exitCode = 3;
    return;
  }

  const root = parse(String(doc.source_browser_article_html));
  const candidates = [];
  for (const video of root.querySelectorAll("video")) {
    const fileName = nearbyFileName(video);
    if (!fileName || !missingFiles.has(canonical(fileName))) continue;
    const urls = [
      video.getAttribute("src"),
      video.getAttribute("data-src"),
      ...video.querySelectorAll("source").flatMap((source) => [
        source.getAttribute("src"),
        source.getAttribute("data-src"),
      ]),
    ]
      .map((value) => absoluteNamuUrl(value, doc.source_url || `https://namu.wiki/w/${encodeURIComponent(sourceTitle)}`))
      .filter(Boolean);
    const sourceUrl = [...new Set(urls)][0] || "";
    if (!sourceUrl) continue;
    candidates.push({ fileName, sourceUrl });
  }

  if (!candidates.length) {
    console.log("DOM VIDEO RECOVERY: no missing file is represented by a captured Namu video");
    process.exitCode = 3;
    return;
  }

  let recovered = 0;
  for (const candidate of candidates) {
    console.log(`DOM VIDEO RECOVERY: fetching ${candidate.fileName}`);
    const response = await fetch(candidate.sourceUrl, {
      headers: {
        Referer: doc.source_url || `https://namu.wiki/w/${encodeURIComponent(sourceTitle)}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152 Safari/537.36",
        Accept: "video/mp4,video/webm,video/*;q=0.9,*/*;q=0.1",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      console.warn(`DOM VIDEO RECOVERY: HTTP ${response.status} for ${candidate.fileName}`);
      continue;
    }
    const contentType = String(response.headers.get("content-type") || "video/mp4").split(";", 1)[0].trim().toLowerCase();
    if (!contentType.startsWith("video/")) {
      console.warn(`DOM VIDEO RECOVERY: unexpected MIME ${contentType} for ${candidate.fileName}`);
      continue;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_BYTES) {
      console.warn(`DOM VIDEO RECOVERY: invalid size ${bytes.length} for ${candidate.fileName}`);
      continue;
    }

    const stored = await upload(bytes, contentType, candidate.fileName, candidate.sourceUrl);
    const metadata = {
      original_url: candidate.sourceUrl,
      browser_source_page: doc.source_url || null,
      content_type: contentType,
      media_type: "video",
      bytes: bytes.length,
      resolved_from: "captured-dom-video-direct",
      browser_capture_at: new Date().toISOString(),
      browser_match_method: "captured-dom-adjacent-file-link",
      resolution_error: null,
    };

    await db("source_asset_queue?on_conflict=source_document_id,asset_type,source_ref", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        source_document_id: doc.id,
        root_title: doc.root_title || sourceTitle,
        source_title: sourceTitle,
        asset_type: "image",
        source_ref: `파일:${candidate.fileName}`,
        label: candidate.fileName,
        provider: "captured-dom-video",
        role: "inline",
        status: "resolved",
        resolved_url: stored.publicUrl,
        storage_path: stored.storagePath,
        confidence: 0.999,
        metadata,
        updated_at: new Date().toISOString(),
      }),
    });

    await db("namu_capture_staging?on_conflict=root_title,canonical_key,source_url", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        root_title: doc.root_title || sourceTitle,
        source_title: sourceTitle,
        file_name: candidate.fileName,
        canonical_key: canonical(candidate.fileName),
        page_url: doc.source_url || `https://namu.wiki/w/${encodeURIComponent(sourceTitle)}`,
        source_url: candidate.sourceUrl,
        content_type: contentType,
        byte_length: bytes.length,
        width: 0,
        height: 0,
        storage_path: stored.storagePath,
        capture_status: "matched",
        matched_queue_rows: 1,
        captured_at: new Date().toISOString(),
        metadata: {
          semantic_file_name: candidate.fileName,
          media_type: "video",
          match_method: "captured-dom-adjacent-file-link",
        },
      }),
    });

    recovered += 1;
    console.log(`DOM VIDEO RECOVERED ${candidate.fileName} -> ${stored.storagePath} (${(bytes.length / 1024).toFixed(1)} KB)`);
  }

  if (!recovered) {
    process.exitCode = 3;
    return;
  }
  console.log(`DOM VIDEO RECOVERY COMPLETE: ${recovered} asset(s)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
