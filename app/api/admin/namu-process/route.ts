import { NextResponse } from "next/server";
import { parseNamuHtml, type ParsedBlock } from "../../../../lib/namuParser";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const PARSE_VERSION = "namu-html-v2";

type AssetQueueRow = {
  source_document_id: string;
  root_title: string;
  source_title: string;
  asset_type: "image" | "video" | "external_link" | "internal_link";
  source_ref: string;
  label: string | null;
  provider: string | null;
  role: string | null;
  metadata: Record<string, unknown>;
};

function headers(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra };
}

async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...headers(), ...(init.headers || {}) }, cache: "no-store" });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function queueRows(documentId: string, rootTitle: string, sourceTitle: string, blocks: ParsedBlock[]) {
  const rows: AssetQueueRow[] = [];
  for (const block of blocks) {
    if (block.type === "image") rows.push({ source_document_id: documentId, root_title: rootTitle, source_title: sourceTitle, asset_type: "image", source_ref: block.source_ref, label: block.alt || null, provider: block.url ? "direct" : "namu_file", role: block.role || null, metadata: { url: block.url || null } });
    else if (block.type === "video") rows.push({ source_document_id: documentId, root_title: rootTitle, source_title: sourceTitle, asset_type: "video", source_ref: block.url, label: block.label || null, provider: block.provider, role: null, metadata: { video_id: block.video_id || null } });
    else if (block.type === "external-link") rows.push({ source_document_id: documentId, root_title: rootTitle, source_title: sourceTitle, asset_type: "external_link", source_ref: block.url, label: block.label, provider: (() => { try { return new URL(block.url).hostname; } catch { return "external"; } })(), role: null, metadata: {} });
    else if (block.type === "internal-link") rows.push({ source_document_id: documentId, root_title: rootTitle, source_title: sourceTitle, asset_type: "internal_link", source_ref: block.target, label: block.label, provider: "namu", role: null, metadata: {} });
  }
  return rows;
}

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { rootTitle?: string; force?: boolean };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const rows = await db(`source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&select=id,source_title,raw_html,source_hash,parse_version,parsed_at&order=crawl_depth.asc,source_title.asc`) as { id: string; source_title: string; raw_html: string; source_hash: string; parse_version: string | null; parsed_at: string | null }[];
    if (!rows.length) return NextResponse.json({ error: `No source documents found for ${rootTitle}` }, { status: 404 });

    const results: { title: string; status: string; sections: number; blocks: number; queuedAssets: number }[] = [];
    for (const row of rows) {
      if (!body.force && row.parse_version === PARSE_VERSION && row.parsed_at) {
        results.push({ title: row.source_title, status: "unchanged", sections: 0, blocks: 0, queuedAssets: 0 });
        continue;
      }

      try {
        const sections = parseNamuHtml(row.raw_html || "");
        const allBlocks = sections.flatMap((section) => section.content);
        const assets = queueRows(row.id, rootTitle, row.source_title, allBlocks);

        await db(`source_documents?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ parsed_sections: sections, parse_version: PARSE_VERSION, parsed_at: new Date().toISOString(), translation_status: "ready", updated_at: new Date().toISOString() }) });

        if (assets.length) {
          await db("source_asset_queue?on_conflict=source_document_id,asset_type,source_ref", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(assets) });
        }

        results.push({ title: row.source_title, status: "parsed", sections: sections.length, blocks: allBlocks.length, queuedAssets: assets.length });
      } catch (error) {
        await db(`source_documents?id=eq.${row.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ translation_status: "failed", updated_at: new Date().toISOString() }) });
        results.push({ title: row.source_title, status: error instanceof Error ? error.message : "parse error", sections: 0, blocks: 0, queuedAssets: 0 });
      }
    }

    return NextResponse.json({ ok: true, rootTitle, parseVersion: PARSE_VERSION, documents: results.length, parsed: results.filter((r) => r.status === "parsed").length, unchanged: results.filter((r) => r.status === "unchanged").length, totalSections: results.reduce((sum, r) => sum + r.sections, 0), totalBlocks: results.reduce((sum, r) => sum + r.blocks, 0), totalQueuedAssets: results.reduce((sum, r) => sum + r.queuedAssets, 0), results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown parse error" }, { status: 500 });
  }
}
