import { NextResponse } from "next/server";
import type { ParsedSection } from "../../../../lib/namuParser";
import { hydrateNamuSections } from "../../../../lib/namuHydrate";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const TRANSLATION_VERSION = "assistant-en-v1";

function headers(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(path: string, init: RequestInit = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function slugify(value: string) {
  const ascii = value.normalize("NFKC").toLowerCase()
    .replace(/\(rescene\)/g, "")
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `mirror-${ascii || "document"}`;
}

async function upsertDraft(row: {
  id: string;
  source_title: string;
  source_url: string;
  source_hash: string;
  translated_title: string;
  translated_sections: ParsedSection[];
  crawl_depth: number;
}, rootGeneratedId: string | null) {
  const slug = slugify(row.source_title);
  const existing = await db(`documents?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1`) as { id: string }[];
  let documentId = existing[0]?.id || null;
  const payload = {
    slug,
    title: row.translated_title,
    document_type: row.crawl_depth === 0 ? "group" : "other",
    parent_document_id: row.crawl_depth === 0 ? null : rootGeneratedId,
    summary: `English localization draft sourced from ${row.source_title}.`,
    accent_color: "#ff62c7",
    status: "draft",
    source_language: "ko",
    locale: "en",
    source_url: row.source_url,
    source_revision: row.source_hash,
    updated_at: new Date().toISOString(),
  };

  if (documentId) {
    await db(`documents?id=eq.${documentId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(payload) });
  } else {
    const inserted = await db("documents", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(payload) }) as { id: string }[];
    documentId = inserted[0].id;
  }

  const assets = await db(`source_asset_queue?source_document_id=eq.${row.id}&select=asset_type,source_ref,status,resolved_url,storage_path,metadata`) as Array<{
    asset_type: string;
    source_ref: string;
    status: string;
    resolved_url: string | null;
    storage_path: string | null;
    metadata?: Record<string, unknown>;
  }>;
  const hydrated = hydrateNamuSections(row.translated_sections, assets);

  await db(`document_sections?document_id=eq.${documentId}`, { method: "DELETE" });
  if (hydrated.sections.length) {
    await db("document_sections", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(hydrated.sections.map((section) => ({
        document_id: documentId,
        section_key: section.section_key,
        heading: section.heading,
        heading_level: section.heading_level,
        sort_order: section.sort_order,
        content: section.content,
      }))),
    });
  }

  await db(`source_documents?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      generated_document_id: documentId,
      generation_status: "draft",
      updated_at: new Date().toISOString(),
    }),
  });
  return { documentId, slug, hydrated };
}

export async function GET(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const rootTitle = new URL(request.url).searchParams.get("rootTitle")?.trim();
  if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });
  const rows = await db(
    `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&translation_status=eq.ready&select=id,source_title,crawl_depth,parsed_sections&order=crawl_depth.asc,source_title.asc`,
  );
  return NextResponse.json({ ok: true, rootTitle, translationVersion: TRANSLATION_VERSION, queue: rows });
}

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as {
      rootTitle?: string;
      translations?: { sourceTitle: string; title: string; sections: ParsedSection[] }[];
    };
    const rootTitle = String(body.rootTitle || "").trim();
    const translations = Array.isArray(body.translations) ? body.translations : [];
    if (!rootTitle || !translations.length) {
      return NextResponse.json({ error: "rootTitle and translations are required" }, { status: 400 });
    }

    const sourceRows = await db(
      `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&select=id,source_title,source_url,source_hash,crawl_depth,generated_document_id&order=crawl_depth.asc,source_title.asc`,
    ) as { id: string; source_title: string; source_url: string; source_hash: string; crawl_depth: number; generated_document_id: string | null }[];
    if (!sourceRows.length) return NextResponse.json({ error: `No source documents found for ${rootTitle}` }, { status: 404 });

    const translatedMap = new Map(translations.map((item) => [item.sourceTitle, item]));
    const applied: string[] = [];
    for (const row of sourceRows) {
      const translated = translatedMap.get(row.source_title);
      if (!translated?.sections?.length) continue;
      await db(`source_documents?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          translated_title: translated.title,
          translated_sections: translated.sections,
          translation_version: TRANSLATION_VERSION,
          translated_at: new Date().toISOString(),
          translation_status: "translated",
          updated_at: new Date().toISOString(),
        }),
      });
      applied.push(row.source_title);
    }

    const translatedRows = await db(
      `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&translation_version=eq.${TRANSLATION_VERSION}&select=id,source_title,source_url,source_hash,crawl_depth,translated_title,translated_sections,generated_document_id&order=crawl_depth.asc,source_title.asc`,
    ) as { id: string; source_title: string; source_url: string; source_hash: string; crawl_depth: number; translated_title: string; translated_sections: ParsedSection[]; generated_document_id: string | null }[];

    let rootGeneratedId = translatedRows.find((row) => row.crawl_depth === 0)?.generated_document_id || null;
    const generated: { title: string; slug: string; resolvedAssets: number; skippedAssets: number; placeholders: number }[] = [];
    for (const row of translatedRows) {
      if (!row.translated_title || !row.translated_sections?.length) continue;
      if (row.crawl_depth > 0 && !rootGeneratedId) continue;
      const result = await upsertDraft(row, rootGeneratedId);
      if (row.crawl_depth === 0) rootGeneratedId = result.documentId;
      generated.push({
        title: row.source_title,
        slug: result.slug,
        resolvedAssets: result.hydrated.resolvedAssets,
        skippedAssets: result.hydrated.skippedAssets,
        placeholders: result.hydrated.placeholders,
      });
    }

    return NextResponse.json({ ok: true, rootTitle, translationVersion: TRANSLATION_VERSION, applied, generated });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown localization error" }, { status: 500 });
  }
}
