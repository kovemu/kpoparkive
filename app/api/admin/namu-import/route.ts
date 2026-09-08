import { hydrateNamuStoredMedia } from "../../../../lib/namuStoredMediaHydrate";
import { NextResponse } from "next/server";
import { fetchMirrorDocument, shouldCrawlTitle, type RelationCandidate } from "../../../../lib/namuMirror";
import { buildNamuMirrorImportArtifact, NAMU_RENDER_ARTIFACT_VERSION } from "../../../../lib/namuMirrorImportArtifact";
import type { MirrorRawBundle, RenderedFileMap } from "../../../../lib/namuRawSource";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const EXTRACTION_VERSION = "namu-mirror-hybrid-v6-dom-artifacts-on-import";

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
  rawBlocks: number;
  rawCoverage: number;
  queuedImages: number;
  templateStyles: number;
  tables: number;
  floatRightTables: number;
  renderedFiles: number;
  unresolvedRawFiles: number;
  hasToc: boolean;
  relationReason?: string;
};

function enqueueCandidate(queue: QueueItem[], queued: Set<string>, seen: Set<string>, candidate: RelationCandidate, depth: number) {
  if (seen.has(candidate.title) || queued.has(candidate.title)) return;
  queued.add(candidate.title);
  queue.push({ title: candidate.title, depth, relationScore: candidate.score, relationReason: candidate.reason });
}

