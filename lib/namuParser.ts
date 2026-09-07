export type ParsedBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "related"; label: string; target: string }
  | { type: "internal-link"; target: string; label: string }
  | { type: "external-link"; url: string; label: string }
  | { type: "image"; source_ref: string; url?: string; alt?: string; role?: string }
  | { type: "video"; provider: string; url: string; video_id?: string; label?: string };

export type ParsedSection = {
  section_key: string;
  heading: string;
  heading_level: number;
  sort_order: number;
  content: ParsedBlock[];
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cleanNamuSyntax(value: string) {
  return decodeEntities(value)
    .replace(/\[age\([^\]]+\)\](?:세)?/gi, "")
    .replace(/\{\{\{#!if[\s\S]*?\}\}\}/g, " ")
    .replace(/\{\{\{#!wiki[^\n]*\n?/g, " ")
    .replace(/\{\{\{#!folding[^\n]*\n?/g, " ")
    .replace(/\}\}\}/g, " ")
    .replace(/#!if\s+[^\n]+/g, " ")
    .replace(/\[\[파일:[^\]]+\]\]/gi, " ")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripTags(value: string) {
  return cleanNamuSyntax(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function slugifyHeading(value: string, fallback: number) {
  const base = value.normalize("NFKC").toLowerCase().replace(/^\d+(?:\.\d+)*\.?\s*/, "").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `section-${fallback}`;
}

function cleanHeading(value: string) {
  return stripTags(value).replace(/^\d+(?:\.\d+)*\.?\s*/, "").trim();
}

function decodePath(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function youtubeId(url: string) {
  return url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i)?.[1];
}

function extractInternalLinks(fragment: string): ParsedBlock[] {
  const links = [...fragment.matchAll(/<a\b[^>]*href=["'](?:https?:\/\/(?:www\.)?namu\.moe)?\/w\/([^"'#?]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ target: decodePath(m[1]), label: stripTags(m[2]) || decodePath(m[1]) }))
    .filter((item) => item.target && !item.target.startsWith("파일:") && !item.target.startsWith("분류:"));
  const seen = new Set<string>();
  return links.filter((item) => !seen.has(item.target) && seen.add(item.target)).slice(0, 30).map((item) => ({ type: "internal-link" as const, ...item }));
}

function extractExternalLinks(fragment: string): ParsedBlock[] {
  const links = [...fragment.matchAll(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => ({ url: decodeEntities(m[1]), label: stripTags(m[2]) || m[1] }))
    .filter(({ url }) => {
      try { const host = new URL(url).hostname.replace(/^www\./, ""); return host !== "namu.moe" && host !== "namu.wiki"; } catch { return false; }
    });
  const seen = new Set<string>();
  return links.filter((item) => !seen.has(item.url) && seen.add(item.url)).slice(0, 30).map((item) => ({ type: "external-link" as const, ...item }));
}

function extractImages(fragment: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  const seen = new Set<string>();
  for (const m of fragment.matchAll(/<img\b([^>]+)>/gi)) {
    const attrs = m[1];
    const src = attrs.match(/(?:src|data-src)=["']([^"']+)["']/i)?.[1];
    const alt = attrs.match(/alt=["']([^"']*)["']/i)?.[1];
    if (!src || seen.has(src)) continue;
    seen.add(src);
    blocks.push({ type: "image", source_ref: src, url: decodeEntities(src), alt: alt ? decodeEntities(alt) : undefined });
  }
  for (const m of fragment.matchAll(/(?:파일:|Image:\s*파일:)([^|<\]\n]+)/g)) {
    const ref = `파일:${m[1].trim()}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    blocks.push({ type: "image", source_ref: ref, alt: m[1].trim() });
  }
  return blocks.slice(0, 80);
}

function extractVideos(fragment: string): ParsedBlock[] {
  const urls = [
    ...fragment.matchAll(/(?:src|href)=["'](https?:\/\/[^"']*(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com)[^"']*)["']/gi),
    ...fragment.matchAll(/https?:\/\/(?:www\.)?(?:youtube\.com|youtu\.be|vimeo\.com|tiktok\.com)\/[^"'<>\s]+/gi),
  ].map((m) => decodeEntities(m[1] || m[0]));
  const seen = new Set<string>();
  return urls.filter((url) => !seen.has(url) && seen.add(url)).slice(0, 40).map((url) => {
    const provider = /youtu/i.test(url) ? "youtube" : /vimeo/i.test(url) ? "vimeo" : /tiktok/i.test(url) ? "tiktok" : "external";
    return { type: "video" as const, provider, url, video_id: provider === "youtube" ? youtubeId(url) : undefined };
  });
}

function extractTables(fragment: string): ParsedBlock[] {
  const tables = [...fragment.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const blocks: ParsedBlock[] = [];
  for (const match of tables) {
    const rows = [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((row) => [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => stripTags(cell[1])))
      .filter((row) => row.length >= 2 && row.some(Boolean));
    if (rows.length < 1) continue;
    const width = Math.max(...rows.map((row) => row.length));
    if (width > 10) continue;
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    const [first, ...rest] = normalized;
    const looksLikeHeader = first.every((cell) => cell.length <= 60) && new Set(first).size === first.length;
    blocks.push({ type: "table", columns: looksLikeHeader ? first : Array.from({ length: width }, (_, i) => `Column ${i + 1}`), rows: looksLikeHeader ? rest.slice(0, 120) : normalized.slice(0, 120) });
  }
  return blocks;
}

function extractLists(fragment: string): ParsedBlock[] {
  const items = [...fragment.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((match) => stripTags(match[1])).filter((item) => item.length > 2 && item.length < 1200);
  const unique = [...new Set(items)].slice(0, 160);
  return unique.length ? [{ type: "list", items: unique }] : [];
}

function extractRelated(fragment: string): ParsedBlock[] {
  const targets = [...fragment.matchAll(/href=["'](?:https?:\/\/(?:www\.)?namu\.moe)?\/w\/([^"'#?]+)[^"']*["']/gi)].map((m) => decodePath(m[1])).filter((title) => /\//.test(title) && !title.startsWith("파일:") && !title.startsWith("분류:"));
  return [...new Set(targets)].slice(0, 12).map((target) => ({ type: "related" as const, label: "Related document", target }));
}

function extractParagraphs(fragment: string): ParsedBlock[] {
  const cleaned = fragment
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, " ")
    .replace(/<(?:ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, " ");

  const pTags = [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((match) => stripTags(match[1])).filter((text) => text.length >= 12 && text.length <= 2200);
  const candidates = pTags.length ? pTags : decodeEntities(cleaned.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).split(/\n{1,}/).map(cleanNamuSyntax).filter((text) => text.length >= 20 && text.length <= 2200);
  const noise = /최근 수정 시각|이 저작물은|크리에이티브 커먼즈|로그인|편집|역링크|토론|분류$/;
  return [...new Set(candidates)].filter((text) => text && !noise.test(text) && !/^(#!if|\{\{\{|\}\}\})/.test(text)).slice(0, 60).map((text) => ({ type: "paragraph" as const, text }));
}

function sectionBlocks(fragment: string) {
  return [
    ...extractRelated(fragment),
    ...extractInternalLinks(fragment),
    ...extractExternalLinks(fragment),
    ...extractImages(fragment),
    ...extractVideos(fragment),
    ...extractTables(fragment),
    ...extractLists(fragment),
    ...extractParagraphs(fragment),
  ];
}

export function parseNamuHtml(html: string): ParsedSection[] {
  const headingMatches = [...html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  if (!headingMatches.length) return [{ section_key: "overview", heading: "Overview", heading_level: 2, sort_order: 10, content: sectionBlocks(html) }];

  return headingMatches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < headingMatches.length ? (headingMatches[index + 1].index ?? html.length) : html.length;
    const heading = cleanHeading(match[2]) || `Section ${index + 1}`;
    return { section_key: slugifyHeading(heading, index + 1), heading, heading_level: Number(match[1]), sort_order: (index + 1) * 10, content: sectionBlocks(html.slice(start, end)) };
  }).filter((section) => section.content.length > 0 || section.heading.length > 0);
}
