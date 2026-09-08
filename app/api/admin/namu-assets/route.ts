import { NextResponse } from "next/server";
import { parse } from "node-html-parser";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const BUCKET = "wiki-media";
const NAMU_MIRROR = "https://www.namu.moe";

function dbHeaders(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...dbHeaders(), ...(init.headers || {}) }, cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function safePart(value: string) {
  const ascii = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return ascii || "asset";
}

async function shortHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extensionFor(contentType: string, url: string) {
  if (/webp/i.test(contentType)) return "webp";
  if (/png/i.test(contentType)) return "png";
  if (/gif/i.test(contentType)) return "gif";
  if (/svg/i.test(contentType)) return "svg";
  if (/jpe?g/i.test(contentType)) return "jpg";
  return url.match(/\.(webp|png|gif|svg|jpe?g)(?:\?|$)/i)?.[1]?.replace("jpeg", "jpg") || "jpg";
}

function normalizeDirectUrl(value: unknown) {
  if (typeof value !== "string") return null;
  const url = value.trim();
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `${NAMU_MIRROR}${url}`;
  return /^https?:\/\//i.test(url) ? url : null;
}

function normalizedFileName(value: string) {
  return value.normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function imageFileNameFromAlt(value: string) {
  const alt = value.normalize("NFKC").trim();
  const explicit = alt.match(/^(?:파일|File):(.+)$/i)?.[1]?.trim();
  if (explicit) return explicit;
  return /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(alt) ? alt : null;
}

function extractFileMap(rawHtml: string) {
  const root = parse(rawHtml || "");
  const map = new Map<string, string>();
  for (const image of root.querySelectorAll("img")) {
    const fileName = imageFileNameFromAlt(image.getAttribute("alt") || "");
    if (!fileName) continue;
    const key = normalizedFileName(fileName);
    const rawUrl = image.getAttribute("data-original") || image.getAttribute("data-src") || image.getAttribute("src") || "";
    const url = normalizeDirectUrl(rawUrl);
    if (key && url && !map.has(key)) map.set(key, url);
  }
  return map;
}

async function fetchMirrorDocumentFileMap(title: string) {
  const response = await fetch(`${NAMU_MIRROR}/w/${encodeURIComponent(title)}`, {
    cache: "no-store",
    redirect: "follow",
    headers: { "User-Agent": "KpoparkiveAssetResolver/0.8 (+https://kpoparkive.vercel.app)", Accept: "text/html" },
  });
  if (!response.ok) throw new Error(`linked mirror fetch ${response.status}: ${title}`);
  return extractFileMap(await response.text());
}

/**
 * Article image references are never discarded as "decorative" at import time.
 * Provider icons, broadcaster logos, detail icons and template images are part
 * of the rendered Namu document and must remain resolvable. Presentation code
 * may choose to hide an asset later, but the importer must preserve it first.
 */
function isNoiseImageRef(_value: string) {
  return false;
}

function looksGenericWikiTarget(target: string) {
  return /^(?:\d{4}년|\d{1,2}월(?:\s*\d{1,2}일)?|SBS|MBC|KBS|JTBC|tvN|엠넷|Mnet|유튜브|YouTube|Instagram|X|트위터|OST|가수|아이돌|대한민국|일본|미국)$/i.test(target)
    || /(?:^|\/)(?:참가자|\d+회|FINAL)$/i.test(target)
    || /^\d{1,2}월\s*\d{1,2}일$/.test(target);
}

function isRootAffinityTarget(target: string, rootTitle: string) {
  return target === rootTitle || target.startsWith(`${rootTitle}/`) || target.includes(`(${rootTitle})`) || target.includes(`[${rootTitle}]`);
}

async function classifyInternalTarget(target: string, rootTitle: string) {
  const sources = await db(`source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(target)}&select=generated_document_id,root_title&limit=1`) as { generated_document_id: string | null; root_title: string | null }[];
  const source = sources[0];
  if (source?.generated_document_id) {
    const docs = await db(`documents?id=eq.${source.generated_document_id}&select=slug,status&limit=1`) as { slug: string; status: string }[];
    if (docs[0]) return { disposition: "internal" as const, url: docs[0].status === "published" ? `/wiki/${docs[0].slug}` : `/admin/drafts/${docs[0].slug}`, confidence: 1 };
  }
  if (source && source.root_title === rootTitle) return { disposition: "internal_pending" as const, confidence: 0.95, reason: "target belongs to imported group cluster but draft has not been generated yet" };
  if (isRootAffinityTarget(target, rootTitle)) return { disposition: "crawl_candidate" as const, confidence: 0.9, reason: "target is explicitly qualified by the root group" };
  if (looksGenericWikiTarget(target)) return { disposition: "plain_text" as const, confidence: 0.98, reason: "generic/date/broadcaster navigation target does not need a Kpoparkive document" };
  return { disposition: "plain_text" as const, confidence: 0.82, reason: "background reference outside the imported group cluster" };
}

async function uploadImage(url: string, rootTitle: string, sourceTitle: string) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(url, { headers: { "User-Agent": "KpoparkiveAssetResolver/0.8", Referer: `${NAMU_MIRROR}/` }, redirect: "follow" });
  if (!response.ok) throw new Error(`image fetch ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error(`not an image: ${contentType}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("image exceeds 8 MB");
  const ext = extensionFor(contentType, url);
  const hash = await shortHash(`${rootTitle}|${sourceTitle}|${url}`);
  const path = `imports/${safePart(rootTitle)}/${safePart(sourceTitle)}-${hash}.${ext}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`storage upload ${upload.status}: ${await upload.text()}`);
  return { path, publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`, contentType, bytes: bytes.byteLength };
}

