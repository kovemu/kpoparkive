import { notFound } from "next/navigation";
import { parse } from "node-html-parser";
import { buildNamuResolvedAssetMap } from "../../../../lib/namuStoredAssets";
import { createNamuAssetLookup } from "../../../../lib/namuAssetLookup";
import TheTreeRuntimeBridge from "../../thetree-frontend-poc/TheTreeRuntimeBridge";
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

function isVideoAssetUrl(value: string) {
  try {
    const url = new URL(value);
    return /\.(?:mp4|webm|mov)$/i.test(url.pathname);
  } catch {
    return /\.(?:mp4|webm|mov)(?:$|[?#])/i.test(value);
  }
}

function hydrateResolvedMedia(image: ReturnType<typeof parse>["prototype"] extends never ? never : any, resolved: string) {
  if (isVideoAssetUrl(resolved)) {
    image.setAttribute("data-video-src", resolved);
    image.removeAttribute("data-src");
    const className = (image.getAttribute("class") || "")
      .replace(/\bwiki-image-loading\b/g, "")
      .replace(/\s+/g, " ")
      .trim();
    image.setAttribute("class", className.includes("wiki-image") ? className : `${className} wiki-image`.trim());
    return;
  }

  image.setAttribute("src", resolved);
  image.removeAttribute("data-src");
  image.removeAttribute("data-video-src");
  const className = (image.getAttribute("class") || "").replace(/\bwiki-image-loading\b/g, "").replace(/\s+/g, " ").trim();
  if (className) image.setAttribute("class", className);
  else image.removeAttribute("class");
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
    else if (/^https:\/\/namu\.wiki\/w\//i.test(href)) node.setAttribute("href", href.replace(/^https:\/\/namu\.wiki/i, ""));
    // Relative /w/* links are Kpoparkive internal links and remain unchanged.
  }

  for (const image of root.querySelectorAll("img")) {
    const alt = normalizeWikiKey(image.getAttribute("alt") || "");
    const resolved = alt
      ? lookup(alt) || lookup(`파일:${alt}`) || lookup(fileKey(alt))
      : undefined;
    if (resolved) {
      hydrateResolvedMedia(image, resolved);
      continue;
    }

    const videoSrc = image.getAttribute("data-video-src") || "";
    if (videoSrc.startsWith(`${SUPABASE_URL}/storage/`)) continue;

    const lazySrc = image.getAttribute("data-src") || "";
    if (lazySrc.startsWith(`${SUPABASE_URL}/storage/`)) {
      if (isVideoAssetUrl(lazySrc)) hydrateResolvedMedia(image, lazySrc);
      else {
        image.setAttribute("src", lazySrc);
        image.removeAttribute("data-src");
      }
    } else if (lazySrc) {
      image.removeAttribute("data-src");
    }
  }

  return root.querySelector("#kpop-namumark-poc-root")?.innerHTML || "";
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
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

  const assetRows = await dbAll<AssetRow>(
    `source_asset_queue?root_title=eq.${encodeURIComponent(source.root_title)}&asset_type=eq.image` +
      `&select=id,asset_type,source_ref,label,status,resolved_url,storage_path,metadata&order=id.asc`,
  );
  const resolvedRows = assetRows.filter((row) => row.status === "resolved");
  const assets: Record<string, string> = {};
  for (const row of resolvedRows) {
    const url = row.resolved_url || (typeof row.metadata?.enrichment_url === "string" ? row.metadata.enrichment_url : null);
    if (!url) continue;
    assets[fileKey(row.source_ref)] = url;
    if (row.label) assets[fileKey(row.label)] = url;
  }
  const hydratedAssets = buildNamuResolvedAssetMap(resolvedRows, assets);
  const renderedHtml = source.source_namumark_html ? sanitizeAndHydrate(source.source_namumark_html, hydratedAssets) : "";
  const meta = source.source_namumark_meta || {};
  const unresolved = Array.isArray(meta.unresolvedIncludes) ? meta.unresolvedIncludes.map(String) : [];
  const requiredFiles = stringArray(meta.requiredFiles);
  const missingFiles = stringArray(meta.missingFiles);

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
            <p>This page renders the captured edit-source NamuMark through the current The Tree compatibility path.</p>
            <p><a href={`/w/${source.source_title.split("/").map(encodeURIComponent).join("/")}`}>Open Kpoparkive /w route →</a></p>
            <p><a href={`/admin/thetree-frontend-poc/${encodeURIComponent(source.source_title)}`}>Open The Tree frontend baseline →</a></p>
          </div>
        </div>

        <div className="namumarkPocMetrics">
          <Metric label="Engine" value={source.source_namumark_engine || "NOT RENDERED"} />
          <Metric label="Raw source" value={source.source_wikitext ? `${source.source_wikitext.length.toLocaleString()} chars` : "NONE"} />
          <Metric label="Engine HTML" value={source.source_namumark_html ? `${source.source_namumark_html.length.toLocaleString()} chars` : "NONE"} />
          <Metric label="Required files" value={requiredFiles.length ? String(requiredFiles.length) : String(meta.files || 0)} />
          <Metric label="Missing files" value={String(missingFiles.length || meta.missingFileCount || 0)} />
          <Metric label="Unresolved includes" value={String(unresolved.length)} />
        </div>

        {!renderedHtml ? (
          <section className="namumarkPocEmpty">
            <h2>No engine render yet</h2>
            <p>Run the selected NamuMark engine POC for <code>{source.source_title}</code>, then refresh this page.</p>
          </section>
        ) : (
          <>
            {unresolved.length > 0 && (
              <details className="namumarkPocWarning" open>
                <summary>{unresolved.length} include templates are not captured yet</summary>
                <div>{unresolved.slice(0, 60).join(" · ")}{unresolved.length > 60 ? ` · +${unresolved.length - 60} more` : ""}</div>
              </details>
            )}
            <TheTreeRuntimeBridge />
            <section className="namumarkPocDocument wiki-content" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
          </>
        )}

        <details className="namumarkPocDiagnostics">
          <summary>POC diagnostics</summary>
          <pre>{JSON.stringify({
            engine: source.source_namumark_engine,
            version: source.source_namumark_engine_version,
            renderedAt: source.source_namumark_rendered_at,
            requiredFiles,
            missingFiles,
            meta,
            assetRowsLoaded: assetRows.length,
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
