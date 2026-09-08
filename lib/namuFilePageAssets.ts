import { parse } from "node-html-parser";
import { extractRenderedFileMap } from "./namuRawSource";
import { expandNamuRemoteCandidates } from "./namuStoredAssets";

const MIRROR = "https://www.namu.moe";
const OFFICIAL = "https://namu.wiki";

function normalizeFile(value: string) {
  return value.normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function absoluteUrl(value: string | undefined | null, base: string) {
  const raw = String(value || "").trim().replace(/&amp;/g, "&");
  if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) return null;
  try {
    const url = new URL(raw.startsWith("//") ? `https:${raw}` : raw, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function isNamuAssetHost(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "namu.wiki" || host.endsWith(".namu.wiki")
      || host === "namu.la" || host.endsWith(".namu.la")
      || host === "namu.moe" || host.endsWith(".namu.moe");
  } catch {
    return false;
  }
}

function assetish(url: string) {
  try {
    const parsed = new URL(url);
    if (!isNamuAssetHost(url)) return false;
    // Exclude normal wiki/document navigation. Namu CDN paths are usually /i/
    // or mirror /file/ paths and often have no filename extension.
    if (/^\/w\//.test(parsed.pathname) || /^\/(?:RecentChanges|Search)(?:\/|$)/i.test(parsed.pathname)) return false;
    return /\/(?:i|file)\//i.test(parsed.pathname)
      || /\.(?:jpe?g|png|webp|gif|avif|svg)(?:$|[?#])/i.test(url);
  } catch {
    return false;
  }
}

function srcsetUrls(value: string | undefined, base: string) {
  if (!value) return [];
  return value.split(",").map(part => absoluteUrl(part.trim().split(/\s+/)[0], base)).filter((url): url is string => Boolean(url));
}

function collectHtmlCandidates(html: string, base: string, fileName: string) {
  const root = parse(html);
  const wanted = normalizeFile(fileName).toLowerCase();
  const preferred: string[] = [];
  const secondary: string[] = [];
  const add = (target: string[], value: string | null) => {
    if (value && assetish(value) && !target.includes(value)) target.push(value);
  };

  for (const element of root.querySelectorAll("img, source, a")) {
    const signature = [
      element.getAttribute("alt"), element.getAttribute("title"),
      element.getAttribute("aria-label"), element.textContent,
    ].filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
    const exactish = signature.includes(wanted) || signature.includes(`파일:${wanted}`);
    const target = exactish ? preferred : secondary;
    for (const attr of ["src", "data-src", "data-original", "data-lazy-src", "href"]) add(target, absoluteUrl(element.getAttribute(attr), base));
    for (const attr of ["srcset", "data-srcset"]) for (const url of srcsetUrls(element.getAttribute(attr), base)) add(target, url);
    if (exactish) {
      let parent = element.parentNode;
      for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentNode) {
        const href = "getAttribute" in parent ? (parent as any).getAttribute?.("href") : null;
        add(preferred, absoluteUrl(href, base));
      }
    }
  }

  // On a dedicated file page the social preview is often the image itself.
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
    const meta = root.querySelector(selector);
    add(secondary, absoluteUrl(meta?.getAttribute("content"), base));
  }
  return [...preferred, ...secondary];
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    cache: "no-store",
    redirect: "follow",
    signal: AbortSignal.timeout(6500),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.7,en;q=0.6",
    },
  });
  if (!response.ok) throw new Error(`file page ${response.status}`);
  const text = await response.text();
  if (/captcha|사람인지 확인|robot check|cf-chl-|challenge-platform/i.test(text)) throw new Error("file page bot challenge");
  return text;
}

/**
 * Last-mile discovery for raw-only image references. Namu articles often keep
 * `[[파일:name]]` even when the mirror did not render an <img>. The file page,
 * however, normally exposes a clickable/downloadable image URL. We resolve it
 * only long enough to download the bytes into our own Storage; callers must
 * never persist the signed CDN URL as the final runtime image.
 */
export async function discoverNamuFilePageCandidates(fileName: string) {
  const clean = normalizeFile(fileName);
  if (!clean) return [];
  const title = `파일:${clean}`;
  const output: string[] = [];
  const add = (value: string) => {
    for (const candidate of expandNamuRemoteCandidates(value)) if (!output.includes(candidate)) output.push(candidate);
  };

  // Mirror first: cheaper and usually not protected. extractRenderedFileMap is
  // useful when the file page has a conventional alt="파일:name" <img>.
  const mirrorUrl = `${MIRROR}/w/${encodeURIComponent(title)}`;
  try {
    const html = await fetchHtml(mirrorUrl);
    const map = extractRenderedFileMap(html);
    const direct = map[clean] || map[title];
    if (direct) add(direct);
    for (const url of collectHtmlCandidates(html, mirrorUrl, clean)) add(url);
  } catch {
    // Continue to first-party page.
  }

  // First-party NamuWiki is protected intermittently. When it is reachable,
  // use the same downloadable link a browser gets after opening the image.
  const officialUrl = `${OFFICIAL}/w/${encodeURIComponent(title)}`;
  try {
    const html = await fetchHtml(officialUrl);
    for (const url of collectHtmlCandidates(html, officialUrl, clean)) add(url);
  } catch {
    // Anti-bot is expected sometimes; caller has independent fallbacks.
  }

  return output.slice(0, 20);
}
