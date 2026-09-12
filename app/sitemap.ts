import type { MetadataRoute } from "next";
import { getPublicWikiIndex } from "../lib/publicWikiRead";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://kpoparkive.vercel.app")
  .trim()
  .replace(/\/$/, "");

function wikiUrl(sourceTitle: string) {
  const path = sourceTitle
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return SITE_URL + "/w/" + path;
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let rows: Awaited<ReturnType<typeof getPublicWikiIndex>> = [];
  try {
    rows = await getPublicWikiIndex();
  } catch {
    // Fail closed: never leak unpublished document names into the sitemap.
  }

  return [
    {
      url: SITE_URL,
      changeFrequency: "daily",
      priority: 1,
    },
    ...rows.map((row) => ({
      url: wikiUrl(row.source_title),
      lastModified: row.published_at ? new Date(row.published_at) : undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
  ];
}