export async function GET(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rootTitle = new URL(request.url).searchParams.get("rootTitle")?.trim();
  if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });
  const rows = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&status=in.(pending,unresolved)&select=id,source_title,asset_type,source_ref,label,provider,status,resolved_url,storage_path,metadata&order=source_title.asc,asset_type.asc&limit=500`);
  return NextResponse.json({ ok: true, rootTitle, assets: rows });
}

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const body = await request.json() as { rootTitle?: string; batchSize?: number; retryUnresolved?: boolean };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });
    const batchSize = Math.max(1, Math.min(Number(body.batchSize ?? 12), 30));
    const statusFilter = body.retryUnresolved ? "in.(pending,unresolved)" : "eq.pending";
    const rows = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&status=${statusFilter}&select=id,source_document_id,source_title,asset_type,source_ref,label,provider,metadata&order=created_at.asc&limit=${batchSize}`) as Array<{
      id: string; source_document_id: string; source_title: string; asset_type: string; source_ref: string; label: string | null; provider: string | null; metadata: Record<string, unknown>;
    }>;

    const resolved: string[] = [];
    const skipped: string[] = [];
    const unresolved: { id: string; ref: string; reason: string }[] = [];
    const fileMaps = new Map<string, Map<string, string>>();
    const linkedMaps = new Map<string, Map<string, string>>();

    async function mirrorFileUrl(documentId: string, sourceRef: string) {
      let map = fileMaps.get(documentId);
      if (!map) {
        const docs = await db(`source_documents?id=eq.${documentId}&select=raw_html&limit=1`) as { raw_html: string }[];
        map = extractFileMap(docs[0]?.raw_html || "");
        fileMaps.set(documentId, map);
      }
      return map.get(normalizedFileName(sourceRef)) || null;
    }

    async function linkedTargetFileUrl(target: unknown, sourceRef: string) {
      if (typeof target !== "string" || !target.trim()) return null;
      const cleanTarget = target.trim().replace(/#.*$/, "");
      let map = linkedMaps.get(cleanTarget);
      if (!map) {
        map = await fetchMirrorDocumentFileMap(cleanTarget);
        linkedMaps.set(cleanTarget, map);
      }
      return map.get(normalizedFileName(sourceRef)) || null;
    }

    for (const row of rows) {
      try {
        let patch: Record<string, unknown> = { status: "resolved", updated_at: new Date().toISOString() };
        if (row.asset_type === "image") {
          if (isNoiseImageRef(`${row.source_ref} ${row.label || ""}`)) {
            await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "skipped", confidence: 1, metadata: { ...row.metadata, skip_reason: "source presentation excluded asset" }, updated_at: new Date().toISOString() }) });
            skipped.push(row.id);
            continue;
          }

          const fileRef = row.label || row.source_ref;
          const enrichedUrl = normalizeDirectUrl(row.metadata?.enrichment_url);
          const mirrorMappedUrl = await mirrorFileUrl(row.source_document_id, fileRef);
          const linkedMappedUrl = enrichedUrl || mirrorMappedUrl ? null : await linkedTargetFileUrl(row.metadata?.linked_target, fileRef);
          const directUrl = enrichedUrl || mirrorMappedUrl || linkedMappedUrl || normalizeDirectUrl(row.source_ref) || normalizeDirectUrl(row.metadata?.url);
          if (!directUrl) throw new Error("source image file is not recoverable from current or linked mirror document");
          const uploaded = await uploadImage(directUrl, rootTitle, row.source_title);
          const resolvedFrom = enrichedUrl ? "raw-file-map" : mirrorMappedUrl ? "mirror-img-alt" : linkedMappedUrl ? "linked-document-img-alt" : "source";
          patch = {
            ...patch,
            resolved_url: uploaded.publicUrl,
            storage_path: uploaded.path,
            confidence: linkedMappedUrl ? 0.99 : enrichedUrl || mirrorMappedUrl ? 1 : 0.9,
            metadata: { ...row.metadata, original_url: directUrl, content_type: uploaded.contentType, bytes: uploaded.bytes, resolved_from: resolvedFrom },
          };
        } else if (row.asset_type === "video") {
          const videoId = typeof row.metadata?.video_id === "string" ? row.metadata.video_id : null;
          patch = { ...patch, resolved_url: row.provider === "youtube" && videoId ? `https://www.youtube.com/embed/${videoId}` : row.source_ref, confidence: 1 };
        } else if (row.asset_type === "external_link") {
          patch = { ...patch, resolved_url: row.source_ref, confidence: 1 };
        } else if (row.asset_type === "internal_link") {
          const classification = await classifyInternalTarget(row.source_ref, rootTitle);
          if (classification.disposition === "internal") patch = { ...patch, resolved_url: classification.url, confidence: classification.confidence, metadata: { ...row.metadata, link_disposition: classification.disposition } };
          else if (classification.disposition === "internal_pending" || classification.disposition === "crawl_candidate") throw new Error(classification.reason);
          else {
            await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "skipped", confidence: classification.confidence, metadata: { ...row.metadata, link_disposition: classification.disposition, skip_reason: classification.reason }, updated_at: new Date().toISOString() }) });
            skipped.push(row.id);
            continue;
          }
        }
        await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
        resolved.push(row.id);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "resolution failed";
        await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "unresolved", metadata: { ...row.metadata, resolution_error: reason }, updated_at: new Date().toISOString() }) });
        unresolved.push({ id: row.id, ref: row.source_ref, reason });
      }
    }

    const remaining = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&status=eq.pending&select=id`) as { id: string }[];
    return NextResponse.json({ ok: true, rootTitle, processed: rows.length, resolved: resolved.length, skipped: skipped.length, unresolved, remaining: remaining.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown asset resolution error" }, { status: 500 });
  }
}