function usefulRawTarget(value: string, rootTitle: string) {
  const title = value.normalize("NFKC").replace(/#.*$/, "").trim();
  if (!title || title === rootTitle) return "";
  if (/^(?:틀|Template|파일|File|분류|Category):/i.test(title)) return "";
  if (/^https?:\/\//i.test(title)) return "";
  return title;
}

function enqueueRawFileTargets(queue: QueueItem[], queued: Set<string>, seen: Set<string>, fileTargetMap: Record<string, string>, rootTitle: string, depth: number) {
  let added = 0;
  for (const targetValue of new Set(Object.values(fileTargetMap))) {
    const title = usefulRawTarget(targetValue, rootTitle);
    if (!title || seen.has(title) || queued.has(title)) continue;
    queued.add(title);
    queue.push({ title, depth, relationScore: 96, relationReason: "raw-image-link-target" });
    added += 1;
  }
  return added;
}

function rawImageRef(file: string) {
  return `파일:${file.trim()}`;
}

function normalizeFileKey(value: string) {
  return value.normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function mergeRenderedFileMap(target: RenderedFileMap, incoming: RenderedFileMap) {
  for (const [file, url] of Object.entries(incoming)) {
    const key = normalizeFileKey(file);
    if (key && url && !target[key]) target[key] = url;
  }
}

async function queueRawAssets(sourceDocumentId: string, rootTitle: string, sourceTitle: string, bundle: MirrorRawBundle) {
  const existing = await db(
    `source_asset_queue?source_document_id=eq.${sourceDocumentId}&asset_type=eq.image&select=source_ref`,
  ) as { source_ref: string }[];
  const existingRefs = new Set(existing.map((asset) => asset.source_ref));
  const allFiles = [...new Set([...bundle.fileRefs, ...Object.keys(bundle.renderedFileMap)])];
  const imageRows = allFiles
    .map((file) => ({
      file,
      source_ref: rawImageRef(file),
      directUrl: bundle.renderedFileMap[file] || null,
      linkedTarget: bundle.fileTargetMap[file] || null,
    }))
    .filter((asset) => !existingRefs.has(asset.source_ref))
    .map((asset) => ({
      source_document_id: sourceDocumentId,
      root_title: rootTitle,
      source_title: sourceTitle,
      asset_type: "image",
      source_ref: asset.source_ref,
      label: asset.file,
      provider: "namu_file",
      role: "inline",
      metadata: {
        filename: asset.file,
        origin: bundle.fileRefs.includes(asset.file) ? "raw" : "rendered",
        extraction_version: EXTRACTION_VERSION,
        render_artifact_version: NAMU_RENDER_ARTIFACT_VERSION,
        ...(asset.directUrl ? { enrichment_url: asset.directUrl, enrichment_confidence: 1, resolved_from_hint: "mirror-img-alt" } : {}),
        ...(asset.linkedTarget ? { linked_target: asset.linkedTarget, resolved_from_hint: asset.directUrl ? "mirror-img-alt" : "linked-document" } : {}),
      },
    }));

  if (imageRows.length) {
    await db("source_asset_queue", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(imageRows),
    });
  }

  return imageRows.length;
}

async function hydrateClusterAssetHints(rootTitle: string, renderedFileMap: RenderedFileMap) {
  if (!Object.keys(renderedFileMap).length) return 0;
  const rows = await db(
    `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image&status=in.(pending,unresolved)&select=id,source_ref,status,metadata&limit=2000`,
  ) as Array<{ id: string; source_ref: string; status: string; metadata: Record<string, unknown> | null }>;

  let updated = 0;
  for (const row of rows) {
    const file = normalizeFileKey(row.source_ref);
    const url = renderedFileMap[file];
    if (!url) continue;
    const metadata = row.metadata || {};
    if (metadata.enrichment_url === url && row.status === "pending") continue;
    await db(`source_asset_queue?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "pending",
        metadata: {
          ...metadata,
          enrichment_url: url,
          enrichment_confidence: 1,
          resolved_from_hint: "cluster-rendered-file-map",
          render_artifact_version: NAMU_RENDER_ARTIFACT_VERSION,
        },
        updated_at: new Date().toISOString(),
      }),
    });
    updated += 1;
  }
  return updated;
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
    const clusterRenderedFileMap: RenderedFileMap = {};
    let errorCount = 0;
    let skippedCount = 0;
    let autoDiscoveredCount = 0;
    let rawImageTargetCount = 0;

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
        const renderArtifact = buildNamuMirrorImportArtifact(snapshot.html);
        const rawBundle = renderArtifact.rawBundle;
        mergeRenderedFileMap(clusterRenderedFileMap, renderArtifact.renderedFileMap);
        const extractedAt = new Date().toISOString();
        const stored = await db("source_documents?on_conflict=source,source_title&select=id", {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates,return=representation" },
          body: JSON.stringify({
            source: "namu_mirror",
            source_title: snapshot.title,
            source_url: snapshot.url,
            root_title: rootTitle,
            crawl_depth: current.depth,
            raw_html: snapshot.html,
            source_article_html: renderArtifact.articleHtml,
            source_template_css: renderArtifact.templateCss || null,
            source_render_manifest: renderArtifact.manifest,
            source_render_extraction_version: NAMU_RENDER_ARTIFACT_VERSION,
            source_render_extracted_at: extractedAt,
            extracted_text: snapshot.text,
            source_hash: snapshot.hash,
            discovered_links: snapshot.links,
            discovered_images: snapshot.images,
            discovered_videos: snapshot.videos,
            discovered_external_links: snapshot.externalLinks,
            discovered_relations: snapshot.relationCandidates,
            source_wikitext: rawBundle.sourceWikitext || null,
            source_raw_segments: rawBundle.segments,
            source_format: EXTRACTION_VERSION,
            source_extraction_version: EXTRACTION_VERSION,
            raw_extracted_at: extractedAt,
            fetched_at: extractedAt,
            updated_at: extractedAt,
          }),
        }) as { id: string }[];
        const sourceDocumentId = stored[0]?.id;
        if (!sourceDocumentId) throw new Error(`Failed to persist source document id for ${snapshot.title}`);
        const queuedImages = await queueRawAssets(sourceDocumentId, rootTitle, snapshot.title, rawBundle);

        results.push({
          title: current.title,
          depth: current.depth,
          status: "fetched",
          links: snapshot.links.length,
          images: snapshot.images.length,
          videos: snapshot.videos.length,
          externalLinks: snapshot.externalLinks.length,
          autoRelations: snapshot.relationCandidates.length,
          rawBlocks: rawBundle.rawBlockCount,
          rawCoverage: rawBundle.estimatedRawCoverage,
          queuedImages,
          templateStyles: renderArtifact.manifest.styleBlockCount,
          tables: renderArtifact.manifest.tableCount,
          floatRightTables: renderArtifact.manifest.floatRightTableCount,
          renderedFiles: renderArtifact.manifest.renderedFileCount,
          unresolvedRawFiles: renderArtifact.manifest.unresolvedRawFileCount,
          hasToc: renderArtifact.manifest.hasToc,
          relationReason: current.relationReason,
        });

        if (current.depth < maxDepth) {
          for (const link of snapshot.links) {
            if (!seen.has(link) && shouldCrawlTitle(link, rootTitle, includePrefixes, includeTitles) && !queued.has(link)) {
              queued.add(link);
              queue.push({ title: link, depth: current.depth + 1, relationScore: 100, relationReason: "root-subdocument-or-explicit" });
            }
          }

          if (current.depth === 0) {
            rawImageTargetCount += enqueueRawFileTargets(queue, queued, seen, rawBundle.fileTargetMap, rootTitle, current.depth + 1);
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
          rawBlocks: 0,
          rawCoverage: 0,
          queuedImages: 0,
          templateStyles: 0,
          tables: 0,
          floatRightTables: 0,
          renderedFiles: 0,
          unresolvedRawFiles: 0,
          hasToc: false,
          relationReason: current.relationReason,
        });
      }
    }

    let clusterAssetHints = 0;
    let clusterAssetHintError: string | null = null;
    try {
      clusterAssetHints = await hydrateClusterAssetHints(rootTitle, clusterRenderedFileMap);
    } catch (error) {
      clusterAssetHintError = error instanceof Error ? error.message : "cluster asset hint hydration failed";
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
          raw_image_target_discovery: true,
          raw_image_target_count: rawImageTargetCount,
          canonical_raw_on_import: true,
          dom_skeleton_on_import: true,
          template_css_on_import: true,
          render_manifest_on_import: true,
          cluster_asset_hinting: true,
          cluster_asset_hints: clusterAssetHints,
          cluster_asset_hint_error: clusterAssetHintError,
          cluster_rendered_file_count: Object.keys(clusterRenderedFileMap).length,
          extraction_version: EXTRACTION_VERSION,
          render_artifact_version: NAMU_RENDER_ARTIFACT_VERSION,
          includePrefixes,
          includeTitles,
        },
        finished_at: new Date().toISOString(),
      }),
    });

    const fetchedResults = results.filter((r) => r.status === "fetched");
    const reusedStoredMedia = await hydrateNamuStoredMedia(db, rootTitle, SUPABASE_URL);
    return NextResponse.json({
      reusedStoredMedia,
      ok: true,
      runId,
      extractionVersion: EXTRACTION_VERSION,
      renderArtifactVersion: NAMU_RENDER_ARTIFACT_VERSION,
      fetched: fetchedResults.length,
      errors: errorCount,
      skipped: skippedCount,
      autoDiscovered: autoDiscoveredCount,
      rawImageTargets: rawImageTargetCount,
      rawBlocks: fetchedResults.reduce((sum, row) => sum + row.rawBlocks, 0),
      templateStyles: fetchedResults.reduce((sum, row) => sum + row.templateStyles, 0),
      renderedFiles: Object.keys(clusterRenderedFileMap).length,
      clusterAssetHints,
      clusterAssetHintError,
      queuedImages: fetchedResults.reduce((sum, row) => sum + row.queuedImages, 0),
      documents: results,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown import error" }, { status: 500 });
  }
}

