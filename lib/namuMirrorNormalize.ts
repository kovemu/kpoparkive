const DAY_MS = 24 * 60 * 60 * 1000;

export type NamuMirrorSyntaxRepairReport = {
  protectedRawBlocks: number;
  directiveOnlyCells: number;
  leakedDirectiveOpeners: number;
  orphanDirectiveClosers: number;
  leakedTableMetadata: number;
  splitWikiLinks: number;
  unresolvedFileAnchors: number;
  malformedImageHints: number;
  semanticStyleTokens: number;
};

function koreaTodayUtcMidnight(now = new Date()) {
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
}

function parseIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day, utc: Date.UTC(year, month - 1, day) };
}

function dday(value: string, now = new Date()) {
  const date = parseIsoDate(value);
  if (!date) return null;
  const days = Math.floor((koreaTodayUtcMidnight(now) - date.utc) / DAY_MS);
  return days >= 0 ? `+${days}` : String(days);
}

function age(value: string, now = new Date()) {
  const date = parseIsoDate(value);
  if (!date) return null;
  const shifted = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentYear = shifted.getUTCFullYear();
  const currentMonth = shifted.getUTCMonth() + 1;
  const currentDay = shifted.getUTCDate();
  let years = currentYear - date.year;
  if (currentMonth < date.month || (currentMonth === date.month && currentDay < date.day)) years -= 1;
  return String(Math.max(0, years));
}

