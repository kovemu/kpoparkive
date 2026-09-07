import { notFound } from "next/navigation";
import NamuRawRenderer from "../../../../components/wiki/NamuRawRenderer";
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
  return ref.trim().replace(/^(?:파일|File):/i, "");
}

function usableAssetUrl(row: AssetRow) {
  if (row.resolved_url) return row.resolved_url;
  const candidate = row.metadata?.enrichment_url;
  return typeof candidate === "string" && /^https?:\/\//i.test(candidate) ? candidate : null;
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
        <div className="draftBadge">NAMU RAW RENDERER · v2</div>
      </header>
      <main className="articleShell" style={{ maxWidth: 1180 }}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Raw renderer › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>Original Namu syntax is rendered directly. Template control branches stay preserved in storage but are excluded from visible article content.</p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "18px 0" }}>
          <Metric label="Raw blocks" value={String(bundle.rawBlockCount)} />
          <Metric label="Visible raw blocks" value={String(visible.visibleRawBlocks)} />
          <Metric label="Skipped control blocks" value={String(visible.skippedControlBlocks)} />
          <Metric label="Estimated raw coverage" value={`${bundle.estimatedRawCoverage}%`} />
          <Metric label="Parsed raw nodes" value={String(visible.nodes.length)} />
          <Metric label="Mapped images" value={String(Object.keys(assets).length)} />
        </div>

        <section>
          <h2 className="sectionTitle">Direct raw rendering</h2>
          <NamuRawRenderer nodes={visible.nodes} assets={assets} />
        </section>

        <details style={{ marginTop: 28 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Recovered source</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", padding: 18, border: "1px solid #d7dde5", borderRadius: 8, background: "#f8fafc", fontSize: 13, lineHeight: 1.55 }}>{raw || "No raw syntax blocks recovered."}</pre>
        </details>

        <section>
          <h2 className="sectionTitle">Recovered file references</h2>
          <ul className="wikiList">{bundle.fileRefs.slice(0, 300).map((file) => <li key={file}>{file}</li>)}</ul>
        </section>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ border: "1px solid #d7dde5", borderRadius: 8, padding: 14, background: "white" }}><div style={{ fontSize: 12, color: "#667085" }}>{label}</div><div style={{ marginTop: 4, fontSize: 22, fontWeight: 700 }}>{value}</div></div>;
}
