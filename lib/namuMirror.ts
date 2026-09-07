const DEFAULT_MIRROR = "https://www.namu.moe";

export type MirrorSnapshot = {
  title: string;
  url: string;
  html: string;
  text: string;
  hash: string;
  links: string[];
  images: string[];
  videos: { provider: string; url: string; id?: string }[];
  externalLinks: string[];
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function stripHtml(html: string) {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
  );
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function extractLinks(html: string) {
  const matches = [...html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?namu\.moe)?\/w\/([^"'#?]+)[^"']*["']/gi)];
  return unique(matches.map((match) => {
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  })).filter((title) => title && !title.startsWith("분류:") && !title.startsWith("파일:"));
}

function extractImages(html: string) {
  const fileNames = [...html.matchAll(/(?:파일:|Image:\s*파일:)([^|<\]\n]+)/g)].map((m) => m[1].trim());
  const urls = [
    ...html.matchAll(/(?:src|data-src)=["'](https?:\/\/[^"']+)["']/gi),
    ...html.matchAll(/https?:\/\/[^"'<>\s]+\.(?:jpg|jpeg|png|webp|gif|svg)(?:\?[^"'<>\s]*)?/gi),
  ].map((m) => m[1] || m[0]).filter((url) => /\.(?:jpg|jpeg|png|webp|gif|svg)(?:\?|$)/i.test(url));
  return unique([...fileNames, ...urls]);
}

function youtubeId(url: string) {
  const match = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);
  return match?.[1];
}

function extractVideos(html: string) {
  const urls = [
    ...html.matchAll(/(?:src|href)=["'](https?:\/\/[^"']*(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com)[^"']*)["']/gi),
    ...html.matchAll(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com)\/[^"'<>\s]+/gi),
  ].map((m) => decodeEntities(m[1] || m[0]));

  return unique(urls).map((url) => {
    const provider = /youtu/i.test(url) ? "youtube" : /vimeo/i.test(url) ? "vimeo" : /tiktok/i.test(url) ? "tiktok" : "external";
    return { provider, url, id: provider === "youtube" ? youtubeId(url) : undefined };
  });
}

function extractExternalLinks(html: string) {
  const urls = [...html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)].map((m) => decodeEntities(m[1]));
  return unique(urls).filter((url) => {
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      return host !== "namu.moe" && host !== "namu.wiki";
    } catch {
      return false;
    }
  });
}

async function sha256(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function fetchMirrorDocument(title: string, mirrorBase = DEFAULT_MIRROR): Promise<MirrorSnapshot> {
  const url = `${mirrorBase}/w/${encodeURIComponent(title)}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "KpoparkiveIndexer/0.2 (+https://kpoparkive.vercel.app)",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!response.ok) throw new Error(`Mirror fetch failed ${response.status}: ${title}`);
  const html = await response.text();
  return {
    title,
    url,
    html,
    text: stripHtml(html),
    hash: await sha256(html),
    links: extractLinks(html),
    images: extractImages(html),
    videos: extractVideos(html),
    externalLinks: extractExternalLinks(html),
  };
}

export function shouldCrawlTitle(title: string, rootTitle: string, includePrefixes: string[], includeTitles: string[]) {
  if (title === rootTitle) return true;
  if (includeTitles.includes(title)) return true;
  return includePrefixes.some((prefix) => title.startsWith(prefix));
}
