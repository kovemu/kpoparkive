import { parse } from "node-html-parser";
import { redirect } from "next/navigation";
import { buildNamuResolvedAssetMap } from "../../../lib/namuStoredAssets";
import { createNamuAssetLookup } from "../../../lib/namuAssetLookup";
import { stripNamuOperationalHtml } from "../../../lib/namuOperationalNotices";
import TheTreeRuntimeBridge from "../../admin/thetree-frontend-poc/TheTreeRuntimeBridge";
import "../wiki.css";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const THETREE_FRONTEND_COMMIT = "dec4b743309f6e18867affd981b802c5d542acfb";
const THETREE_FRONTEND_CSS = `https://cdn.jsdelivr.net/gh/wjdgustn/thetree-frontend@${THETREE_FRONTEND_COMMIT}/src/assets/css/wiki.css`;

type DocRow = {
  id: string;
  source_title: string;
  root_title: string;
  source_namumark_html: string | null;
  source_namumark_engine: string | null;
  source_namumark_rendered_at: string | null;
  content_status: string;
  content_revision_no: number | null;
  content_namumark_html: string | null;
  content_namumark_meta: Record<string, any> | null;
  content_namumark_rendered_at: string | null;
  published_namumark_html: string | null;
};

type AssetRow = {
  source_ref: string;
  label: string | null;
  status: string;
  resolved_url: string | null;
  storage_path: string | null;
  metadata: Record<string, unknown> | null;
};

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");

  const delays = [350, 900, 1800];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` },
        cache: "no-store",
      });
      const text = await response.text();
      if (response.ok) return (text ? JSON.parse(text) : null) as T;

      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 502 ||
        (response.status === 500 && /(?:57014|statement timeout|canceling statement|PGRST002)/i.test(text));

      const error = new Error(`${response.status} ${text}`);
      lastError = error;
      if (!retryable || attempt >= delays.length) throw error;
    } catch (error) {
      const current = error instanceof Error ? error : new Error(String(error));
      lastError = current;
      if (attempt >= delays.length) throw current;
      if (!/(?:fetch failed|network|ECONN|ETIMEDOUT|57014|statement timeout|canceling statement|PGRST002|502|503|504|429|408)/i.test(current.message)) {
        throw current;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }

  throw lastError || new Error("Supabase request failed");
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

function hydrateResolvedMedia(image: any, resolved: string) {
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
  const className = (image.getAttribute("class") || "")
    .replace(/\bwiki-image-loading\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (className) image.setAttribute("class", className);
  else image.removeAttribute("class");
}

function publicEditorPath(title: string) {
  const encoded = title
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `/edit/${encoded}`;
}

function rewriteInternalHref(href: string, sourceTitle: string) {
  if (/^\/edit\//i.test(href)) return publicEditorPath(sourceTitle);
  if (/^https:\/\/namu\.wiki\/w\//i.test(href)) return href.replace(/^https:\/\/namu\.wiki/i, "");
  return href;
}

function sanitizeAndHydrate(html: string, assets: Record<string, string>, sourceTitle: string) {
  const root = parse(`<div id="kpop-raw-wiki-root">${html}</div>`);
  const lookup = createNamuAssetLookup(assets);

  for (const script of root.querySelectorAll("script")) script.remove();
  stripNamuOperationalHtml(root);

  for (const node of root.querySelectorAll("*")) {
    for (const name of Object.keys(node.attributes)) {
      if (/^on/i.test(name)) node.removeAttribute(name);
    }

    // Public wiki intentionally has no hover tooltips. The Tree and NamuWiki
    // frequently emit canonical Korean document names/footnote text via title=,
    // which leaks untranslated text and creates noisy browser-native tooltips.
    // Keep aria-label for accessibility, but strip title from every element.
    node.removeAttribute("title");

    const href = node.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) node.removeAttribute("href");
    else if (href) node.setAttribute("href", rewriteInternalHref(href, sourceTitle));
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
        image.setAttribute("loading", "lazy");
      }
    } else if (lazySrc) {
      image.removeAttribute("data-src");
    }
  }

  return root.querySelector("#kpop-raw-wiki-root")?.innerHTML || "";
}

function sourceTitleFromSegments(segments: string[]) {
  return segments.map((segment) => decodeURIComponent(segment)).join("/").normalize("NFKC").trim();
}

export default async function RawWikiPage({
  params,
}: {
  params: Promise<{ title: string[] }>;
}) {
  const { title: segments } = await params;
  const sourceTitle = sourceTitleFromSegments(segments);

  let docs = await db<DocRow[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(sourceTitle)}` +
      `&select=id,source_title,root_title,source_namumark_html,source_namumark_engine,source_namumark_rendered_at,content_status,content_revision_no,content_namumark_html,content_namumark_meta,content_namumark_rendered_at,published_namumark_html&limit=1`,
  );

  if (!docs[0]) {
    const candidates = await db<DocRow[]>(
      `source_documents?source=eq.namu_mirror&source_title=ilike.${encodeURIComponent(sourceTitle)}` +
        `&select=id,source_title,root_title,source_namumark_html,source_namumark_engine,source_namumark_rendered_at,content_status,content_revision_no,content_namumark_html,content_namumark_meta,content_namumark_rendered_at&limit=5`,
    );
    const folded = normalizeWikiKey(sourceTitle).toLocaleLowerCase();
    const match = candidates.find(
      (row) => normalizeWikiKey(row.source_title).toLocaleLowerCase() === folded,
    );
    docs = match ? [match] : [];
  }

  const source = docs[0];

  if (!source) {
    return (
      <main className="kpoparkiveRawWikiMissing">
        <h1>{sourceTitle}</h1>
        <p>This Kpoparkive document has not been imported yet.</p>
      </main>
    );
  }

  if (source.source_title !== sourceTitle) {
    redirect(`/w/${source.source_title
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`);
  }

  const renderedDraftRevision = Number(source.content_namumark_meta?.editableContent?.revisionNo || 0) || 0;
  const contentRevision = Number(source.content_revision_no || 0) || 0;
  const hasCurrentDraft =
    typeof source.content_namumark_html === "string" &&
    source.content_namumark_html.length > 0 &&
    contentRevision > 0 &&
    renderedDraftRevision === contentRevision;
  const isLocalDraftPreview = process.env.NODE_ENV !== "production";

  const publishedContentHtml =
    source.published_namumark_html ||
    (source.content_status === "published" ? source.content_namumark_html : null);

  // Local development is the approval surface: show the current rendered draft
  // without promoting it to production. Production never reads an unpublished draft.
  const exactHtml = isLocalDraftPreview
    ? (hasCurrentDraft ? source.content_namumark_html : null) ||
      publishedContentHtml ||
      source.source_namumark_html
    : publishedContentHtml;

  if (!exactHtml) {
    return (
      <main className="kpoparkiveRawWikiMissing">
        <h1>{source.source_title}</h1>
        <p>{isLocalDraftPreview
          ? "The raw source exists, but this document has not been rendered yet."
          : "This document has not been published yet."}</p>
      </main>
    );
  }

  // Assets are registered per source document. Query only this page's resolved
  // rows instead of scanning the global asset registry on every page request.
  // This uses source_asset_queue_document_idx and keeps /w pages fast even as
  // the archive grows into thousands of captured files.
  const resolvedRows = await db<AssetRow[]>(
    `source_asset_queue?source_document_id=eq.${encodeURIComponent(source.id)}` +
      `&asset_type=eq.image&status=eq.resolved` +
      `&select=source_ref,label,status,resolved_url,storage_path,metadata&limit=500`,
  );

  const hints: Record<string, string> = {};
  for (const row of resolvedRows) {
    const url = row.resolved_url || (typeof row.metadata?.enrichment_url === "string" ? row.metadata.enrichment_url : null);
    if (!url) continue;
    hints[fileKey(row.source_ref)] = url;
    if (row.label) hints[fileKey(row.label)] = url;
  }

  const assets = buildNamuResolvedAssetMap(resolvedRows, hints);
  const renderedHtml = sanitizeAndHydrate(exactHtml, assets, source.source_title);

  return (
    <>
      <link rel="stylesheet" href={THETREE_FRONTEND_CSS} />
      <main className="kpoparkiveRawWikiPage" data-editor-mode="public-source">
        <TheTreeRuntimeBridge />
        <article className="thetreeWikiBaseline wiki-content" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
      </main>
    </>
  );
}
