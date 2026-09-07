import { NextResponse } from "next/server";
import type { ParsedSection } from "../../../../lib/namuParser";
import { hydrateNamuSections } from "../../../../lib/namuHydrate";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;

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

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as { rootTitle?: string };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const sources = await db(`source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&generated_document_id=not.is.null&translated_sections=not.is.null&select=id,source_title,generated_document_id,translated_sections&order=crawl_depth.asc,source_title.asc`) as Array<{
      id: string;
      source_title: string;
      generated_document_id: string;
      translated_sections: ParsedSection[];
    }>;

    const results: Array<{ title: string; documentId: string; sections: number; resolvedAssets: number; skippedAssets: number; placeholders: number }> = [];

    for (const source of sources) {
      const assets = await db(`source_asset_queue?source_document_id=eq.${source.id}&select=asset_type,source_ref,status,resolved_url,storage_path,metadata`) as Array<{
        asset_type: string;
        source_ref: string;
        status: string;
        resolved_url: string | null;
        storage_path: string | null;
        metadata?: Record<string, unknown>;
      }>;

      const hydrated = hydrateNamuSections(source.translated_sections || [], assets);
      await db(`document_sections?document_id=eq.${source.generated_document_id}`, { method: "DELETE" });
      if (hydrated.sections.length) {
        await db("document_sections", {
          method: "POST",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify(hydrated.sections.map((section) => ({
            document_id: source.generated_document_id,
            section_key: section.section_key,
            heading: section.heading,
            heading_level: section.heading_level,
            sort_order: section.sort_order,
            content: section.content,
          }))),
        });
      }

      results.push({
        title: source.source_title,
        documentId: source.generated_document_id,
        sections: hydrated.sections.length,
        resolvedAssets: hydrated.resolvedAssets,
        skippedAssets: hydrated.skippedAssets,
        placeholders: hydrated.placeholders,
      });
    }

    return NextResponse.json({
      ok: true,
      rootTitle,
      drafts: results.length,
      resolvedAssets: results.reduce((sum, row) => sum + row.resolvedAssets, 0),
      skippedAssets: results.reduce((sum, row) => sum + row.skippedAssets, 0),
      placeholders: results.reduce((sum, row) => sum + row.placeholders, 0),
      results,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown hydration error" }, { status: 500 });
  }
}
