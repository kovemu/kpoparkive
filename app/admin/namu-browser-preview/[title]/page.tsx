import { notFound } from "next/navigation";
import NamuMirrorDomRenderer from "../../../../components/wiki/NamuMirrorDomRenderer";
import { buildNamuResolvedAssetMap } from "../../../../lib/namuStoredAssets";

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

type BrowserSource = {
  id: string;
  source_title: string;
  root_title: string;
  source_template_css: string | null;
  source_browser_article_html: string | null;
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

export default async function NamuBrowserPreviewPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);

  const docs = await db<BrowserSource[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
    `&select=id,source_title,root_title,source_template_css,source_browser_article_html,source_browser_capture_meta,source_browser_capture_version,source_browser_captured_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const assetRows = await db<AssetRow[]>(
    `source_asset_queue?root_title=eq.${encodeURIComponent(source.root_title)}` +
    `&asset_type=eq.image&select=source_ref,label,resolved_url,storage_path,metadata`,
  );
  const assets = buildNamuResolvedAssetMap(assetRows);
  const browserHtml = source.source_browser_article_html?.trim() || "";
  const meta = source.source_browser_capture_meta || {};

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMU BROWSER DOM · FINAL RENDER CAPTURE</div>
      </header>
      <main className="articleShell" style={{ maxWidth: 1180, "--accent": "#fc6fcf" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Browser DOM › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>
              This preview uses the final article DOM captured from normal Chrome after NamuWiki has already executed its templates and conditions. Images are replaced through the same Supabase asset map used by the importer.
            </p>
            <p style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <a href={`/admin/namu-raw-preview/${encodeURIComponent(source.source_title)}`}>Open mirror DOM preview</a>
              <a href={`https://namu.wiki/w/${encodeURIComponent(source.source_title)}`} target="_blank" rel="noreferrer">Open original NamuWiki</a>
            </p>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, margin: "18px 0 26px" }}>
          <Metric label="Presentation source" value={browserHtml ? "NORMAL CHROME DOM" : "NOT CAPTURED"} />
          <Metric label="Capture version" value={source.source_browser_capture_version || "—"} />
          <Metric label="Captured at" value={source.source_browser_captured_at ? new Date(source.source_browser_captured_at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }) : "—"} />
          <Metric label="Article bytes" value={String(meta.article_bytes || meta.articleBytes || "—")} />
          <Metric label="DOM nodes" value={String(meta.nodeCount || "—")} />
          <Metric label="Resolved asset keys" value={String(Object.keys(assets).length)} />
        </div>

        {!browserHtml ? (
          <section style={{ padding: 20, border: "1px solid #d7dde5", borderRadius: 8, background: "#fff" }}>
            No browser DOM has been captured for this document yet. Reload the unpacked Chrome extension, open this NamuWiki document in normal Chrome, and press <strong>Capture this page</strong>.
          </section>
        ) : (
          <section>
            <h2 className="sectionTitle">Browser-rendered document preview</h2>
            <NamuMirrorDomRenderer html={browserHtml} assets={assets} templateCss={source.source_template_css} />
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
  return <div style={{ border: "1px solid #d7dde5", borderRadius: 8, padding: 14, background: "white" }}><div style={{ fontSize: 12, color: "#667085" }}>{label}</div><div style={{ marginTop: 4, fontSize: 17, fontWeight: 700, overflowWrap: "anywhere" }}>{value}</div></div>;
}
