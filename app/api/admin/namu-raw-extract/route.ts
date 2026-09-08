import { hydrateNamuStoredMedia } from "../../../../lib/namuStoredMediaHydrate";
import { NextResponse } from "next/server";
import { buildNamuMirrorImportArtifact, NAMU_RENDER_ARTIFACT_VERSION } from "../../../../lib/namuMirrorImportArtifact";
import type { RenderedFileMap } from "../../../../lib/namuRawSource";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const EXTRACTION_VERSION = "namu-mirror-hybrid-v6-dom-artifacts-on-import";

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

function hasCanonicalSegments(value: unknown) {
  return Array.isArray(value) && value.length > 0;
}

function hasCanonicalRenderArtifact(row: { source_article_html: string | null; source_render_extraction_version: string | null }) {
  return Boolean(row.source_article_html) && row.source_render_extraction_version === NAMU_RENDER_ARTIFACT_VERSION;
}

async function hydrateClusterAssetHints(rootTitle: string, renderedFileMap: RenderedFileMap) {
  if (!Object.keys(renderedFileMap).length) return 0;
  const rows = await db(
    `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image&status=in.(pending,unresolved)&select=id,source_ref,status,metadata&limit=2000`,
  ) as Array<{ id: string; source_ref: string; status: string; metadata: Record<string, unknown> | null }>;

  let updated = 0;
  for (const row of rows) {
    const url = renderedFileMap[normalizeFileKey(row.source_ref)];
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
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await request.json() as { rootTitle?: string; force?: boolean };
    const rootTitle = String(body.rootTitle || "").trim();
    if (!rootTitle) return NextResponse.json({ error: "rootTitle is required" }, { status: 400 });

    const rows = await db(
      `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(rootTitle)}&select=id,source_title,raw_html,source_extraction_version,raw_extracted_at,source_raw_segments,source_article_html,source_render_extraction_version&order=crawl_depth.asc,source_title.asc`,
    ) as {
      id: string;
      source_title: string;
      raw_html: string;
      source_extraction_version: string | null;
      raw_extracted_at: string | null;
      source_raw_segments: unknown;
      source_article_html: string | null;
      source_render_extraction_version: string | null;
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
      mappedFiles: number;
      linkedFileTargets: number;
      queuedImages: number;
      internalLinks: number;
      styleBlocks: number;
      tables: number;
      floatRightTables: number;
      hasToc: boolean;
    }[] = [];
    const clusterRenderedFileMap: RenderedFileMap = {};

    for (const row of rows) {
      if (
        !body.force
        && row.source_extraction_version === EXTRACTION_VERSION
        && row.raw_extracted_at
        && hasCanonicalSegments(row.source_raw_segments)
        && hasCanonicalRenderArtifact(row)
      ) {
        results.push({ title: row.source_title, status: "unchanged", rawBlocks: 0, rawCharacters: 0, renderedCharacters: 0, estimatedRawCoverage: 0, fileRefs: 0, mappedFiles: 0, linkedFileTargets: 0, queuedImages: 0, internalLinks: 0, styleBlocks: 0, tables: 0, floatRightTables: 0, hasToc: false });
        continue;
      }

      const artifact = buildNamuMirrorImportArtifact(row.raw_html || "");
      const bundle = artifact.rawBundle;
      mergeRenderedFileMap(clusterRenderedFileMap, artifact.renderedFileMap);
      const extractedAt = new Date().toISOString();

      await db(`source_documents?id=eq.${row.id}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          source_wikitext: bundle.sourceWikitext || null,
          source_raw_segments: bundle.segments,
          source_format: EXTRACTION_VERSION,
          source_extraction_version: EXTRACTION_VERSION,
          raw_extracted_at: extractedAt,
          source_article_html: artifact.articleHtml,
          source_template_css: artifact.templateCss || null,
          source_render_manifest: artifact.manifest,
          source_render_extraction_version: NAMU_RENDER_ARTIFACT_VERSION,
          source_render_extracted_at: extractedAt,
          updated_at: extractedAt,
        }),
      });

      const existing = await db(
        `source_asset_queue?source_document_id=eq.${row.id}&asset_type=eq.image&select=source_ref`,
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
          source_document_id: row.id,
          root_title: rootTitle,
          source_title: row.source_title,
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

      results.push({
        title: row.source_title,
        status: "extracted",
        rawBlocks: bundle.rawBlockCount,
        rawCharacters: bundle.rawCharacters,
        renderedCharacters: bundle.renderedCharacters,
        estimatedRawCoverage: bundle.estimatedRawCoverage,
        fileRefs: bundle.fileRefs.length,
        mappedFiles: Object.keys(bundle.renderedFileMap).length,
        linkedFileTargets: Object.keys(bundle.fileTargetMap).length,
        queuedImages: imageRows.length,
        internalLinks: bundle.internalLinks.length,
        styleBlocks: artifact.manifest.styleBlockCount,
        tables: artifact.manifest.tableCount,
        floatRightTables: artifact.manifest.floatRightTableCount,
        hasToc: artifact.manifest.hasToc,
      });
    }

    let clusterAssetHints = 0;
    let clusterAssetHintError: string | null = null;
    try {
      clusterAssetHints = await hydrateClusterAssetHints(rootTitle, clusterRenderedFileMap);
    } catch (error) {
      clusterAssetHintError = error instanceof Error ? error.message : "cluster asset hint hydration failed";
    }

    const reusedStoredMedia = await hydrateNamuStoredMedia(db, rootTitle, SUPABASE_URL);

    const extracted = results.filter((result) => result.status === "extracted");
    const weightedRaw = extracted.reduce((sum, result) => sum + result.rawCharacters, 0);
    const weightedRendered = extracted.reduce((sum, result) => sum + result.renderedCharacters, 0);
    const denominator = weightedRaw + weightedRendered;

    return NextResponse.json({
      ok: true,
      rootTitle,
      extractionVersion: EXTRACTION_VERSION,
      renderArtifactVersion: NAMU_RENDER_ARTIFACT_VERSION,
      documents: results.length,
      extracted: extracted.length,
      unchanged: results.filter((result) => result.status === "unchanged").length,
      rawBlocks: extracted.reduce((sum, result) => sum + result.rawBlocks, 0),
      styleBlocks: extracted.reduce((sum, result) => sum + result.styleBlocks, 0),
      tables: extracted.reduce((sum, result) => sum + result.tables, 0),
      fileRefs: extracted.reduce((sum, result) => sum + result.fileRefs, 0),
      mappedFiles: extracted.reduce((sum, result) => sum + result.mappedFiles, 0),
      linkedFileTargets: extracted.reduce((sum, result) => sum + result.linkedFileTargets, 0),
      queuedImages: extracted.reduce((sum, result) => sum + result.queuedImages, 0),
      internalLinks: extracted.reduce((sum, result) => sum + result.internalLinks, 0),
      clusterRenderedFiles: Object.keys(clusterRenderedFileMap).length,
      clusterAssetHints,
      reusedStoredMedia,
      clusterAssetHintError,
      estimatedRawCoverage: denominator ? Math.round((weightedRaw / denominator) * 1000) / 10 : 0,
      results,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown raw/render artifact extraction error" }, { status: 500 });
  }
}

