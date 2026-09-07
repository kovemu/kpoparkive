import { NextResponse } from "next/server";
import { fetchMirrorDocument, shouldCrawlTitle } from "../../../../lib/namuMirror";

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
    const body = await request.json() as { rootTitle?: string; maxDepth?: number; maxDocuments?: number; includePrefixes?: string[]; includeTitles?: string[] };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const maxDepth = Math.max(0, Math.min(Number(body.maxDepth ?? 2), 4));
    const maxDocuments = Math.max(1, Math.min(Number(body.maxDocuments ?? 50), 200));
    const includePrefixes = [...new Set([rootTitle + "/", ...(body.includePrefixes || [])])];
    const includeTitles = [...new Set(body.includeTitles || [])];

    const runs = await db("import_runs", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ root_title: rootTitle, max_depth: maxDepth, max_documents: maxDocuments }) }) as { id: string }[];
    const runId = runs[0].id;
    const queue: { title: string; depth: number }[] = [{ title: rootTitle, depth: 0 }];
    const seen = new Set<string>();
    const results: { title: string; depth: number; status: string; links: number; images: number; videos: number; externalLinks: number }[] = [];
    let errorCount = 0;
    let skippedCount = 0;

    while (queue.length && seen.size < maxDocuments) {
      const current = queue.shift()!;
      if (seen.has(current.title)) continue;
      if (!shouldCrawlTitle(current.title, rootTitle, includePrefixes, includeTitles)) { skippedCount += 1; continue; }
      seen.add(current.title);

      try {
        const snapshot = await fetchMirrorDocument(current.title);
        await db("source_documents?on_conflict=source,source_title", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            source: "namu_mirror", source_title: snapshot.title, source_url: snapshot.url, root_title: rootTitle, crawl_depth: current.depth,
            raw_html: snapshot.html, extracted_text: snapshot.text, source_hash: snapshot.hash,
            discovered_links: snapshot.links, discovered_images: snapshot.images, discovered_videos: snapshot.videos,
            discovered_external_links: snapshot.externalLinks, fetched_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          }),
        });
        results.push({ title: current.title, depth: current.depth, status: "fetched", links: snapshot.links.length, images: snapshot.images.length, videos: snapshot.videos.length, externalLinks: snapshot.externalLinks.length });

        if (current.depth < maxDepth) {
          for (const link of snapshot.links) {
            if (!seen.has(link) && shouldCrawlTitle(link, rootTitle, includePrefixes, includeTitles)) queue.push({ title: link, depth: current.depth + 1 });
          }
        }
      } catch (error) {
        errorCount += 1;
        results.push({ title: current.title, depth: current.depth, status: error instanceof Error ? error.message : "error", links: 0, images: 0, videos: 0, externalLinks: 0 });
      }
    }

    await db(`import_runs?id=eq.${runId}`, {
      method: "PATCH", headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ status: errorCount ? "completed_with_errors" : "completed", fetched_count: results.filter((r) => r.status === "fetched").length, skipped_count: skippedCount, error_count: errorCount, result: { documents: results, includePrefixes, includeTitles }, finished_at: new Date().toISOString() }),
    });

    return NextResponse.json({ ok: true, runId, fetched: results.filter((r) => r.status === "fetched").length, errors: errorCount, skipped: skippedCount, documents: results });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown import error" }, { status: 500 });
  }
}
