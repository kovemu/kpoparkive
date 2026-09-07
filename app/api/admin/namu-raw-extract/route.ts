import { NextResponse } from "next/server";
import { extractMirrorRawBundle } from "../../../../lib/namuRawSource";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const EXTRACTION_VERSION = "namu-mirror-hybrid-v1";

function headers(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, "Content-Type": "application/json", ...extra };
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

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as { rootTitle?: string; force?: boolean };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const rows = await db(
      `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&select=id,source_title,raw_html,source_extraction_version,raw_extracted_at&order=crawl_depth.asc,source_title.asc`,
    ) as {
      id: string;
      source_title: string;
      raw_html: string;
      source_extraction_version: string | null;
      raw_extracted_at: string | null;
    }[];

    if (!rows.length) return NextResponse.json({ error: `No source documents found for ${rootTitle}` }, { status: 404 });

    const results: {
      title: string;
      status: string;
      rawBlocks: number;
      rawCharacters: number;
      renderedCharacters: number;
      estimatedRawCoverage: number;
      fileRefs: number;
      internalLinks: number;
    }[] = [];

    for (const row of rows) {
      if (!body.force && row.source_extraction_version === EXTRACTION_VERSION && row.raw_extracted_at) {
        results.push({ title: row.source_title, status: "unchanged", rawBlocks: 0, rawCharacters: 0, renderedCharacters: 0, estimatedRawCoverage: 0, fileRefs: 0, internalLinks: 0 });
        continue;
      }

      const bundle = extractMirrorRawBundle(row.raw_html || "");
      await db(`source_documents?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          source_wikitext: bundle.sourceWikitext || null,
          source_format: EXTRACTION_VERSION,
          source_extraction_version: EXTRACTION_VERSION,
          raw_extracted_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });

      results.push({
        title: row.source_title,
        status: "extracted",
        rawBlocks: bundle.rawBlockCount,
        rawCharacters: bundle.rawCharacters,
        renderedCharacters: bundle.renderedCharacters,
        estimatedRawCoverage: bundle.estimatedRawCoverage,
        fileRefs: bundle.fileRefs.length,
        internalLinks: bundle.internalLinks.length,
      });
    }

    const extracted = results.filter((result) => result.status === "extracted");
    const weightedRaw = extracted.reduce((sum, result) => sum + result.rawCharacters, 0);
    const weightedRendered = extracted.reduce((sum, result) => sum + result.renderedCharacters, 0);
    const denominator = weightedRaw + weightedRendered;

    return NextResponse.json({
      ok: true,
      rootTitle,
      extractionVersion: EXTRACTION_VERSION,
      documents: results.length,
      extracted: extracted.length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      rawBlocks: extracted.reduce((sum, result) => sum + result.rawBlocks, 0),
      fileRefs: extracted.reduce((sum, result) => sum + result.fileRefs, 0),
      internalLinks: extracted.reduce((sum, result) => sum + result.internalLinks, 0),
      estimatedRawCoverage: denominator ? Math.round((weightedRaw / denominator) * 1000) / 10 : 0,
      results,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown raw extraction error" }, { status: 500 });
  }
}
