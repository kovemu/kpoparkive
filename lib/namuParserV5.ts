import { HTMLElement, parse } from "node-html-parser";
import type { RichWikiCell } from "./wiki";

export type ParsedBlockV5 =
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "rich-table"; rows: RichWikiCell[][] }
  | { type: "related"; label: string; target: string }
  | { type: "image"; source_ref: string; url?: string; alt?: string; role?: string }
  | { type: "video"; provider: string; url: string; video_id?: string; label?: string }
  | { type: "internal-link"; target: string; label: string }
  | { type: "external-link"; url: string; label: string };

export type ParsedSectionV5 = {
  section_key: string;
  heading: string;
  heading_level: number;
  sort_order: number;
  content: ParsedBlockV5[];
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

function displayWikiTarget(target: string) {
  const trimmed = target.trim();
  const hash = trimmed.lastIndexOf("#");
  const value = hash >= 0 ? trimmed.slice(hash + 1) : trimmed;
  return value.replace(/\([^)]*\)$/g, "").trim();
}

function cleanText(value: string) {
  let text = decodeEntities(value || "");
  text = text
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<(?:colbgcolor|colcolor|rowcolor|tablewidth|tablebgcolor|tableclass|nopad|rowkeepall|colkeepall|keepall|thead|sortable)[^>]*>/gi, " ")
    .replace(/\[age\([^\]]+\)\](?:세)?/gi, "")
    .replace(/\[dday\([^\]]+\)\]/gi, "")
    .replace(/\(\s*데뷔일로부터\s*일\s*,\s*주년\s*\)/gi, "")
    .replace(/\[br\]/gi, " ")
    .replace(/#!(?:wiki|if|folding|style|html)\b[^{}\n]*/gi, " ")
    .replace(/\{\{\{(?:[-+]\d+)?/g, " ")
    .replace(/\}\}\}/g, " ")
    .replace(/\[\[([^|\]]+)\|([^\]]*)\]\]/g, (_, target, label) => cleanText(label) || displayWikiTarget(target))
    .replace(/\[\[([^|\]]+)\]\]/g, (_, target) => displayWikiTarget(target))
    .replace(/\[\[([^|\]]+)\|([^\]]+)$/g, (_, target, label) => cleanText(label) || displayWikiTarget(target))
    .replace(/\[\[([^|\]]+)\|\s*$/g, (_, target) => displayWikiTarget(target))
    .replace(/파일:[^\n<>]{1,180}?\.(?:svg|png|jpe?g|gif|webp)/gi, " ")
    .replace(/'{2,5}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function cleanHeading(value: string) {
  return cleanText(value).replace(/^\d+(?:\.\d+)*\.?\s*/, "").trim();
}

function slugifyHeading(value: string, fallback: number) {
  const base = value.normalize("NFKC").toLowerCase().replace(/^\d+(?:\.\d+)*\.?\s*/, "").replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-+|-+$/g, "");
  return base || `section-${fallback}`;
}

function normalizeUrl(src: string) {
  const decoded = decodeEntities((src || "").trim());
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("/")) return `https://www.namu.moe${decoded}`;
  return decoded;
}

function youtubeId(url: string) {
  return url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/i)?.[1];
}

