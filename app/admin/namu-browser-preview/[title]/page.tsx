import { notFound } from "next/navigation";
import NamuBrowserArtifactRenderer, { type BrowserArtifactAssetMap } from "../../../../components/wiki/NamuBrowserArtifactRenderer";
import { buildNamuResolvedAssetMap } from "../../../../lib/namuStoredAssets";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = "wiki-media";

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

type BrowserSource = {
  id: string;
  source_title: string;
  root_title: string;
  source_browser_article_html: string | null;
  source_browser_style_css: string | null;
  source_browser_capture_meta: Record<string, unknown> | null;
  source_browser_capture_version: string | null;
  source_browser_captured_at: string | null;
};

type AssetRow = {
  source_ref: string;
  label: string | null;
  resolved_url: string | null;
  storage_path: string | null;
  metadata: Record<string, unknown> | null;
};

type CaptureRow = {
  source_url: string | null;
  storage_path: string | null;
  captured_at: string | null;
  metadata: Record<string, unknown> | null;
};

function publicStorageUrl(storagePath: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath.replace(/^\/+/, "")}`;
}

function addAssetKey(output: BrowserArtifactAssetMap, key: unknown, url: string, overwrite = false) {
  if (typeof key !== "string" || !key.trim()) return;
  const raw = key.trim();
  if (overwrite || !output[raw]) output[raw] = url;
  try {
    const absolute = new URL(raw, "https://namu.wiki").toString();
    if (overwrite || !output[absolute]) output[absolute] = url;
  } catch {}
}

function browserAssetMap(rows: AssetRow[], captures: CaptureRow[]) {
  const output: BrowserArtifactAssetMap = { ...buildNamuResolvedAssetMap(rows) };

  for (const row of rows) {
    const url = row.resolved_url;
    if (!url) continue;
    for (const key of [row.source_ref, row.label, row.metadata?.original_url, row.metadata?.enrichment_url]) {
      addAssetKey(output, key, url);
    }
  }

  // Browser staging is the canonical fallback for one-click cloning. It maps
  // the exact CDN URL seen in the rendered DOM to the bytes captured from the
  // user's normal Chrome session, even when no semantic queue row existed.
  // Rows arrive newest first, so do not let older captures overwrite them.
  for (const row of captures) {
    if (!row.storage_path) continue;
    const url = publicStorageUrl(row.storage_path);
    addAssetKey(output, row.source_url, url);
    addAssetKey(output, row.metadata?.original_url, url);
  }

  return output;
}

export default async function NamuBrowserPreviewPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);

  const docs = await db<BrowserSource[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
    `&select=id,source_title,root_title,source_browser_article_html,source_browser_style_css,source_browser_capture_meta,source_browser_capture_version,source_browser_captured_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const [assetRows, captureRows] = await Promise.all([
    db<AssetRow[]>(
      `source_asset_queue?root_title=eq.${encodeURIComponent(source.root_title)}` +
      `&asset_type=eq.image&select=source_ref,label,resolved_url,storage_path,metadata`,
    ),
    db<CaptureRow[]>(
      `namu_capture_staging?root_title=eq.${encodeURIComponent(source.root_title)}` +
      `&source_title=eq.${encodeURIComponent(source.source_title)}` +
      `&storage_path=not.is.null&select=source_url,storage_path,captured_at,metadata&order=captured_at.desc&limit=1000`,
    ),
  ]);

  const assets = browserAssetMap(assetRows, captureRows);
  const browserHtml = source.source_browser_article_html?.trim() || "";
  const styleCss = source.source_browser_style_css?.trim() || "";
  const meta = source.source_browser_capture_meta || {};
  const capturedWidth = Number(meta.renderedWidth || 0) || null;

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMU BROWSER ARTIFACT · COMPUTED SNAPSHOT</div>
      </header>
      <main className="articleShell" style={{ maxWidth: 1280, "--accent": "#fc6fcf" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Browser Artifact › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>
              This preview bypasses NamuMark reconstruction. It replays the final DOM and computed layout captured from normal Chrome after NamuWiki has already executed templates and conditions.
            </p>
            <p style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <a href={`/admin/namu-raw-preview/${encodeURIComponent(source.source_title)}`}>Open mirror reconstruction</a>
              <a href={`https://namu.wiki/w/${encodeURIComponent(source.source_title)}`} target="_blank" rel="noreferrer">Open original NamuWiki</a>
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, margin: "18px 0 26px" }}>
          <Metric label="Presentation source" value={browserHtml ? "NORMAL CHROME ARTIFACT" : "NOT CAPTURED"} />
          <Metric label="Capture version" value={source.source_browser_capture_version || "—"} />
          <Metric label="Captured at" value={source.source_browser_captured_at ? new Date(source.source_browser_captured_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—"} />
          <Metric label="Article bytes" value={String(meta.article_bytes || meta.articleBytes || "—")} />
          <Metric label="Style bytes" value={String(meta.style_bytes || meta.styleBytes || "—")} />
          <Metric label="DOM nodes" value={String(meta.nodeCount || "—")} />
          <Metric label="Styled nodes" value={String(meta.styledNodes || "—")} />
          <Metric label="Pseudo rules" value={String(meta.pseudoRuleCount || "0")} />
          <Metric label="Resolved asset keys" value={String(Object.keys(assets).length)} />
        </div>

        {!browserHtml ? (
          <section style={{ padding: 20, border: "1px solid #d7dde5", borderRadius: 8, background: "#fff" }}>
            No browser artifact has been captured for this document yet. Reload the unpacked Chrome extension, open this NamuWiki document in normal Chrome, and press <strong>Capture DOM + images</strong>.
          </section>
        ) : (
          <section>
            <h2 className="sectionTitle">Browser artifact replay</h2>
            <div style={{ overflowX: "auto", overflowY: "visible", paddingBottom: 16 }}>
              <NamuBrowserArtifactRenderer html={browserHtml} styleCss={styleCss} assets={assets} capturedWidth={capturedWidth} />
            </div>
          </section>
        )}

        <details style={{ marginTop: 28 }}>
          <summary style={{ cursor: "pointer", fontWeight: 700 }}>Browser capture diagnostics</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12, lineHeight: 1.5 }}>{JSON.stringify(meta, null, 2)}</pre>
        </details>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div style={{ border: "1px solid #d7dde5", borderRadius: 8, padding: 14, background: "white" }}><div style={{ fontSize: 12, color: "#667085" }}>{label}</div><div style={{ marginTop: 4, fontSize: 16, fontWeight: 700, overflowWrap: "anywhere" }}>{value}</div></div>;
}
