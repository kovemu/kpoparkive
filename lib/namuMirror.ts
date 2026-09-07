const DEFAULT_MIRROR = "https://www.namu.moe";

export type MirrorSnapshot = {
  title: string;
  url: string;
  html: string;
  text: string;
  hash: string;
  links: string[];
  images: string[];
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
  const urls = [...html.matchAll(/https?:\/\/[^"'<>\s]+\.(?:jpg|jpeg|png|webp|gif|svg)(?:\?[^"'<>\s]*)?/gi)].map((m) => m[0]);
  return unique([...fileNames, ...urls]);
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
      "User-Agent": "KpoparkiveIndexer/0.1 (+https://kpoparkive.vercel.app)",
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
  };
}

export function shouldCrawlTitle(title: string, rootTitle: string, includePrefixes: string[], includeTitles: string[]) {
  if (title === rootTitle) return true;
  if (includeTitles.includes(title)) return true;
  return includePrefixes.some((prefix) => title.startsWith(prefix));
}
