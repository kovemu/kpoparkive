import { NextResponse } from "next/server";
import { fetchMirrorDocument, shouldCrawlTitle, type RelationCandidate } from "../../../../lib/namuMirror";

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

type QueueItem = {
  title: string;
  depth: number;
  relationScore: number;
  relationReason: string;
};

type ResultRow = {
  title: string;
  depth: number;
  status: string;
  links: number;
  images: number;
  videos: number;
  externalLinks: number;
  autoRelations: number;
  relationReason?: string;
};

function enqueueCandidate(queue: QueueItem[], queued: Set<string>, seen: Set<string>, candidate: RelationCandidate, depth: number) {
  if (seen.has(candidate.title) || queued.has(candidate.title)) return;
  queued.add(candidate.title);
  queue.push({ title: candidate.title, depth, relationScore: candidate.score, relationReason: candidate.reason });
}

export async function POST(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = await request.json() as {
      rootTitle?: string;
      maxDepth?: number;
      maxDocuments?: number;
      includePrefixes?: string[];
      includeTitles?: string[];
    };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const maxDepth = Math.max(0, Math.min(Number(body.maxDepth ?? 2), 4));
    const maxDocuments = Math.max(1, Math.min(Number(body.maxDocuments ?? 80), 200));
    const includePrefixes = [...new Set(body.includePrefixes || [])];
    const includeTitles = [...new Set(body.includeTitles || [])];

    const runs = await db("import_runs", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ root_title: rootTitle, max_depth: maxDepth, max_documents: maxDocuments }),
    }) as { id: string }[];
    const runId = runs[0].id;

    const queue: QueueItem[] = [{ title: rootTitle, depth: 0, relationScore: 100, relationReason: "root" }];
    const queued = new Set<string>([rootTitle]);
    const seen = new Set<string>();
    const results: ResultRow[] = [];
    let errorCount = 0;
    let skippedCount = 0;
    let autoDiscoveredCount = 0;

    while (queue.length && seen.size < maxDocuments) {
      queue.sort((a, b) => b.relationScore - a.relationScore || a.depth - b.depth);
      const current = queue.shift()!;
      queued.delete(current.title);
      if (seen.has(current.title)) continue;

      const explicitAllowed = shouldCrawlTitle(current.title, rootTitle, includePrefixes, includeTitles);
      const autoAllowed = current.relationScore >= 74;
      if (!explicitAllowed && !autoAllowed) {
        skippedCount += 1;
        continue;
      }
      seen.add(current.title);

      try {
        const snapshot = await fetchMirrorDocument(current.title, undefined, rootTitle);
        await db("source_documents?on_conflict=source,source_title", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify({
            source: "namu_mirror",
            source_title: snapshot.title,
            source_url: snapshot.url,
            root_title: rootTitle,
            crawl_depth: current.depth,
            raw_html: snapshot.html,
            extracted_text: snapshot.text,
            source_hash: snapshot.hash,
            discovered_links: snapshot.links,
            discovered_images: snapshot.images,
            discovered_videos: snapshot.videos,
            discovered_external_links: snapshot.externalLinks,
            discovered_relations: snapshot.relationCandidates,
            fetched_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }),
        });

        results.push({
          title: current.title,
          depth: current.depth,
          status: "fetched",
          links: snapshot.links.length,
          images: snapshot.images.length,
          videos: snapshot.videos.length,
          externalLinks: snapshot.externalLinks.length,
          autoRelations: snapshot.relationCandidates.length,
          relationReason: current.relationReason,
        });

        if (current.depth < maxDepth) {
          for (const link of snapshot.links) {
            if (!seen.has(link) && shouldCrawlTitle(link, rootTitle, includePrefixes, includeTitles) && !queued.has(link)) {
              queued.add(link);
              queue.push({ title: link, depth: current.depth + 1, relationScore: 100, relationReason: "root-subdocument-or-explicit" });
            }
          }

          for (const candidate of snapshot.relationCandidates) {
            if (candidate.title === rootTitle) continue;
            const wasKnown = seen.has(candidate.title) || queued.has(candidate.title);
            enqueueCandidate(queue, queued, seen, candidate, current.depth + 1);
            if (!wasKnown && candidate.score < 100) autoDiscoveredCount += 1;
          }
        }
      } catch (error) {
        errorCount += 1;
        results.push({
          title: current.title,
          depth: current.depth,
          status: error instanceof Error ? error.message : "error",
          links: 0,
          images: 0,
          videos: 0,
          externalLinks: 0,
          autoRelations: 0,
          relationReason: current.relationReason,
        });
      }
    }

    await db(`import_runs?id=eq.${runId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: errorCount ? "completed_with_errors" : "completed",
        fetched_count: results.filter((r) => r.status === "fetched").length,
        skipped_count: skippedCount,
        error_count: errorCount,
        result: {
          documents: results,
          auto_relation_discovery: true,
          auto_discovered_count: autoDiscoveredCount,
          includePrefixes,
          includeTitles,
        },
        finished_at: new Date().toISOString(),
      }),
    });

    return NextResponse.json({
      ok: true,
      runId,
      fetched: results.filter((r) => r.status === "fetched").length,
      errors: errorCount,
      skipped: skippedCount,
      autoDiscovered: autoDiscoveredCount,
      documents: results,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown import error" }, { status: 500 });
  }
}
