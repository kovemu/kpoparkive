const DEFAULT_MIRROR = "https://www.namu.moe";

export type RelationCandidate = {
  title: string;
  label: string;
  score: number;
  reason: string;
};

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
  relationCandidates: RelationCandidate[];
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

function decodeTitle(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function validWikiTitle(title: string) {
  return Boolean(title)
    && !title.startsWith("분류:")
    && !title.startsWith("파일:")
    && !title.startsWith("틀:")
    && !title.startsWith("나무위키:")
    && !title.startsWith("특수기능:")
    && !title.startsWith("사용자:");
}

function extractLinks(html: string) {
  const matches = [...html.matchAll(/href=["'](?:https?:\/\/(?:www\.)?namu\.moe)?\/w\/([^"'#?]+)[^"']*["']/gi)];
  return unique(matches.map((match) => decodeTitle(match[1]))).filter(validWikiTitle);
}

function relationScore(title: string, label: string, context: string, rootTitle: string) {
  if (title === rootTitle) return { score: 100, reason: "root" };
  if (title.startsWith(`${rootTitle}/`)) return { score: 100, reason: "root-subdocument" };
  if (title.includes(`(${rootTitle})`) || title.includes(`[${rootTitle}]`)) return { score: 95, reason: "root-qualified-title" };

  const rootMention = context.includes(rootTitle) || label.includes(rootTitle);
  const memberContext = /멤버|member|프로필|profile|출생|생년월일|포지션|position/i.test(context);
  const discographyContext = /음반|앨범|discography|album|single|싱글|미니\s*앨범|정규\s*앨범|EP|발매/i.test(context);
  const activityContext = /활동|공연|행사|콘텐츠|유튜브|라이브|응원법|굿즈|수상|음원|직캠|music show|fancam|award|goods|live/i.test(context);

  if (rootMention && memberContext) return { score: 90, reason: "member-context" };
  if (rootMention && discographyContext) return { score: 86, reason: "discography-context" };
  if (rootMention && activityContext) return { score: 82, reason: "activity-context" };
  if (memberContext && label.length <= 24 && !/[/:]/.test(label)) return { score: 78, reason: "member-table-context" };
  if (discographyContext && label.length <= 60) return { score: 74, reason: "discography-table-context" };
  return { score: 0, reason: "unrelated" };
}

function extractRelationCandidates(html: string, rootTitle: string) {
  const matches = [...html.matchAll(/<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?namu\.moe)?\/w\/([^"'#?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)];
  const best = new Map<string, RelationCandidate>();

  for (const match of matches) {
    const title = decodeTitle(match[1]);
    if (!validWikiTitle(title)) continue;
    const label = stripHtml(match[2]).trim() || title;
    const index = match.index ?? 0;
    const context = stripHtml(html.slice(Math.max(0, index - 420), Math.min(html.length, index + match[0].length + 420)));
    const { score, reason } = relationScore(title, label, context, rootTitle);
    if (score < 74) continue;
    const previous = best.get(title);
    if (!previous || previous.score < score) best.set(title, { title, label, score, reason });
  }

  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, 80);
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

export async function fetchMirrorDocument(title: string, mirrorBase = DEFAULT_MIRROR, rootTitle = title): Promise<MirrorSnapshot> {
  const url = `${mirrorBase}/w/${encodeURIComponent(title)}`;
  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      "User-Agent": "KpoparkiveIndexer/0.3 (+https://kpoparkive.vercel.app)",
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
    relationCandidates: extractRelationCandidates(html, rootTitle),
  };
}

export function shouldCrawlTitle(title: string, rootTitle: string, includePrefixes: string[] = [], includeTitles: string[] = []) {
  if (title === rootTitle) return true;
  if (includeTitles.includes(title)) return true;
  if (title.startsWith(`${rootTitle}/`)) return true;
  return includePrefixes.some((prefix) => title.startsWith(prefix));
}
