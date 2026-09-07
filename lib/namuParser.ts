export type ParsedBlock =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "related"; label: string; target: string };

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

function stripTags(value: string) {
  return decodeEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n\s+/g, "\n")
      .trim(),
  );
}

function slugifyHeading(value: string, fallback: number) {
  const base = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^\d+(?:\.\d+)*\.?\s*/, "")
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || `section-${fallback}`;
}

function cleanHeading(value: string) {
  return stripTags(value).replace(/^\d+(?:\.\d+)*\.?\s*/, "").trim();
}

function extractTables(fragment: string): ParsedBlock[] {
  const tables = [...fragment.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  const blocks: ParsedBlock[] = [];
  for (const match of tables) {
    const rows = [...match[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((row) => [...row[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)].map((cell) => stripTags(cell[1])).filter(Boolean))
      .filter((row) => row.length >= 2 && row.some(Boolean));
    if (rows.length < 2) continue;
    const width = Math.max(...rows.map((row) => row.length));
    if (width > 8) continue;
    const normalized = rows.map((row) => [...row, ...Array(Math.max(0, width - row.length)).fill("")]);
    const [first, ...rest] = normalized;
    const looksLikeHeader = first.every((cell) => cell.length <= 40) && new Set(first).size === first.length;
    blocks.push({
      type: "table",
      columns: looksLikeHeader ? first : Array.from({ length: width }, (_, i) => `Column ${i + 1}`),
      rows: looksLikeHeader ? rest.slice(0, 80) : normalized.slice(0, 80),
    });
  }
  return blocks;
}

function extractLists(fragment: string): ParsedBlock[] {
  const items = [...fragment.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
    .map((match) => stripTags(match[1]))
    .filter((item) => item.length > 2 && item.length < 700);
  if (!items.length) return [];
  const unique = [...new Set(items)].slice(0, 120);
  return unique.length ? [{ type: "list", items: unique }] : [];
}

function extractRelated(fragment: string): ParsedBlock[] {
  const targets = [...fragment.matchAll(/href=["'](?:https?:\/\/(?:www\.)?namu\.moe)?\/w\/([^"'#?]+)[^"']*["']/gi)]
    .map((m) => {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    })
    .filter((title) => /\//.test(title) && !title.startsWith("파일:") && !title.startsWith("분류:"));
  const unique = [...new Set(targets)].slice(0, 12);
  return unique.map((target) => ({ type: "related" as const, label: "Related document", target }));
}

function extractParagraphs(fragment: string): ParsedBlock[] {
  const cleaned = fragment
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, " ")
    .replace(/<(?:ul|ol)\b[^>]*>[\s\S]*?<\/(?:ul|ol)>/gi, " ")
    .replace(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, " ");

  const pTags = [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => stripTags(match[1]))
    .filter((text) => text.length >= 12 && text.length <= 1600);

  const candidates = pTags.length
    ? pTags
    : stripTags(cleaned)
        .split(/\n{1,}/)
        .map((text) => text.trim())
        .filter((text) => text.length >= 20 && text.length <= 1600);

  const noise = /최근 수정 시각|이 저작물은|크리에이티브 커먼즈|로그인|편집|역링크|토론|분류$/;
  return [...new Set(candidates)]
    .filter((text) => !noise.test(text))
    .slice(0, 40)
    .map((text) => ({ type: "paragraph" as const, text }));
}

function sectionBlocks(fragment: string) {
  const blocks: ParsedBlock[] = [];
  blocks.push(...extractRelated(fragment));
  blocks.push(...extractTables(fragment));
  blocks.push(...extractLists(fragment));
  blocks.push(...extractParagraphs(fragment));
  return blocks;
}

export function parseNamuHtml(html: string): ParsedSection[] {
  const headingMatches = [...html.matchAll(/<h([2-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)];
  if (!headingMatches.length) {
    return [{
      section_key: "overview",
      heading: "Overview",
      heading_level: 2,
      sort_order: 10,
      content: sectionBlocks(html),
    }];
  }

  return headingMatches.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = index + 1 < headingMatches.length ? (headingMatches[index + 1].index ?? html.length) : html.length;
    const heading = cleanHeading(match[2]) || `Section ${index + 1}`;
    return {
      section_key: slugifyHeading(heading, index + 1),
      heading,
      heading_level: Number(match[1]),
      sort_order: (index + 1) * 10,
      content: sectionBlocks(html.slice(start, end)),
    };
  }).filter((section) => section.content.length > 0 || section.heading.length > 0);
}
