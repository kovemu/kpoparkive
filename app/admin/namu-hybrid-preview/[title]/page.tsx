import { notFound } from "next/navigation";
import NamuHybridRenderer from "../../../../components/wiki/NamuHybridRenderer";
import { parseNamuHybridSegments } from "../../../../lib/namuHybrid";
import { extractMirrorRawBundle, type RawSourceSegment } from "../../../../lib/namuRawSource";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type AssetRow = {
  source_ref: string;
  resolved_url: string | null;
  metadata: Record<string, unknown> | null;
};

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function fileKey(ref: string) {
  return ref.normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function usableAssetUrl(row: AssetRow) {
  if (row.resolved_url) return row.resolved_url;
  const candidate = row.metadata?.enrichment_url;
  return typeof candidate === "string" && /^https?:\/\//i.test(candidate) ? candidate : null;
}

export default async function NamuHybridPreviewPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);
  const docs = await db<{
    id: string;
    source_title: string;
    raw_html: string;
    source_raw_segments: RawSourceSegment[] | null;
    fetched_at: string;
  }[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=id,source_title,raw_html,source_raw_segments,fetched_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const bundle = extractMirrorRawBundle(source.raw_html || "");
  const segments = source.source_raw_segments?.length ? source.source_raw_segments : bundle.segments;
  const hybrid = parseNamuHybridSegments(segments);
  const assetRows = await db<AssetRow[]>(
    `source_asset_queue?source_document_id=eq.${source.id}&asset_type=eq.image&select=source_ref,resolved_url,metadata`,
  );
  const assets: Record<string, string> = { ...bundle.renderedFileMap };
  for (const row of assetRows) {
    const url = usableAssetUrl(row);
    if (url) assets[fileKey(row.source_ref)] = url;
  }

  return <>
    <meta name="robots" content="noindex,nofollow,noarchive" />
    <header className="siteHeader">
      <a className="brand" href="/">Kpoparkive</a>
      <div className="draftBadge">NAMU HYBRID MIRROR · v2</div>
    </header>
    <main className="articleShell" style={{ maxWidth: 1180, "--accent": "#fc6fcf" } as React.CSSProperties}>
      <div className="articleHeader">
        <div>
          <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Hybrid mirror › {source.source_title}</div>
          <h1>{source.source_title}</h1>
          <p>Raw Namu syntax and rendered mirror HTML stay in source order. Safe template fallbacks and mirror-blank values are recovered only when the same stored document proves a unique match; ambiguous values remain blank.</p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10, margin: "18px 0 26px" }}>
        <Metric label="Source segments" value={String(segments.length)} />
        <Metric label="Raw chunks" value={String(hybrid.rawChunks)} />
        <Metric label="Rendered chunks" value={String(hybrid.renderedChunks)} />
        <Metric label="Skipped controls" value={String(hybrid.skippedControlChunks)} />
        <Metric label="Recovered values" value={String(hybrid.recoveredValues)} />
        <Metric label="Raw nodes" value={String(hybrid.rawNodes)} />
        <Metric label="Rendered sections" value={String(hybrid.renderedSections)} />
        <Metric label="Mapped images" value={String(Object.keys(assets).length)} />
      </div>

      <NamuHybridRenderer chunks={hybrid.chunks} assets={assets} />
    </main>
  </>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ border: "1px solid #d7dde5", borderRadius: 8, padding: 12, background: "white" }}>
    <div style={{ fontSize: 12, color: "#667085" }}>{label}</div>
    <div style={{ marginTop: 3, fontSize: 20, fontWeight: 700 }}>{value}</div>
  </div>;
}
