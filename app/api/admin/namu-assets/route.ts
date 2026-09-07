import { NextResponse } from "next/server";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const BUCKET = "wiki-media";

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
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9가-힣._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "asset";
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

async function uploadImage(url: string, rootTitle: string, sourceTitle: string) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(url, { headers: { "User-Agent": "KpoparkiveAssetResolver/0.1" }, redirect: "follow" });
  if (!response.ok) throw new Error(`image fetch ${response.status}`);
  const contentType = response.headers.get("content-type") || "image/jpeg";
  if (!contentType.startsWith("image/")) throw new Error(`not an image: ${contentType}`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("image exceeds 8 MB");
  const ext = extensionFor(contentType, url);
  const hash = await shortHash(url);
  const path = `imports/${safePart(rootTitle)}/${safePart(sourceTitle)}/${hash}.${ext}`;
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
    const body = await request.json() as { rootTitle?: string; batchSize?: number };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });
    const batchSize = Math.max(1, Math.min(Number(body.batchSize ?? 12), 30));

    const rows = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&status=eq.pending&select=id,source_document_id,source_title,asset_type,source_ref,label,provider,metadata&order=created_at.asc&limit=${batchSize}`) as Array<{
      id: string; source_document_id: string; source_title: string; asset_type: string; source_ref: string; label: string | null; provider: string | null; metadata: Record<string, unknown>;
    }>;

    const resolved: string[] = [];
    const unresolved: { id: string; ref: string; reason: string }[] = [];

    for (const row of rows) {
      try {
        let patch: Record<string, unknown> = { status: "resolved", updated_at: new Date().toISOString() };
        if (row.asset_type === "image") {
          const directUrl = /^https?:\/\//i.test(row.source_ref) ? row.source_ref : typeof row.metadata?.url === "string" ? row.metadata.url : null;
          if (!directUrl) throw new Error("source image is a file reference; web enrichment required");
          const uploaded = await uploadImage(directUrl, rootTitle, row.source_title);
          patch = { ...patch, resolved_url: uploaded.publicUrl, storage_path: uploaded.path, confidence: 1, metadata: { ...row.metadata, content_type: uploaded.contentType, bytes: uploaded.bytes } };
        } else if (row.asset_type === "video") {
          const videoId = typeof row.metadata?.video_id === "string" ? row.metadata.video_id : null;
          patch = { ...patch, resolved_url: row.provider === "youtube" && videoId ? `https://www.youtube.com/embed/${videoId}` : row.source_ref, confidence: 1 };
        } else if (row.asset_type === "external_link") {
          patch = { ...patch, resolved_url: row.source_ref, confidence: 1 };
        } else if (row.asset_type === "internal_link") {
          const sources = await db(`source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(row.source_ref)}&select=generated_document_id&limit=1`) as { generated_document_id: string | null }[];
          const generatedId = sources[0]?.generated_document_id;
          if (!generatedId) throw new Error("target document not generated yet");
          const docs = await db(`documents?id=eq.${generatedId}&select=slug,status&limit=1`) as { slug: string; status: string }[];
          if (!docs[0]) throw new Error("generated document missing");
          patch = { ...patch, resolved_url: docs[0].status === "published" ? `/wiki/${docs[0].slug}` : `/admin/drafts/${docs[0].slug}`, confidence: 1 };
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
    return NextResponse.json({ ok: true, rootTitle, processed: rows.length, resolved: resolved.length, unresolved, remaining: remaining.length });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown asset resolution error" }, { status: 500 });
  }
}
