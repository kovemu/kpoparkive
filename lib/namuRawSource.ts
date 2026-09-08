import { parse } from "node-html-parser";

export type RawSourceSegment = {
  type: "raw" | "rendered";
  source: string;
};

export type RenderedFileMap = Record<string, string>;
export type RawFileTargetMap = Record<string, string>;

export type MirrorRawBundle = {
  sourceWikitext: string;
  segments: RawSourceSegment[];
  fileRefs: string[];
  renderedFileMap: RenderedFileMap;
  fileTargetMap: RawFileTargetMap;
  internalLinks: string[];
  rawCharacters: number;
  renderedCharacters: number;
  rawBlockCount: number;
  estimatedRawCoverage: number;
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#123;/gi, "{")
    .replace(/&#125;/gi, "}")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function normalizeFileKey(value: string) {
  return decodeEntities(value).normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function normalizeMediaUrl(value: string) {
  const url = decodeEntities(value || "").trim();
  if (url.startsWith("//")) return `https:${url}`;
  if (url.startsWith("/")) return `https://www.namu.moe${url}`;
  return /^https?:\/\//i.test(url) ? url : "";
}

function cleanRawBlock(value: string) {
  return decodeEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trimEnd();
}

function textFromRenderedHtml(html: string) {
  const root = parse(html);
  return decodeEntities(root.textContent || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractArticleHtml(html: string) {
  const match = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return match?.[1] || html;
}

function extractRawCodeBlocks(articleHtml: string) {
  const blocks: { start: number; end: number; raw: string }[] = [];
  const regex = /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  for (const match of articleHtml.matchAll(regex)) {
    const raw = cleanRawBlock(match[1] || "");
    if (!raw) continue;
    blocks.push({ start: match.index || 0, end: (match.index || 0) + match[0].length, raw });
  }
  return blocks;
}

function extractFileRefs(source: string) {
  return unique(
    [...source.matchAll(/\[\[(?:파일|File):([^\]|\n]+)(?:\|[^\]]*)?\]\]/gi)]
      .map((match) => normalizeFileKey(match[1]))
      .filter(Boolean),
  );
}

function extractDomFileRefs(html: string) {
  const root = parse(extractArticleHtml(html));
  const refs: string[] = [];

  for (const image of root.querySelectorAll("img")) {
    const alt = decodeEntities(image.getAttribute("alt") || "").trim();
    const match = alt.match(/^(?:파일|File):(.+)$/i);
    if (match) refs.push(normalizeFileKey(match[1]));
  }

  for (const anchor of root.querySelectorAll("a")) {
    const title = decodeEntities(anchor.getAttribute("title") || "").trim();
    const match = title.match(/^(?:파일|File):(.+)$/i);
    if (match) refs.push(normalizeFileKey(match[1]));
  }

  return unique(refs.filter(Boolean));
}

/**
 * Keep the outer wiki target for image links such as
 * [[YoYo|[[파일:YoYo.jpg|width=100%]]]]. If the current mirror page only keeps
 * the image as raw syntax, the linked target is usually a document whose
 * rendered infobox contains that exact file. The asset resolver can fetch that
 * target and recover the CDN URL without filename guessing or search APIs.
 */
function extractFileTargetMap(source: string): RawFileTargetMap {
  const map: RawFileTargetMap = {};
  const pattern = /\[\[([^\]|\n]+)\|\s*\[\[(?:파일|File):([^\]|\n]+)(?:\|[^\]]*)?\]\]\s*\]\]/gi;
  for (const match of source.matchAll(pattern)) {
    const target = match[1].trim().replace(/#.*$/, "");
    const file = normalizeFileKey(match[2]);
    if (target && file && !map[file]) map[file] = target;
  }
  return map;
}

function extractInternalLinks(source: string) {
  return unique(
    [...source.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]]*)?\]\]/g)]
      .map((match) => match[1].trim())
      .filter((target) => target && !/^(?:파일|File|분류|Category):/i.test(target)),
  );
}

/**
 * The mirror often renders the exact file used by a raw [[파일:...]] reference.
 * Pairing img.alt with a CDN-bearing attribute gives us a generic filename ->
 * URL resolver. Some mirror bugs put the CDN URL inside a malformed width attr;
 * scan the serialized tag as a final recovery hint instead of losing the asset.
 */
export function extractRenderedFileMap(html: string): RenderedFileMap {
  const root = parse(extractArticleHtml(html));
  const map: RenderedFileMap = {};
  for (const image of root.querySelectorAll("img")) {
    const alt = decodeEntities(image.getAttribute("alt") || "").trim();
    const match = alt.match(/^(?:파일|File):(.+)$/i);
    const bare = /\.(?:avif|gif|jpe?g|png|svg|webp)$/i.test(alt) ? alt : "";
    if (!match && !bare) continue;
    const file = normalizeFileKey(match?.[1] || bare);
    const serialized = image.toString();
    const embeddedHint = serialized.match(/(?:https?:)?\/\/file\.namu\.moe\/file\/[a-z0-9]+/i)?.[0] || "";
    const candidates = [image.getAttribute("data-original"), image.getAttribute("data-src"),
      ...(image.getAttribute("srcset") || "").split(",").map(value => value.trim().split(/\s+/)[0]),
      image.getAttribute("src"), embeddedHint];
    const url = candidates.map(value => normalizeMediaUrl(value || "")).find(Boolean);
    if (file && url && !map[file]) map[file] = url;
  }
  return map;
}

/**
 * namu.moe is a hybrid mirror: constructs unsupported by its renderer survive
 * inside <pre><code> as Namu source, while supported constructs are emitted as
 * rendered HTML. Do not pretend those code blocks are a complete document.
 *
 * This extractor therefore preserves BOTH representations in source order.
 * sourceWikitext is the recoverable raw subset and segments are the lossless
 * bridge until a direct /raw source can replace the rendered fallback.
 */
export function extractMirrorRawBundle(html: string): MirrorRawBundle {
  const articleHtml = extractArticleHtml(html);
  const rawBlocks = extractRawCodeBlocks(articleHtml);
  const segments: RawSourceSegment[] = [];
  let cursor = 0;

  for (const block of rawBlocks) {
    if (block.start > cursor) {
      const rendered = articleHtml.slice(cursor, block.start).trim();
      if (rendered) segments.push({ type: "rendered", source: rendered });
    }
    segments.push({ type: "raw", source: block.raw });
    cursor = block.end;
  }
  if (cursor < articleHtml.length) {
    const rendered = articleHtml.slice(cursor).trim();
    if (rendered) segments.push({ type: "rendered", source: rendered });
  }

  const sourceWikitext = rawBlocks.map((block) => block.raw).join("\n\n").trim();
  const renderedCharacters = segments
    .filter((segment) => segment.type === "rendered")
    .reduce((sum, segment) => sum + textFromRenderedHtml(segment.source).length, 0);
  const rawCharacters = sourceWikitext.length;
  const denominator = rawCharacters + renderedCharacters;
  const renderedFileMap = extractRenderedFileMap(html);
  const fileRefs = unique([...extractFileRefs(sourceWikitext), ...extractDomFileRefs(html), ...Object.keys(renderedFileMap)]);

  return {
    sourceWikitext,
    segments,
    fileRefs,
    renderedFileMap,
    fileTargetMap: extractFileTargetMap(sourceWikitext),
    internalLinks: extractInternalLinks(sourceWikitext),
    rawCharacters,
    renderedCharacters,
    rawBlockCount: rawBlocks.length,
    estimatedRawCoverage: denominator ? Math.round((rawCharacters / denominator) * 1000) / 10 : 0,
  };
}

