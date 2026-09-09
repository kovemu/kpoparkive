import { notFound } from "next/navigation";
import { parse } from "node-html-parser";
import { buildNamuResolvedAssetMap } from "../../../../lib/namuStoredAssets";
import { createNamuAssetLookup } from "../../../../lib/namuAssetLookup";
import "../poc.css";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type DocRow = {
  id: string;
  source_title: string;
  root_title: string;
  source_wikitext: string | null;
  source_namumark_html: string | null;
  source_namumark_js: string | null;
  source_namumark_meta: Record<string, unknown> | null;
  source_namumark_engine: string | null;
  source_namumark_engine_version: string | null;
  source_namumark_rendered_at: string | null;
};

type AssetRow = {
  asset_type: string;
  source_ref: string;
  label: string | null;
  status: string;
  resolved_url: string | null;
  storage_path: string | null;
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

function sanitizeAndHydrate(html: string, assets: Record<string, string>) {
  const root = parse(`<div id="kpop-namumark-poc-root">${html}</div>`);
  const lookup = createNamuAssetLookup(assets);

  for (const script of root.querySelectorAll("script")) script.remove();
  for (const node of root.querySelectorAll("*")) {
    for (const name of Object.keys(node.attributes)) {
      if (/^on/i.test(name)) node.removeAttribute(name);
    }
    const href = node.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) node.removeAttribute("href");
    else if (href.startsWith("/w/")) node.setAttribute("href", `https://namu.wiki${href}`);
  }

  for (const image of root.querySelectorAll("img")) {
    const src = image.getAttribute("src") || "";
    if (!src.startsWith("/image/")) continue;
    const alt = (image.getAttribute("alt") || "").trim();
    const resolved = alt ? lookup(alt) || lookup(`파일:${alt}`) : null;
    if (resolved) image.setAttribute("src", resolved);
  }

  return root.querySelector("#kpop-namumark-poc-root")?.innerHTML || "";
}

export default async function NamuMarkPocPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);
  const docs = await db<DocRow[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      `&select=id,source_title,root_title,source_wikitext,source_namumark_html,source_namumark_js,source_namumark_meta,source_namumark_engine,source_namumark_engine_version,source_namumark_rendered_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const assetRows = await db<AssetRow[]>(
    `source_asset_queue?root_title=eq.${encodeURIComponent(source.root_title)}&asset_type=eq.image` +
      `&select=asset_type,source_ref,label,status,resolved_url,storage_path,metadata&limit=5000`,
  );
  const assets: Record<string, string> = {};
  for (const row of assetRows) {
    const url = row.resolved_url || (typeof row.metadata?.enrichment_url === "string" ? row.metadata.enrichment_url : null);
    if (url) assets[fileKey(row.source_ref)] = url;
  }
  const hydratedAssets = buildNamuResolvedAssetMap(assetRows, assets);
  const renderedHtml = source.source_namumark_html ? sanitizeAndHydrate(source.source_namumark_html, hydratedAssets) : "";
  const meta = source.source_namumark_meta || {};
  const unresolved = Array.isArray(meta.unresolvedIncludes) ? meta.unresolvedIncludes.map(String) : [];

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">NAMUMARK ENGINE POC</div>
      </header>
      <main className="namumarkPocShell">
        <div className="namumarkPocHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › NamuMark engine POC › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>This page renders the captured edit-source NamuMark through an external compatibility engine. It is an architecture experiment, not the production renderer.</p>
          </div>
        </div>

        <div className="namumarkPocMetrics">
          <Metric label="Engine" value={source.source_namumark_engine || "NOT RENDERED"} />
          <Metric label="Raw source" value={source.source_wikitext ? `${source.source_wikitext.length.toLocaleString()} chars` : "NONE"} />
          <Metric label="Engine HTML" value={source.source_namumark_html ? `${source.source_namumark_html.length.toLocaleString()} chars` : "NONE"} />
          <Metric label="Unresolved includes" value={String(unresolved.length)} />
        </div>

        {!renderedHtml ? (
          <section className="namumarkPocEmpty">
            <h2>No engine render yet</h2>
            <p>Run <code>npm.cmd run namu:engine-poc -- {source.source_title}</code> on the local project, then refresh this page after deployment.</p>
          </section>
        ) : (
          <>
            {unresolved.length > 0 && (
              <details className="namumarkPocWarning" open>
                <summary>{unresolved.length} include templates are not captured yet</summary>
                <div>{unresolved.slice(0, 60).join(" · ")}{unresolved.length > 60 ? ` · +${unresolved.length - 60} more` : ""}</div>
              </details>
            )}
            <section className="namumarkPocDocument" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </>
        )}

        <details className="namumarkPocDiagnostics">
          <summary>POC diagnostics</summary>
          <pre>{JSON.stringify({
            engine: source.source_namumark_engine,
            version: source.source_namumark_engine_version,
            renderedAt: source.source_namumark_rendered_at,
            meta,
            capturedAssets: Object.keys(hydratedAssets).length,
            engineJsChars: source.source_namumark_js?.length || 0,
          }, null, 2)}</pre>
        </details>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="namumarkPocMetric"><div>{label}</div><strong>{value}</strong></div>;
}
