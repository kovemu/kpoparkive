import type { Metadata } from "next";
import type { ReactNode } from "react";
import WikiShell from "../../../components/wiki/WikiShell";
import { getPublicWikiMeta } from "../../../lib/publicWikiRead";
import "../shell.css";

function sourceTitleFromSegments(segments: string[]) {
  return segments
    .map((segment) => decodeURIComponent(segment))
    .join("/")
    .normalize("NFKC")
    .trim();
}

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://kpoparkive.vercel.app")
  .trim()
  .replace(/\/$/, "");

type WikiMeta = {
  title: string;
  published: boolean;
};

function canonicalUrlFor(sourceTitle: string) {
  const path = sourceTitle
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return SITE_URL + "/w/" + path;
}

async function wikiMetaFor(sourceTitle: string): Promise<WikiMeta> {
  if (process.env.NODE_ENV === "production") {
    try {
      const row = await getPublicWikiMeta(sourceTitle);
      if (!row) return { title: sourceTitle, published: false };
      const translated = row.translated_title?.normalize("NFKC").trim() || "";
      return {
        title: translated && !/[가-힣]/.test(translated) ? translated : row.source_title,
        published: true,
      };
    } catch {
      // Public metadata fails closed: noindex rather than leaking draft state.
      return { title: sourceTitle, published: false };
    }
  }

  if (!SERVICE_ROLE_KEY) return { title: sourceTitle, published: false };
  try {
    const response = await fetch(
      SUPABASE_URL +
        "/rest/v1/source_documents?source=eq.namu_mirror&source_title=eq." +
        encodeURIComponent(sourceTitle) +
        "&select=translated_title,content_language,content_status,published_revision_no&limit=1",
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: "Bearer " + SERVICE_ROLE_KEY,
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return { title: sourceTitle, published: false };
    const rows = await response.json() as Array<{
      translated_title: string | null;
      content_language: string | null;
      content_status: string | null;
      published_revision_no: number | null;
    }>;
    const row = rows[0];
    const translated = row?.translated_title?.normalize("NFKC").trim() || "";

    // translated_title is display metadata, not publication state. Local draft
    // previews and already-published revisions must not fall back to the Korean
    // canonical source title merely because a newer English revision is draft.
    const published = Number(row?.published_revision_no || 0) > 0;
    if (translated && !/[가-힣]/.test(translated)) {
      return { title: translated, published };
    }
    return { title: sourceTitle, published };
  } catch {
    // Metadata lookup failure must fail closed for indexing.
  }
  return { title: sourceTitle, published: false };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ title: string[] }>;
}): Promise<Metadata> {
  const { title: segments } = await params;
  const sourceTitle = sourceTitleFromSegments(segments);
  const meta = await wikiMetaFor(sourceTitle);
  const pageTitle = `${meta.title} - Kpoparkive`;
  const description = `English K-pop wiki article for ${meta.title}, with detailed profiles, activities, releases, media, and references.`;
  const canonical = canonicalUrlFor(sourceTitle);
  return {
    title: pageTitle,
    description,
    alternates: meta.published
      ? { canonical }
      : undefined,
    robots: meta.published
      ? { index: true, follow: true }
      : { index: false, follow: false },
    openGraph: meta.published
      ? {
          title: pageTitle,
          description,
          url: canonical,
          type: "article",
          siteName: "Kpoparkive",
        }
      : undefined,
  };
}

export default async function WikiTitleLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ title: string[] }>;
}) {
  const { title: segments } = await params;
  const sourceTitle = sourceTitleFromSegments(segments);
  const { title } = await wikiMetaFor(sourceTitle);

  return (
    <>
      <style>{`
        /* The pinned The Tree frontend uses an old icon-font glyph for heading
           disclosure markers. Without that font it renders as a boxed X.
           Draw the disclosure chevron with CSS so every wiki page matches the
           current NamuWiki behavior without depending on legacy icon fonts. */
        .kpoparkiveRawWikiPage .wiki-heading::before,
        .thetreeWikiBaseline .wiki-heading::before,
        .namumarkPocDocument.wiki-content .wiki-heading::before {
          content: "" !important;
          display: inline-block !important;
          box-sizing: border-box !important;
          width: .48em !important;
          height: .48em !important;
          margin: 0 .62em .16em .08em !important;
          padding: 0 !important;
          border: 0 !important;
          border-right: 2px solid #62676d !important;
          border-bottom: 2px solid #62676d !important;
          border-radius: 0 !important;
          background: none !important;
          color: transparent !important;
          font-family: inherit !important;
          font-size: inherit !important;
          line-height: 1 !important;
          vertical-align: middle !important;
          transform: rotate(45deg) !important;
          transform-origin: 58% 58% !important;
          transition: transform .12s ease !important;
        }

        .kpoparkiveRawWikiPage .wiki-heading.wiki-heading-folded::before,
        .thetreeWikiBaseline .wiki-heading.wiki-heading-folded::before,
        .namumarkPocDocument.wiki-content .wiki-heading.wiki-heading-folded::before {
          transform: rotate(-45deg) !important;
        }
      `}</style>
      <WikiShell title={title} sourceTitle={sourceTitle}>{children}</WikiShell>
    </>
  );
}
