import { detectNamuImageContentType, readNamuImageBytes } from "../../../../lib/namuImageBytes";
import { discoverNamuFilePageCandidates } from "../../../../lib/namuFilePageAssets";
import { extractRenderedFileMap } from "../../../../lib/namuRawSource";
import { expandNamuRemoteCandidates, findNamuAssetCandidates, isNamuNonPayloadAssetUrl } from "../../../../lib/namuStoredAssets";
import { hydrateNamuStoredMedia } from "../../../../lib/namuStoredMediaHydrate";
import { NextResponse } from "next/server";
export const maxDuration = 60;

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
  if (/avif/i.test(contentType)) return "avif";
  if (/svg/i.test(contentType)) return "svg";
  if (/jpe?g/i.test(contentType)) return "jpg";
  return url.match(/\.(webp|png|gif|avif|svg|jpe?g)(?:\?|$)/i)?.[1]?.replace("jpeg", "jpg") || "jpg";
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

function canonicalFileKey(value: string) {
  return normalizedFileName(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function expandCandidateList(values: Array<string | null | undefined>) {
  const output: string[] = [];
  for (const value of values) {
    if (!value) continue;
    for (const candidate of expandNamuRemoteCandidates(value)) if (!output.includes(candidate)) output.push(candidate);
  }
  return output;
}

function extractFileMap(rawHtml: string) {
  return new Map(Object.entries(extractRenderedFileMap(rawHtml)));
}

async function fetchMirrorDocumentFileMap(title: string) {
  const response = await fetch(`${NAMU_MIRROR}/w/${encodeURIComponent(title)}`, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
    headers: { "User-Agent": "KpoparkiveAssetResolver/1.0 (+https://kpoparkive.vercel.app)", Accept: "text/html" },
  });
  if (!response.ok) throw new Error(`linked mirror fetch ${response.status}: ${title}`);
  return extractFileMap(await response.text());
}

/** Preserve every source image at import time; presentation can hide it later. */
function isNoiseImageRef(_value: string) { return false; }

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

async function downloadImage(url: string) {
  if (isNamuNonPayloadAssetUrl(url)) throw new Error("mirror navigation/placeholder URL is not an image payload");
  const browserUa = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
  const profiles: Record<string, string>[] = [
    { "User-Agent": browserUa, Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8", Referer: `${NAMU_MIRROR}/` },
    { "User-Agent": browserUa, Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8" },
    { "User-Agent": "KpoparkiveAssetResolver/1.0 (+https://kpoparkive.vercel.app)", Accept: "image/*,*/*;q=0.5" },
  ];
  const errors: string[] = [];
  for (const headers of profiles) {
    try {
      const response = await fetch(url, { headers, cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(7000) });
      if (isNamuNonPayloadAssetUrl(response.url)) throw new Error("redirected to mirror placeholder/navigation URL");
      const bytes = await readNamuImageBytes(response, url);
      const contentType = detectNamuImageContentType(bytes, response.headers.get("content-type") || "", response.url || url);
      if (!contentType) throw new Error("unsupported image bytes");
      return { bytes, contentType };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "download failed");
    }
  }
  throw new Error([...new Set(errors)].join(" / "));
}

async function uploadImage(url: string, rootTitle: string, sourceTitle: string) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const { bytes, contentType } = await downloadImage(url);
  const ext = extensionFor(contentType, url);
  const hash = await shortHash(`${rootTitle}|${url}`);
  const path = `imports/${safePart(rootTitle)}/${safePart(sourceTitle)}-${hash}.${ext}`;
  const upload = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, apikey: SERVICE_ROLE_KEY, "Content-Type": contentType, "x-upsert": "true" },
    body: bytes,
    signal: AbortSignal.timeout(10000),
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
    const body = await request.json() as { rootTitle?: string; batchSize?: number; retryUnresolved?: boolean; assetType?: "image" };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });
    const requestedSize = Number(body.batchSize ?? 6);
    if (!Number.isFinite(requestedSize)) return NextResponse.json({ error: "Invalid batchSize" }, { status: 400 });
    const batchSize = Math.max(1, Math.min(Math.floor(requestedSize), 12));
    const startedAt = Date.now();
    const reusedStoredMedia = await hydrateNamuStoredMedia(db, rootTitle, SUPABASE_URL);
    const statusFilter = body.retryUnresolved ? "in.(pending,unresolved)" : "eq.pending";
    const rows = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&status=${statusFilter}${body.assetType === "image" ? "&asset_type=eq.image" : ""}&select=id,source_document_id,source_title,asset_type,source_ref,label,provider,metadata&order=updated_at.asc.nullsfirst,id.asc&limit=${batchSize}`) as Array<{
      id: string; source_document_id: string; source_title: string; asset_type: string; source_ref: string; label: string | null; provider: string | null; metadata: Record<string, unknown>;
    }>;

    const resolved: string[] = [];
    const skipped: string[] = [];
    const unresolved: { id: string; ref: string; reason: string }[] = [];
    const fileMaps = new Map<string, Map<string, string>>();
    const linkedMaps = new Map<string, Map<string, string>>();
    const clusterDocs = await db(`source_documents?root_title=eq.${encodeURIComponent(rootTitle)}&select=raw_html`) as { raw_html: string }[];
    const clusterMaps = clusterDocs.map(doc => extractRenderedFileMap(doc.raw_html || ""));
    const uploadedUrls = new Map<string, Awaited<ReturnType<typeof uploadImage>>>();
    const uploadedFiles = new Map<string, Awaited<ReturnType<typeof uploadImage>>>();
    const failedUrls = new Map<string, string>();
    const filePageCache = new Map<string, string[]>();
    const clusterImageRows = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image&select=id,source_ref,label,status,resolved_url,storage_path,metadata&limit=3000`) as Array<{
      id: string; source_ref: string; label: string | null; status: string; resolved_url: string | null; storage_path: string | null; metadata: Record<string, unknown> | null;
    }>;

    // Never let a previously poisoned row seed cluster-wide reuse. A wrong
    // placeholder otherwise propagates to every occurrence of the same filename.
    const poisonedPaths = new Set<string>();
    for (const asset of clusterImageRows) {
      for (const value of [asset.metadata?.original_url, asset.metadata?.enrichment_url]) {
        if (typeof value === "string" && isNamuNonPayloadAssetUrl(value) && asset.storage_path) poisonedPaths.add(asset.storage_path);
      }
    }
    const resolvedByFile = new Map<string, { resolved_url: string; storage_path: string | null }>();
    for (const asset of clusterImageRows) {
      if (asset.status !== "resolved" || !asset.resolved_url) continue;
      if (asset.storage_path && poisonedPaths.has(asset.storage_path)) continue;
      const original = asset.metadata?.original_url;
      const enrichment = asset.metadata?.enrichment_url;
      if ((typeof original === "string" && isNamuNonPayloadAssetUrl(original))
        || (typeof enrichment === "string" && isNamuNonPayloadAssetUrl(enrichment))) continue;
      const key = canonicalFileKey(asset.label || asset.source_ref);
      if (key && !resolvedByFile.has(key)) resolvedByFile.set(key, { resolved_url: asset.resolved_url, storage_path: asset.storage_path });
    }

    async function mirrorFileUrl(documentId: string, sourceRef: string) {
      let map = fileMaps.get(documentId);
      if (!map) {
        const docs = await db(`source_documents?id=eq.${documentId}&select=raw_html&limit=1`) as { raw_html: string }[];
        map = extractFileMap(docs[0]?.raw_html || "");
        fileMaps.set(documentId, map);
      }
      const result = map.get(normalizedFileName(sourceRef)) || null;
      return result && !isNamuNonPayloadAssetUrl(result) ? result : null;
    }

    async function linkedTargetFileUrl(target: unknown, sourceRef: string) {
      if (typeof target !== "string" || !target.trim()) return null;
      const cleanTarget = target.trim().replace(/#.*$/, "");
      let map = linkedMaps.get(cleanTarget);
      if (!map) {
        map = await fetchMirrorDocumentFileMap(cleanTarget);
        linkedMaps.set(cleanTarget, map);
      }
      const result = map.get(normalizedFileName(sourceRef)) || null;
      return result && !isNamuNonPayloadAssetUrl(result) ? result : null;
    }

    async function filePageCandidates(sourceRef: string) {
      const key = canonicalFileKey(sourceRef);
      const cached = filePageCache.get(key);
      if (cached) return cached;
      const discovered = await discoverNamuFilePageCandidates(normalizedFileName(sourceRef));
      filePageCache.set(key, discovered);
      return discovered;
    }

    for (const row of rows) {
      if (Date.now() - startedAt > 40000) break;
      try {
        let patch: Record<string, unknown> = { status: "resolved", updated_at: new Date().toISOString() };
        if (row.asset_type === "image") {
          if (isNoiseImageRef(`${row.source_ref} ${row.label || ""}`)) {
            await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ status: "skipped", confidence: 1, metadata: { ...row.metadata, skip_reason: "source presentation excluded asset" }, updated_at: new Date().toISOString() }) });
            skipped.push(row.id);
            continue;
          }

          const fileKey = canonicalFileKey(row.label || row.source_ref);
          const reused = resolvedByFile.get(fileKey);
          if (reused) {
            patch = { ...patch, resolved_url: reused.resolved_url, storage_path: reused.storage_path, confidence: 1, metadata: { ...row.metadata, resolved_from: "root-cluster-resolved-image", resolution_error: null } };
            await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(patch) });
            resolved.push(row.id);
            continue;
          }

          const refs = [row.source_ref, row.label || ""].filter(Boolean);
          const local = await mirrorFileUrl(row.source_document_id, row.label || row.source_ref);
          const directSeeds = [
            normalizeDirectUrl(row.metadata?.enrichment_url), local,
            ...findNamuAssetCandidates(refs, clusterMaps),
            normalizeDirectUrl(row.source_ref), normalizeDirectUrl(row.metadata?.url),
          ].filter((url): url is string => Boolean(url) && !isNamuNonPayloadAssetUrl(url));
          const candidates = expandCandidateList(directSeeds);
          const errors: string[] = [];
          let uploaded = uploadedFiles.get(fileKey);
          let directUrl = "";
          const tryCandidates = async (urls: string[]) => {
            for (const url of urls) {
              if (uploaded || Date.now() - startedAt > 50000) break;
              if (isNamuNonPayloadAssetUrl(url)) continue;
              const priorFailure = failedUrls.get(url);
              if (priorFailure) { errors.push(`${url}: ${priorFailure}`); continue; }
              try {
                uploaded = uploadedUrls.get(url) || await uploadImage(url, rootTitle, row.source_title);
                uploadedUrls.set(url, uploaded);
                uploadedFiles.set(fileKey, uploaded);
                directUrl = url;
              } catch (error) {
                const reason = error instanceof Error ? error.message : "download failed";
                failedUrls.set(url, reason);
                errors.push(`${url}: ${reason}`);
              }
            }
          };
          if (!uploaded) await tryCandidates(candidates);

          if (!uploaded && Date.now() - startedAt < 39000) {
            try {
              const linked = await linkedTargetFileUrl(row.metadata?.linked_target, row.label || row.source_ref);
              if (linked) await tryCandidates(expandCandidateList([linked]).filter(url => !candidates.includes(url)));
            } catch (error) { errors.push(error instanceof Error ? error.message : "linked document failed"); }
          }

          if (!uploaded && Date.now() - startedAt < 36000) {
            try {
              const discovered = await filePageCandidates(row.label || row.source_ref);
              await tryCandidates(discovered.filter(url => !candidates.includes(url)));
            } catch (error) { errors.push(error instanceof Error ? error.message : "file-page discovery failed"); }
          }

          if (!uploaded) throw new Error(errors.slice(-8).join("; ") || "No downloadable image candidate found");
          patch = {
            ...patch,
            resolved_url: uploaded.publicUrl,
            storage_path: uploaded.path,
            confidence: 0.99,
            metadata: { ...row.metadata, original_url: directUrl, content_type: uploaded.contentType, bytes: uploaded.bytes, resolved_from: "storage-pinned-namu-download", resolution_error: null },
          };
          resolvedByFile.set(fileKey, { resolved_url: uploaded.publicUrl, storage_path: uploaded.path });
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
    return NextResponse.json({
      ok: true, rootTitle,
      processed: resolved.length + skipped.length + unresolved.length,
      reusedStoredMedia,
      resolved: resolved.length,
      skipped: skipped.length,
      unresolved,
      remaining: remaining.length,
      cachedFailures: failedUrls.size,
      filePageLookups: filePageCache.size,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown asset resolution error" }, { status: 500 });
  }
}