function safeColor(value?: string) {
  if (!value) return undefined;
  const color = value.trim().replace(/["']/g, "");
  return /^(?:#[0-9a-f]{3,8}|rgb\([^)]*\)|rgba\([^)]*\)|black|white|transparent|gray|grey|red|blue|green|pink|purple|orange|yellow)$/i.test(color) ? color : undefined;
}

function attrNumber(node: HTMLElement, name: string) {
  const raw = node.getAttribute(name);
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Math.max(1, Math.min(30, Number(raw)));
}

function nearestTag(node: HTMLElement, tag: string) {
  let parent = node.parentNode;
  const target = tag.toUpperCase();
  while (parent) {
    if (parent instanceof HTMLElement && parent.tagName === target) return parent;
    parent = parent.parentNode;
  }
  return null;
}

function directRows(table: HTMLElement) {
  return table.querySelectorAll("tr").filter((row) => nearestTag(row, "table") === table);
}

function directCells(row: HTMLElement) {
  return row.querySelectorAll("th, td").filter((cell) => nearestTag(cell, "tr") === row);
}

function extractStyle(node: HTMLElement) {
  const style = node.getAttribute("style") || "";
  const background = safeColor(style.match(/background(?:-color)?\s*:\s*([^;]+)/i)?.[1]);
  const color = safeColor(style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1]);
  const alignRaw = style.match(/text-align\s*:\s*(left|center|right)/i)?.[1]?.toLowerCase() || node.getAttribute("align")?.toLowerCase();
  const align: "left" | "center" | "right" | undefined = alignRaw === "left" || alignRaw === "center" || alignRaw === "right" ? alignRaw : undefined;
  return { background, color, align };
}

function preserveCountryAndDate(text: string) {
  const country = ["대한민국", "일본", "미국", "중국"].find((name) => text.includes(name));
  if (!country || !/(행정구|속령)/.test(text)) return text;
  const date = text.match(/\b\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?/);
  return date ? `${date[0].replace(/\s+/g, " ")} ${country}` : country;
}

function parseCell(cell: HTMLElement): RichWikiCell {
  const { background, color, align } = extractStyle(cell);
  const images = cell.querySelectorAll("img").filter((img) => !nearestTag(img, "table") || nearestTag(img, "table") === nearestTag(cell, "table"));
  const image = images.find((img) => !/상세 내용 아이콘|cc-by-nc-sa/i.test(img.getAttribute("alt") || ""));
  const anchors = cell.querySelectorAll("a").filter((anchor) => !nearestTag(anchor, "table") || nearestTag(anchor, "table") === nearestTag(cell, "table"));
  const meaningfulAnchors = anchors.filter((anchor) => {
    const href = anchor.getAttribute("href") || "";
    const label = cleanText(anchor.textContent || "");
    return href && !href.startsWith("#fn-") && !/^파일:/.test(label);
  });
  const meaningfulAnchor = meaningfulAnchors[0];

  const text = preserveCountryAndDate(cleanText(cell.textContent || ""));
  const imgSrc = image?.getAttribute("data-original") || image?.getAttribute("data-src") || image?.getAttribute("src") || undefined;
  const href = meaningfulAnchor?.getAttribute("href") || undefined;
  let linkLabel = meaningfulAnchor ? cleanText(meaningfulAnchor.textContent || "") : undefined;
  if (href && (!linkLabel || linkLabel.startsWith("/w/") || /^https?:\/\//i.test(linkLabel))) {
    const raw = href.replace(/^https?:\/\/(?:www\.)?namu\.moe\/w\//i, "").replace(/^\/w\//, "").split(/[?#]/)[0];
    try { linkLabel = decodeURIComponent(raw); } catch { linkLabel = raw; }
  }
  if (image && meaningfulAnchor && !cleanText(meaningfulAnchor.textContent || "")) linkLabel = undefined;

  return {
    text,
    rowspan: attrNumber(cell, "rowspan"),
    colspan: attrNumber(cell, "colspan"),
    header: cell.tagName === "TH",
    background,
    color,
    align,
    image_url: imgSrc ? normalizeUrl(imgSrc) : undefined,
    image_alt: image?.getAttribute("alt") || undefined,
    link_url: href ? normalizeUrl(href) : undefined,
    link_label: linkLabel,
  };
}

function effectiveCellCount(row: RichWikiCell[]) {
  return row.reduce((sum, cell) => sum + Math.max(1, cell.colspan || 1), 0);
}

function isEmptyCell(cell: RichWikiCell | undefined) {
  return Boolean(cell) && !cell?.text && !cell?.image_url && !cell?.link_url;
}

function normalizeTableRows(rows: RichWikiCell[][]) {
  if (rows.length < 3) return rows;
  const counts = rows.slice(2).map(effectiveCellCount).filter(Boolean);
  if (!counts.length) return rows;
  const frequencies = new Map<number, number>();
  for (const count of counts) frequencies.set(count, (frequencies.get(count) || 0) + 1);
  const dominant = [...frequencies.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominant) return rows;

  return rows.map((row, index) => {
    if (index > 1) return row;
    if (effectiveCellCount(row) === dominant + 1 && isEmptyCell(row[0])) return row.slice(1);
    return row;
  });
}

function parseTable(table: HTMLElement): ParsedBlockV5 | null {
  const rows = directRows(table)
    .map((row) => directCells(row).map(parseCell))
    .filter((row) => row.length && row.some((cell) => cell.text || cell.image_url || cell.link_url));
  const normalized = normalizeTableRows(rows);
  return normalized.length ? { type: "rich-table", rows: normalized.slice(0, 180) } : null;
}

function parseLink(anchor: HTMLElement): ParsedBlockV5 | null {
  const href = anchor.getAttribute("href") || "";
  if (!href) return null;
  let label = cleanText(anchor.textContent || "");
  if (!label && anchor.querySelector("img")) return null;
  const isNamu = href.startsWith("/w/") || /^(?:https?:\/\/)?(?:www\.)?namu\.moe\/w\//i.test(href);
  if (isNamu) {
    const raw = href.replace(/^https?:\/\/(?:www\.)?namu\.moe\/w\//i, "").replace(/^\/w\//, "").split(/[?#]/)[0];
    let target = raw;
    try { target = decodeURIComponent(raw); } catch {}
    if (target === "@문서명@" && label.includes("/")) target = label;
    if (!target || target.startsWith("파일:") || target.startsWith("분류:")) return null;
    if (!label || label.startsWith("/w/") || /^https?:\/\//i.test(label)) label = target;
    return { type: "internal-link", target, label };
  }
  if (/^https?:\/\//i.test(href)) return { type: "external-link", url: decodeEntities(href), label: label || href };
  return null;
}

function isStandalone(node: HTMLElement) {
  const tag = node.tagName;
  if (["H2", "H3", "H4", "TABLE"].includes(tag)) return !nearestTag(node, "table");
  if (["UL", "OL"].includes(tag)) return !nearestTag(node, "table") && !nearestTag(node, "li");
  if (tag === "P") return !nearestTag(node, "table") && !nearestTag(node, "li");
  if (["IMG", "IFRAME", "A"].includes(tag)) return !nearestTag(node, "table") && !nearestTag(node, "p") && !nearestTag(node, "li");
  return false;
}

function structuralNodes(article: HTMLElement) {
  return article.querySelectorAll("h2, h3, h4, table, p, ul, ol, iframe, img, a").filter(isStandalone);
}

function parseNode(node: HTMLElement): ParsedBlockV5 | null {
  if (node.tagName === "TABLE") return parseTable(node);
  if (node.tagName === "UL" || node.tagName === "OL") {
    const items = node.querySelectorAll("li").filter((li) => nearestTag(li, node.tagName.toLowerCase()) === node).map((li) => cleanText(li.textContent || "")).filter(Boolean);
    return items.length ? { type: "list", items: [...new Set(items)].slice(0, 180) } : null;
  }
  if (node.tagName === "P") {
    const text = cleanText(node.textContent || "");
    if (!text || text.length < 2 || /최근 수정 시각|크리에이티브 커먼즈/.test(text)) return null;
    return { type: "paragraph", text };
  }
  if (node.tagName === "IMG") {
    const src = node.getAttribute("data-original") || node.getAttribute("data-src") || node.getAttribute("src") || "";
    const alt = node.getAttribute("alt") || undefined;
    const url = normalizeUrl(src);
    if (!/^https?:\/\//i.test(url) || /상세 내용 아이콘|cc-by-nc-sa/i.test(alt || "")) return null;
    return { type: "image", source_ref: url, url, alt };
  }
  if (node.tagName === "IFRAME") {
    const url = normalizeUrl(node.getAttribute("src") || "");
    if (!url) return null;
    const provider = /youtu/i.test(url) ? "youtube" : /vimeo/i.test(url) ? "vimeo" : "external";
    return { type: "video", provider, url, video_id: provider === "youtube" ? youtubeId(url) : undefined };
  }
  if (node.tagName === "A") return parseLink(node);
  return null;
}

function normalizeTarget(target: string) {
  return target.normalize("NFKC").replace(/#.*$/, "").trim().toLowerCase();
}

function dedupeBlocks(blocks: ParsedBlockV5[]) {
  const output: ParsedBlockV5[] = [];
  const indexByTarget = new Map<string, number>();
  for (const block of blocks) {
    if (block.type !== "internal-link") {
      output.push(block);
      continue;
    }
    const key = normalizeTarget(block.target);
    const existingIndex = indexByTarget.get(key);
    if (existingIndex === undefined) {
      indexByTarget.set(key, output.length);
      output.push(block);
      continue;
    }
    const existing = output[existingIndex];
    if (existing.type === "internal-link") {
      const existingScore = (existing.label.includes("/") ? 100 : 0) + existing.label.length;
      const nextScore = (block.label.includes("/") ? 100 : 0) + block.label.length;
      if (nextScore > existingScore) output[existingIndex] = block;
    }
  }
  return output;
}

export function parseNamuHtmlV5(html: string): ParsedSectionV5[] {
  const root = parse(html, { lowerCaseTagName: false, comment: false });
  const article = root.querySelector("article") || root;
  const nodes = structuralNodes(article);
  const sections: ParsedSectionV5[] = [{ section_key: "lead", heading: "", heading_level: 1, sort_order: 0, content: [] }];
  let current = sections[0];
  let sectionIndex = 0;

  for (const node of nodes) {
    if (["H2", "H3", "H4"].includes(node.tagName)) {
      current.content = dedupeBlocks(current.content);
      sectionIndex += 1;
      const heading = cleanHeading(node.textContent || "") || `Section ${sectionIndex}`;
      current = {
        section_key: slugifyHeading(heading, sectionIndex),
        heading,
        heading_level: Number(node.tagName.slice(1)),
        sort_order: sectionIndex * 10,
        content: [],
      };
      sections.push(current);
      continue;
    }
    const block = parseNode(node);
    if (block) current.content.push(block);
  }
  current.content = dedupeBlocks(current.content);

  return sections.filter((section) => section.heading || section.content.length);
}