function expandDateMacros(html: string, now = new Date()) {
  return html
    .replace(/(?:\[|&#91;)dday\((\d{4}-\d{2}-\d{2})\)(?:\]|&#93;)/gi, (match, value: string) => dday(value, now) ?? match)
    .replace(/(?:\[|&#91;)age\((\d{4}-\d{2}-\d{2})\)(?:\]|&#93;)/gi, (match, value: string) => age(value, now) ?? match);
}

function countMatches(source: string, pattern: RegExp) {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))].length;
}

function protectRawBlocks(source: string) {
  const blocks: string[] = [];
  const html = source.replace(/<pre\b[^>]*>\s*<code\b[^>]*>[\s\S]*?<\/code>\s*<\/pre>/gi, (block) => {
    const index = blocks.push(block) - 1;
    return `<!--KPOPARKIVE_RAW_BLOCK_${index}-->`;
  });
  return { html, blocks };
}

function restoreRawBlocks(source: string, blocks: string[]) {
  return source.replace(/<!--KPOPARKIVE_RAW_BLOCK_(\d+)-->/g, (match, index: string) => blocks[Number(index)] ?? match);
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function escapeAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function attributeValue(attrs: string, name: string) {
  const double = attrs.match(new RegExp(`\\b${name}\\s*=\\s*\"([^\"]*)\"`, "i"))?.[1];
  if (double !== undefined) return double;
  return attrs.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1];
}

function internalWikiHref(target: string) {
  const clean = decodeEntities(target).normalize("NFKC").trim();
  if (!clean || /^https?:\/\//i.test(clean)) return "";
  const [title, anchor = ""] = clean.split("#", 2);
  const base = `/w/${encodeURIComponent(title)}`;
  return anchor ? `${base}#${encodeURIComponent(anchor)}` : base;
}

function repairMalformedImageHints(source: string) {
  return source.replace(/<img\b([^>]*)>/gi, (full, attrs: string) => {
    if (/\b(?:src|data-original|data-src)\s*=/i.test(attrs)) return full;
    const rawUrl = attrs.match(/\/\/file\.namu\.moe\/file\/[a-z0-9]+/i)?.[0];
    if (!rawUrl) return full;
    return `<img${attrs} data-original="${rawUrl}">`;
  });
}

function repairUnresolvedFileAnchors(source: string) {
  return source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (full, attrs: string, body: string) => {
    const className = attributeValue(attrs, "class") || "";
    if (!/(?:^|\s)not-exist(?:\s|$)/i.test(className)) return full;
    const title = decodeEntities(attributeValue(attrs, "title") || "").trim();
    const text = decodeEntities(body.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const candidate = title || text;
    const match = candidate.match(/^(?:파일|File):(.+)$/i);
    if (!match) return full;
    const file = match[1].normalize("NFKC").trim();
    if (!file) return full;
    return `<img class="wiki unresolved-file" alt="파일:${escapeAttribute(file)}" data-namu-unresolved="1">`;
  });
}

function repairRenderedWikiLinks(source: string) {
  const pattern = /(?:\[\[|&#91;&#91;)([^|<\r\n]{1,240})\|((?:(?!<\/td\b)[\s\S]){0,5000}?)(?:\]\]|&#93;&#93;)/gi;
  return source.replace(pattern, (full, target: string, body: string) => {
    const cleanTarget = decodeEntities(target).normalize("NFKC").trim();
    if (!cleanTarget || /^(?:파일|File):/i.test(cleanTarget)) return full;
    const href = internalWikiHref(cleanTarget);
    if (!href) return body;
    return `<a class="wiki recovered-wiki-link" href="${escapeAttribute(href)}" title="${escapeAttribute(cleanTarget.replace(/#.*$/, ""))}">${body}</a>`;
  });
}

function stripDirectiveOnlyCells(source: string) {
  return source.replace(
    /<td\b[^>]*>\s*(?:(?:\{\{\{#!(?:wiki|folding|if|style)\b[^<\r\n]*(?:<br\s*\/?\s*>)?\s*)+)\s*<\/td>/gi,
    "",
  );
}

function repairSemanticStyles(source: string) {
  return source
    .replace(/background-color\s*:\s*nopad\s*;?/gi, "padding:0;")
    .replace(/background-color\s*:\s*(?:rowkeepall|colkeepall|keepall)\s*;?/gi, "word-break:keep-all;")
    .replace(/background-color\s*:\s*(?:thead|sortable)\s*;?/gi, "");
}

/**
 * namu.moe is a partial renderer. Unsupported Namu constructs can leak into the
 * rendered DOM as text while the rest of the same table/link is already HTML.
 * Repair only presentation/control syntax and preserve every <pre><code> raw
 * block byte-for-byte so the raw parser still receives canonical source.
 */
export function normalizeNamuMirrorHtmlWithReport(source: string, now = new Date()) {
  const protectedSource = protectRawBlocks(String(source || ""));
  let html = protectedSource.html;

  const report: NamuMirrorSyntaxRepairReport = {
    protectedRawBlocks: protectedSource.blocks.length,
    directiveOnlyCells: countMatches(html, /<td\b[^>]*>\s*(?:(?:\{\{\{#!(?:wiki|folding|if|style)\b[^<\r\n]*(?:<br\s*\/?\s*>)?\s*)+)\s*<\/td>/gi),
    leakedDirectiveOpeners: countMatches(html, /\{\{\{#!(?:wiki|folding|if|style)\b/gi),
    orphanDirectiveClosers: countMatches(html, /(?:\}{3})+/g),
    leakedTableMetadata: countMatches(html, /&lt;(?:table(?:width|bgcolor|color|bordercolor|align|class)|row(?:bgcolor|color|align)|col(?:bgcolor|color|align|width)|(?:bgcolor|color|width|align|class|nopad|thead|sortable))(?:=[^&<>]*?)?&gt;/gi),
    splitWikiLinks: countMatches(html, /(?:\[\[|&#91;&#91;)[^|<\r\n]{1,240}\|/gi),
    unresolvedFileAnchors: countMatches(html, /<a\b[^>]*class=(?:"[^"]*\bnot-exist\b[^"]*"|'[^']*\bnot-exist\b[^']*')[^>]*(?:title=(?:"(?:파일|File):[^"]+"|'(?:파일|File):[^']+'))/gi),
    malformedImageHints: countMatches(html, /<img\b(?=[^>]*\/\/file\.namu\.moe\/file\/)(?![^>]*\b(?:src|data-original|data-src)\s*=)[^>]*>/gi),
    semanticStyleTokens: countMatches(html, /background-color\s*:\s*(?:nopad|rowkeepall|colkeepall|keepall|thead|sortable)\b/gi),
  };

  // A leaked <tablewidth=100%> is sometimes miscompiled by the mirror into a
  // 1000px cell width. Remove that generated width before discarding metadata.
  html = html
    .replace(/(<(?:td|th)\b[^>]*style='[^']*)width\s*:\s*1000px;?([^']*'[^>]*>\s*)&lt;tablewidth=100%&gt;/gi, "$1$2")
    .replace(/(<(?:td|th)\b[^>]*style="[^"]*)width\s*:\s*1000px;?([^"]*"[^>]*>\s*)&lt;tablewidth=100%&gt;/gi, "$1$2");

  html = repairMalformedImageHints(html);
  html = repairUnresolvedFileAnchors(html);
  html = repairRenderedWikiLinks(html);
  html = stripDirectiveOnlyCells(html);
  html = repairSemanticStyles(html);

  // Table/column controls can survive as literal escaped text at the start of
  // an already-rendered cell. Their geometry has already been emitted as HTML.
  html = html.replace(
    /(<(?:td|th)\b[^>]*>\s*)((?:&lt;(?:table(?:width|bgcolor|color|bordercolor|align|class)|row(?:bgcolor|color|align)|col(?:bgcolor|color|align|width)|(?:bgcolor|color|width|align|class|nopad|thead|sortable))(?:=[^&<>]*?)?&gt;\s*)+)/gi,
    "$1",
  );

  // Opening control fragments are not article text. The mirror frequently
  // leaves them immediately before rendered spans/divs or line breaks.
  html = html
    .replace(/\{\{\{#!(?:wiki|folding|if|style)\b[^<\r\n]*(?:<br\s*\/?\s*>)?/gi, "")
    .replace(/\{\{\{[+-]\d+\s*/g, "");

  // Remove only orphan closing controls left after a partially-expanded macro.
  // Real raw macros are protected above and restored unchanged below.
  html = html
    .replace(/(?:\}{3})+\s*(?:\|\|)?\s*(?:<br\s*\/?\s*>)?/g, "")
    .replace(/>\s*\|\|\s*(?:<br\s*\/?\s*>)?/g, ">");

  html = expandDateMacros(html, now);
  html = restoreRawBlocks(html, protectedSource.blocks);

  return { html, report };
}

export function normalizeNamuMirrorHtml(source: string, now = new Date()) {
  return normalizeNamuMirrorHtmlWithReport(source, now).html;
}
