import type { MetadataRoute } from "next";

const SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://kpoparkive.vercel.app")
  .trim()
  .replace(/\/$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/", "/w/"],
      disallow: [
        "/admin/",
        "/api/",
        "/edit/",
        "/login",
        "/search",
        "/wiki/",
      ],
    },
    sitemap: SITE_URL + "/sitemap.xml",
    host: SITE_URL,
  };
}
