export type ParsedBlockV4 =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "related"; label: string; target: string }
  | { type: "image"; source_ref: string; url?: string; alt?: string; role?: string }
  | { type: "video"; provider: string; url: string; video_id?: string; label?: string }
  | { type: "internal-link"; target: string; label: string }
  | { type: "external-link"; url: string; label: string };

export type ParsedSectionV4 = {
  section_key: string;
  heading: string;
  heading_level: number;
  sort_order: number;
  content: ParsedBlockV4[];
};

type Candidate = { start: number; end: number; priority: number; html: string; kind: "table" | "list" | "paragraph" | "image" | "iframe" | "link" };

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

function cleanWikiSyntax(value: string) {
  let text = decodeEntities(value);
  text = text
    .replace(/\[age\([^\]]+\)\](?:세)?/gi, "")
    .replace(/\[dday\([^\]]+\)\]/gi, "")
    .replace(/\[br\]/gi, " ")
    .replace(/\[\[파일:[^\]]+\]\]/gi, " ")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\{\{\{#!if\s+출력\s*==\s*null\s+([^{}]+)\}\}\}/gi, "$1")
    .replace(/#!if\s+[^\n{}]+/gi, " ")
    .replace(/\{\{\{#!wiki\s+(?:style|class|tag)=(?:"[^"]*"|'[^']*'|[^\s{}]+)\s*/gi, " ")
    .replace(/\{\{\{#!folding\s+[^\n{}]*\s*/gi, " ")
    .replace(/\{\{\{\+\d+\s*/g, " ")
    .replace(/\}\}\}/g, " ")
    .replace(/'{2,5}/g, "")
    .replace(/\s*\|\|\s*/g, " | ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function stripTags(value: string) {
  return cleanWikiSyntax(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  );
}

function cleanHeading(value: string) {
  return stripTags(value).replace(/^\d+(?:\.\d+)*\.?\s*/, "").trim();
}

function slugifyHeading(value: string, fallback: number) {
  const base = value.normalize("NFKC").toLowerCase().replace(/^\d+(?:\.\d+)*\.?\s*/, "").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `section-${fallback}`;
}

function normalizeImageUrl(src: string) {
  const decoded = decodeEntities(src.trim());
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("/")) return `https://www.namu.moe${decoded}`;
  return decoded;
}

function youtubeId(url: string) {
  return url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i)?.[1];
}

function addMatches(fragment: string, regex: RegExp, kind: Candidate["kind"], priority: number, candidates: Candidate[]) {
  for (const match of fragment.matchAll(regex)) {
    const start = match.index ?? 0;
    candidates.push({ start, end: start + match[0].length, priority, html: match[0], kind });
  }
}

function orderedTopLevelCandidates(fragment: string) {
  const candidates: Candidate[] = [];
  addMatches(fragment, /<table\b[^>]*>[\s\S]*?<\/table>/gi, "table", 100, candidates);
  addMatches(fragment, /<(?:ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi, "list", 90, candidates);
  addMatches(fragment, /<p\b[^>]*>[\s\S]*?<\/p>/gi, "paragraph", 80, candidates);
  addMatches(fragment, /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "iframe", 75, candidates);
  addMatches(fragment, /<img\b[^>]*>/gi, "image", 60, candidates);
  addMatches(fragment, /<a\b[^>]*>[\s\S]*?<\/a>/gi, "link", 40, candidates);

  candidates.sort((a, b) => a.start - b.start || b.priority - a.priority || b.end - a.end);
  const selected: Candidate[] = [];
  for (const candidate of candidates) {
    if (selected.some((picked) => candidate.start >= picked.start && candidate.end <= picked.end)) continue;
    selected.push(candidate);
  }
  return selected.sort((a, b) => a.start - b.start);
}

function parseTable(html: string): ParsedBlockV4 | null {
  const rows = [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((row) => [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => stripTags(cell[1])))
    .filter((row) => row.length > 0 && row.some(Boolean));
  if (!rows.length) return null;
  const width = Math.min(12, Math.max(...rows.map((row) => row.length)));
  const normalized = rows.map((row) => [...row.slice(0, width), ...Array(Math.max(0, width - row.length)).fill("")]);
  const first = normalized[0];
  const firstHasTh = /<th\b/i.test(html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/i)?.[0] || "");
  const looksLikeHeader = firstHasTh || (first.every((cell) => cell.length <= 80) && new Set(first).size === first.length && normalized.length > 1);
  return { type: "table", columns: looksLikeHeader ? first : Array.from({ length: width }, (_, i) => `Column ${i + 1}`), rows: looksLikeHeader ? normalized.slice(1, 160) : normalized.slice(0, 160) };
}

function parseCandidate(candidate: Candidate): ParsedBlockV4 | null {
  if (candidate.kind === "table") return parseTable(candidate.html);
  if (candidate.kind === "list") {
    const items = [...candidate.html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1])).filter((x) => x.length > 1);
    return items.length ? { type: "list", items: [...new Set(items)].slice(0, 180) } : null;
  }
  if (candidate.kind === "paragraph") {
    const text = stripTags(candidate.html);
    if (!text || text.length < 2 || /최근 수정 시각|크리에이티브 커먼즈/.test(text)) return null;
    return { type: "paragraph", text };
  }
  if (candidate.kind === "image") {
    const src = candidate.html.match(/(?:data-original|data-src|src)=["']([^"']+)["']/i)?.[1];
    const alt = candidate.html.match(/alt=["']([^"']*)["']/i)?.[1];
    if (!src) return null;
    const url = normalizeImageUrl(src);
    const cleanAlt = alt ? decodeEntities(alt) : undefined;
    if (!/^https?:\/\//i.test(url) || /cc-by-nc-sa-2\.0-88x31\.png/i.test(url) || /상세 내용 아이콘/i.test(cleanAlt || "")) return null;
    return { type: "image", source_ref: url, url, alt: cleanAlt };
  }
  if (candidate.kind === "iframe") {
    const src = candidate.html.match(/src=["']([^"']+)["']/i)?.[1];
    if (!src) return null;
    const url = normalizeImageUrl(src);
    const provider = /youtu/i.test(url) ? "youtube" : /vimeo/i.test(url) ? "vimeo" : "external";
    return { type: "video", provider, url, video_id: provider === "youtube" ? youtubeId(url) : undefined };
  }
  const href = candidate.html.match(/href=["']([^"']+)["']/i)?.[1];
  if (!href) return null;
  const label = stripTags(candidate.html) || decodeEntities(href);
  if (/^(?:https?:\/\/)?(?:www\.)?namu\.moe\/w\//i.test(href) || href.startsWith("/w/")) {
    const raw = href.replace(/^https?:\/\/(?:www\.)?namu\.moe\/w\//i, "").replace(/^\/w\//, "").split(/[?#]/)[0];
    let target = raw;
    try { target = decodeURIComponent(raw); } catch {}
    if (target === "@문서명@" && label.includes("/")) target = label;
    if (!target || target.startsWith("파일:") || target.startsWith("분류:")) return null;
    if (/^자세한 내용은|문서 참고/.test(label) || (label.includes("/") && /상세 내용 아이콘/.test(candidate.html))) {
      return { type: "related", label: "Detailed article", target };
    }
    return { type: "internal-link", target, label };
  }
  if (/^https?:\/\//i.test(href)) return { type: "external-link", url: decodeEntities(href), label };
  return null;
}

function textBetween(fragment: string, start: number, end: number) {
  const raw = fragment.slice(start, end)
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const text = stripTags(raw);
  if (!text || text.length < 12) return null;
  if (/^(#!wiki|#!if|\{\{\{|\}\}\})/.test(text) || /^문서 참고하십시오/.test(text)) return null;
  return { type: "paragraph" as const, text };
}

function parseOrderedBlocks(fragment: string) {
  const candidates = orderedTopLevelCandidates(fragment);
  const blocks: ParsedBlockV4[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    const between = textBetween(fragment, cursor, candidate.start);
    if (between) blocks.push(between);
    const parsed = parseCandidate(candidate);
    if (parsed) blocks.push(parsed);
    cursor = Math.max(cursor, candidate.end);
  }
  const tail = textBetween(fragment, cursor, fragment.length);
  if (tail) blocks.push(tail);

  const deduped: ParsedBlockV4[] = [];
  let previousKey = "";
  for (const block of blocks) {
    const key = JSON.stringify(block);
    if (key === previousKey) continue;
    previousKey = key;
    deduped.push(block);
  }
  return deduped;
}

function articleHtml(html: string) {
  return html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] || html;
}

function fallbackFileImages(fragment: string, existing: ParsedBlockV4[]) {
  const hasVisualImage = existing.some((block) => block.type === "image");
  if (hasVisualImage) return existing;
  const seen = new Set<string>();
  const fileBlocks: ParsedBlockV4[] = [];
  for (const match of fragment.matchAll(/(?:\[\[)?파일:([^|\]\n<]+)/gi)) {
    const name = cleanWikiSyntax(match[1]).replace(/["'][\s\S]*$/, "").trim();
    if (!name || name.length > 180 || /상세 내용 아이콘|국기\.svg|유튜브 아이콘|틱톡 아이콘/i.test(name)) continue;
    const ref = `파일:${name}`;
    if (seen.has(ref)) continue;
    seen.add(ref);
    fileBlocks.push({ type: "image", source_ref: ref, alt: name });
  }
  return fileBlocks.length ? [...existing, ...fileBlocks] : existing;
}

export function parseNamuHtmlV4(html: string): ParsedSectionV4[] {
  const article = articleHtml(html);
  const headings = [...article.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  const sections: ParsedSectionV4[] = [];

  const firstHeadingStart = headings[0]?.index ?? article.length;
  const leadFragment = article.slice(0, firstHeadingStart);
  const lead = fallbackFileImages(leadFragment, parseOrderedBlocks(leadFragment));
  if (lead.length) sections.push({ section_key: "lead", heading: "", heading_level: 1, sort_order: 0, content: lead });

  headings.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < headings.length ? (headings[index + 1].index ?? article.length) : article.length;
    const heading = cleanHeading(match[2]) || `Section ${index + 1}`;
    const fragment = article.slice(start, end);
    sections.push({
      section_key: slugifyHeading(heading, index + 1),
      heading,
      heading_level: Number(match[1]),
      sort_order: (index + 1) * 10,
      content: fallbackFileImages(fragment, parseOrderedBlocks(fragment)),
    });
  });

  if (!sections.length) return [{ section_key: "lead", heading: "", heading_level: 1, sort_order: 0, content: fallbackFileImages(article, parseOrderedBlocks(article)) }];
  return sections;
}
