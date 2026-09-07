import { parse } from "node-html-parser";

export type RawSourceSegment = {
  type: "raw" | "rendered";
  source: string;
};

export type MirrorRawBundle = {
  sourceWikitext: string;
  segments: RawSourceSegment[];
  fileRefs: string[];
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
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
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
      .map((match) => match[1].trim())
      .filter(Boolean),
  );
}

function extractInternalLinks(source: string) {
  return unique(
    [...source.matchAll(/\[\[([^\]|\n]+)(?:\|[^\]]*)?\]\]/g)]
      .map((match) => match[1].trim())
      .filter((target) => target && !/^(?:파일|File|분류|Category):/i.test(target)),
  );
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

  return {
    sourceWikitext,
    segments,
    fileRefs: extractFileRefs(sourceWikitext),
    internalLinks: extractInternalLinks(sourceWikitext),
    rawCharacters,
    renderedCharacters,
    rawBlockCount: rawBlocks.length,
    estimatedRawCoverage: denominator ? Math.round((rawCharacters / denominator) * 1000) / 10 : 0,
  };
}
