import { notFound } from "next/navigation";
import NamuMirrorDomRenderer from "../../../../components/wiki/NamuMirrorDomRenderer";
import NamuRawRenderer from "../../../../components/wiki/NamuRawRenderer";
import { createNamuAssetLookup } from "../../../../lib/namuAssetLookup";
import { parseNamuHybridSegments } from "../../../../lib/namuHybrid";
import { buildNamuMirrorImportArtifact, NAMU_RENDER_ARTIFACT_VERSION } from "../../../../lib/namuMirrorImportArtifact";
import { parseNamuRawCanonical } from "../../../../lib/namuRawGrammar";
import { extractMirrorRawBundle, type RawSourceSegment } from "../../../../lib/namuRawSource";
import { parseVisibleNamuRawSegments } from "../../../../lib/namuRawSegments";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

type AssetRow = {
  asset_type: string;
  source_ref: string;
  label: string | null;
  status: string;
  resolved_url: string | null;
  storage_path: string | null;
  metadata: Record<string, unknown> | null;
};

function fileKey(ref: string) {
  return ref.normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function usableAssetUrl(row: AssetRow) {
  if (row.resolved_url) return row.resolved_url;
  const candidate = row.metadata?.enrichment_url;
  if (typeof candidate === "string" && /^https?:\/\//i.test(candidate)) return candidate;
  if (/^https?:\/\//i.test(row.source_ref)) return row.source_ref;
  return null;
}

function isCompleteRawFormat(format: string | null) {
  return /^(?:namuwiki[_-]?raw|namu[_-]?raw|direct[_-]?raw)$/i.test(format || "");
}

export default async function NamuRawPreviewPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);
  const docs = await db<{
    id: string;
    source_title: string;
    root_title: string;
    raw_html: string;
    source_article_html: string | null;
    source_template_css: string | null;
    source_render_manifest: Record<string, unknown> | null;
    source_render_extraction_version: string | null;
    source_render_extracted_at: string | null;
    source_wikitext: string | null;
    source_raw_segments: RawSourceSegment[] | null;
    source_format: string | null;
    raw_extracted_at: string | null;
  }[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=id,source_title,root_title,raw_html,source_article_html,source_template_css,source_render_manifest,source_render_extraction_version,source_render_extracted_at,source_wikitext,source_raw_segments,source_format,raw_extracted_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const bundle = extractMirrorRawBundle(source.raw_html || "");
  const segments = source.source_raw_segments?.length ? source.source_raw_segments : bundle.segments;
  const raw = source.source_wikitext || bundle.sourceWikitext;
  const visible = parseVisibleNamuRawSegments(segments);
  const hybrid = parseNamuHybridSegments(segments);
  const completeRaw = Boolean(raw) && isCompleteRawFormat(source.source_format);
  const completeRawNodes = completeRaw ? parseNamuRawCanonical(raw) : [];

  // Preview is not a second renderer pipeline. If the persisted artifact is old,
  // rebuild it in memory through the exact importer function. This makes every
  // RESCENE fix prove that it will also apply to the next imported group.
  const importedDomArtifact = Boolean(source.source_article_html);
  const currentImporterArtifact = importedDomArtifact && source.source_render_extraction_version === NAMU_RENDER_ARTIFACT_VERSION;
  const runtimeArtifact = currentImporterArtifact ? null : buildNamuMirrorImportArtifact(source.raw_html || "");
  const mirrorHtml = currentImporterArtifact ? source.source_article_html || "" : runtimeArtifact?.articleHtml || "";
  const templateCss = currentImporterArtifact ? source.source_template_css : runtimeArtifact?.templateCss || null;
  const renderManifest = currentImporterArtifact ? source.source_render_manifest : runtimeArtifact?.manifest || null;

  const [assetRows, clusterDocs] = await Promise.all([
    db<AssetRow[]>(
      `source_asset_queue?root_title=eq.${encodeURIComponent(source.root_title)}&asset_type=eq.image&select=asset_type,source_ref,label,status,resolved_url,storage_path,metadata`,
    ),
    db<{ raw_html: string }[]>(
      `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(source.root_title)}&select=raw_html&limit=80`,
    ),
  ]);

  const assets: Record<string, string> = {};
  for (const clusterDoc of clusterDocs) {
    const map = extractMirrorRawBundle(clusterDoc.raw_html || "").renderedFileMap;
    for (const [key, url] of Object.entries(map)) {
      if (!assets[fileKey(key)]) assets[fileKey(key)] = url;
    }
  }
  for (const [key, url] of Object.entries(bundle.renderedFileMap)) assets[fileKey(key)] = url;
  for (const row of assetRows) {
    const url = usableAssetUrl(row);
    if (!url) continue;
    assets[fileKey(row.source_ref)] = url;
    if (row.label) assets[fileKey(row.label)] = url;
  }

  // Mirror/file queue names are not always byte-identical. For example the raw
  // document may say "RESCENE 로고(Pretty Girl).svg" while enrichment returns
  // "Pretty Girl(RESCENE) 로고.svg". Reconcile every source reference through a
  // collision-aware canonical/token signature resolver, then materialize the
  // alias into the normal exact-key map consumed by both renderers.
  const assetLookup = createNamuAssetLookup(assets);
  for (const ref of bundle.fileRefs) {
    const url = assetLookup(ref);
    if (url && !assets[fileKey(ref)]) assets[fileKey(ref)] = url;
  }

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMU SOURCE MIRROR · IMPORTER CANONICAL</div>
      </header>
      <main className="articleShell" style={{ maxWidth: 1180, "--accent": "#fc6fcf" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Source mirror › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>
              {completeRaw
                ? "A complete Namu raw document is available, so this preview renders the preserved source through the canonical grammar parser."
                : currentImporterArtifact
                  ? "This document renders the current persisted importer artifact."
                  : "The stored artifact is legacy, so this preview rebuilds the current importer artifact in memory from raw_html. No preview-only repair path is used."}
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "18px 0 26px" }}>
          <Metric label="Render mode" value={completeRaw ? "DIRECT RAW" : "DOM + RAW"} />
          <Metric label="Importer artifact" value={currentImporterArtifact ? "PERSISTED" : "RUNTIME CURRENT"} />
          <Metric label="Template CSS" value={templateCss?.trim() ? "IMPORTED" : "NONE"} />
          <Metric label="Render artifact" value={currentImporterArtifact ? source.source_render_extraction_version || "unknown" : NAMU_RENDER_ARTIFACT_VERSION} />
          <Metric label="Mirror raw coverage" value={`${bundle.estimatedRawCoverage}%`} />
          <Metric label="Cluster mapped images" value={String(Object.keys(assets).length)} />
        </div>

        <section>
          <h2 className="sectionTitle">Document preview</h2>
          {completeRaw
            ? <NamuRawRenderer nodes={completeRawNodes} assets={assets} />
            : <NamuMirrorDomRenderer html={mirrorHtml} assets={assets} templateCss={templateCss} />}
        </section>

        <details style={{ marginTop: 28 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Importer grammar diagnostics</summary>
          <div style={{ marginTop: 12, padding: 16, border: "1px solid #d7dde5", borderRadius: 8, background: "#f8fafc" }}>
            <p style={{ marginTop: 0 }}>
              Current source format: <strong>{source.source_format || "namu mirror hybrid"}</strong>. The recovered raw subset contains {bundle.rawBlockCount} raw blocks; DOM + RAW mode preserves the mirror parent layout and applies the same grammar/import artifact pipeline used for future imports.
            </p>
            {renderManifest && <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.5 }}>{JSON.stringify(renderManifest, null, 2)}</pre>}
            <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0, fontSize: 13, lineHeight: 1.55 }}>{raw || "No raw syntax blocks recovered."}</pre>
          </div>
        </details>

        <details style={{ marginTop: 18 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Recovered file references ({bundle.fileRefs.length})</summary>
          <ul className="wikiList">{bundle.fileRefs.slice(0, 300).map((file) => <li key={file}>{file}</li>)}</ul>
        </details>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ border: "1px solid #d7dde5", borderRadius: 8, padding: 14, background: "white" }}><div style={{ fontSize: 12, color: "#667085" }}>{label}</div><div style={{ marginTop: 4, fontSize: 18, fontWeight: 700 }}>{value}</div></div>;
}
