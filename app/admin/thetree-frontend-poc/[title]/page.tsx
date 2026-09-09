import { notFound } from "next/navigation";
import { parse } from "node-html-parser";
import { buildNamuResolvedAssetMap } from "../../../../lib/namuStoredAssets";
import { createNamuAssetLookup } from "../../../../lib/namuAssetLookup";
import TheTreeRuntimeBridge from "../TheTreeRuntimeBridge";
import "../baseline.css";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const THETREE_FRONTEND_COMMIT = "dec4b743309f6e18867affd981b802c5d542acfb";
const THETREE_FRONTEND_CSS = `https://cdn.jsdelivr.net/gh/wjdgustn/thetree-frontend@${THETREE_FRONTEND_COMMIT}/src/assets/css/wiki.css`;

type DocRow = {
  id: string;
  source_title: string;
  root_title: string;
  source_wikitext: string | null;
  source_namumark_html: string | null;
  source_namumark_meta: Record<string, unknown> | null;
  source_namumark_engine: string | null;
  source_namumark_engine_version: string | null;
  source_namumark_rendered_at: string | null;
};

type AssetRow = {
  id: string;
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

async function dbAll<T>(path: string, pageSize = 1000, maxRows = 10000): Promise<T[]> {
  const rows: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db<T[]>(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`Supabase pagination reached ${maxRows} rows for ${path}`);
}

function normalizeWikiKey(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function fileKey(ref: string) {
  return normalizeWikiKey(ref).replace(/^(?:파일|File):/i, "");
}

function sanitizeAndHydrate(html: string, assets: Record<string, string>) {
  const root = parse(`<div id="kpop-thetree-baseline-root">${html}</div>`);
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
    const lazySrc = image.getAttribute("data-src") || "";
    if (/^https?:\/\//i.test(lazySrc)) {
      image.setAttribute("src", lazySrc);
      image.removeAttribute("data-src");
      const className = (image.getAttribute("class") || "")
        .replace(/\bwiki-image-loading\b/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (className) image.setAttribute("class", className);
      else image.removeAttribute("class");
      continue;
    }

    const alt = normalizeWikiKey(image.getAttribute("alt") || "");
    if (!alt) continue;
    const resolved = lookup(alt) || lookup(`파일:${alt}`) || lookup(fileKey(alt));
    if (resolved) image.setAttribute("src", resolved);
  }

  return root.querySelector("#kpop-thetree-baseline-root")?.innerHTML || "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export default async function TheTreeFrontendPocPage({ params }: { params: Promise<{ title: string }> }) {
  const { title: encodedTitle } = await params;
  const title = decodeURIComponent(encodedTitle);
  const docs = await db<DocRow[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      `&select=id,source_title,root_title,source_wikitext,source_namumark_html,source_namumark_meta,source_namumark_engine,source_namumark_engine_version,source_namumark_rendered_at&limit=1`,
  );
  const source = docs[0];
  if (!source) notFound();

  const assetRows = await dbAll<AssetRow>(
    `source_asset_queue?root_title=eq.${encodeURIComponent(source.root_title)}&asset_type=eq.image` +
      `&select=id,asset_type,source_ref,label,status,resolved_url,storage_path,metadata&order=id.asc`,
  );

  const assets: Record<string, string> = {};
  for (const row of assetRows) {
    const url = row.resolved_url || (typeof row.metadata?.enrichment_url === "string" ? row.metadata.enrichment_url : null);
    if (!url) continue;
    assets[fileKey(row.source_ref)] = url;
    if (row.label) assets[fileKey(row.label)] = url;
  }

  const hydratedAssets = buildNamuResolvedAssetMap(assetRows, assets);
  const renderedHtml = source.source_namumark_html ? sanitizeAndHydrate(source.source_namumark_html, hydratedAssets) : "";
  const meta = source.source_namumark_meta || {};
  const requiredFiles = stringArray(meta.requiredFiles);
  const missingFiles = stringArray(meta.missingFiles);

  return (
    <>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <link rel="stylesheet" href={THETREE_FRONTEND_CSS} />
      <main className="thetreeBaselineShell">
        <div className="thetreeBaselineHeader">
          <div>
            <div>Kpoparkive › The Tree official frontend baseline › {source.source_title}</div>
            <h1>{source.source_title}</h1>
            <p>
              Unmodified The Tree renderer HTML + the official The Tree frontend wiki.css pinned to a known commit.
              This isolates renderer compatibility from Kpoparkive host CSS.
            </p>
          </div>
          <div className="thetreeBaselineBadge">OFFICIAL FRONTEND BASELINE</div>
        </div>

        <div className="thetreeBaselineMetrics">
          <Metric label="Renderer" value={source.source_namumark_engine || "NOT RENDERED"} />
          <Metric label="Renderer commit" value={source.source_namumark_engine_version || "-"} />
          <Metric label="Frontend commit" value={THETREE_FRONTEND_COMMIT.slice(0, 12)} />
          <Metric label="Raw source" value={source.source_wikitext ? `${source.source_wikitext.length.toLocaleString()} chars` : "NONE"} />
          <Metric label="Required files" value={requiredFiles.length ? String(requiredFiles.length) : String(meta.files || 0)} />
          <Metric label="Missing files" value={String(missingFiles.length || meta.missingFileCount || 0)} />
        </div>

        <div className="thetreeBaselineLinks">
          <a href={`/admin/namumark-poc/${encodeURIComponent(source.source_title)}`}>Kpoparkive host integration</a>
          <a href={`/admin/namu-browser-preview/${encodeURIComponent(source.source_title)}`}>Browser Artifact reference</a>
          <a href={`https://namu.wiki/w/${encodeURIComponent(source.source_title)}`}>NamuWiki original</a>
        </div>

        <div className="thetreeBaselineNote">
          The stylesheet is referenced from the upstream frontend repository at runtime and is not copied into Kpoparkive.
          The small client bridge below only reproduces runtime class-toggle behavior needed by template tabs and heading folding.
        </div>

        {renderedHtml ? (
          <>
            <TheTreeRuntimeBridge />
            <section className="thetreeWikiBaseline wiki-content" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </>
        ) : (
          <div className="thetreeBaselineNote">Run <code>npm.cmd run namu:engine-thetree -- {source.source_title}</code> first.</div>
        )}

        <details className="thetreeBaselineDiagnostics">
          <summary>Baseline diagnostics</summary>
          <pre>{JSON.stringify({
            renderer: source.source_namumark_engine,
            rendererVersion: source.source_namumark_engine_version,
            frontendCommit: THETREE_FRONTEND_COMMIT,
            renderedAt: source.source_namumark_rendered_at,
            requiredFiles,
            missingFiles,
            assetRowsLoaded: assetRows.length,
            capturedAssets: Object.keys(hydratedAssets).length,
            meta,
          }, null, 2)}</pre>
        </details>
      </main>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="thetreeBaselineMetric"><div>{label}</div><strong>{value}</strong></div>;
}
