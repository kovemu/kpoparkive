import { notFound } from "next/navigation";
import NamuHybridRenderer from "../../../../components/wiki/NamuHybridRenderer";
import NamuRawRenderer from "../../../../components/wiki/NamuRawRenderer";
import { parseNamuHybridSegments } from "../../../../lib/namuHybrid";
import { parseNamuRaw } from "../../../../lib/namuRawParser";
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
  return typeof candidate === "string" && /^https?:\/\//i.test(candidate) ? candidate : null;
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
    raw_html: string;
    source_wikitext: string | null;
    source_raw_segments: RawSourceSegment[] | null;
    source_format: string | null;
    raw_extracted_at: string | null;
  }[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=id,source_title,raw_html,source_wikitext,source_raw_segments,source_format,raw_extracted_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const bundle = extractMirrorRawBundle(source.raw_html || "");
  const segments = source.source_raw_segments?.length ? source.source_raw_segments : bundle.segments;
  const raw = source.source_wikitext || bundle.sourceWikitext;
  const visible = parseVisibleNamuRawSegments(segments);
  const hybrid = parseNamuHybridSegments(segments);
  const completeRaw = Boolean(raw) && isCompleteRawFormat(source.source_format);
  const completeRawNodes = completeRaw ? parseNamuRaw(raw) : [];

  const assetRows = await db<AssetRow[]>(
    `source_asset_queue?source_document_id=eq.${source.id}&asset_type=eq.image&select=asset_type,source_ref,status,resolved_url,storage_path,metadata`,
  );
  const assets: Record<string, string> = { ...bundle.renderedFileMap };
  for (const row of assetRows) {
    const url = usableAssetUrl(row);
    if (url) assets[fileKey(row.source_ref)] = url;
  }

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMU SOURCE MIRROR · v3</div>
      </header>
      <main className="articleShell" style={{ maxWidth: 1180, "--accent": "#fc6fcf" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Source mirror › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>
              {completeRaw
                ? "A complete Namu raw document is available, so this preview renders the preserved source directly."
                : "The mirror exposes only part of the document as Namu raw syntax. Missing source regions are therefore filled from the same stored mirror HTML in source order instead of being silently dropped."}
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "18px 0 26px" }}>
          <Metric label="Render mode" value={completeRaw ? "DIRECT RAW" : "SOURCE + FALLBACK"} />
          <Metric label="Mirror raw coverage" value={`${bundle.estimatedRawCoverage}%`} />
          <Metric label="Visible raw blocks" value={String(visible.visibleRawBlocks)} />
          <Metric label="Rendered sections" value={String(hybrid.renderedSections)} />
          <Metric label="Skipped controls" value={String(hybrid.skippedControlChunks)} />
          <Metric label="Mapped images" value={String(Object.keys(assets).length)} />
        </div>

        <section>
          <h2 className="sectionTitle">Document preview</h2>
          {completeRaw
            ? <NamuRawRenderer nodes={completeRawNodes} assets={assets} />
            : <NamuHybridRenderer chunks={hybrid.chunks} assets={assets} />}
        </section>

        <details style={{ marginTop: 28 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Source diagnostics</summary>
          <div style={{ marginTop: 12, padding: 16, border: "1px solid #d7dde5", borderRadius: 8, background: "#f8fafc" }}>
            <p style={{ marginTop: 0 }}>
              Current source format: <strong>{source.source_format || "namu mirror hybrid"}</strong>. The recovered raw subset contains {bundle.rawBlockCount} raw blocks; {hybrid.renderedSections} rendered sections remain necessary until a complete raw source is acquired.
            </p>
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
