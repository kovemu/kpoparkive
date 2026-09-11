import { createRequire } from "node:module";

const { parse: parseHtml } = createRequire(import.meta.url)("node-html-parser");

export const DOM_TO_NAMUMARK_VERSION = "dom-to-namumark-v3";

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/g, " ").replace(/[\t\r\n ]+/g, " ").trim();
}

function escapeText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\]\]/g, "\\]\\]");
}

function directElements(node, tags) {
  const wanted = new Set(tags.map((item) => item.toLowerCase()));
  return (node?.childNodes || []).filter((child) => wanted.has(String(child?.tagName || "").toLowerCase()));
}

function styleMap(element) {
  const map = new Map();
  const raw = String(element?.getAttribute?.("style") || "");
  for (const part of raw.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    const key = part.slice(0, colon).trim().toLowerCase();
    const value = part.slice(colon + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

function cssColor(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "transparent" || raw === "rgba(0, 0, 0, 0)") return "";
  const hex = raw.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) return "#" + hex[1].toLowerCase();
  const rgb = raw.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
  if (!rgb) return "";
  if (rgb[4] !== undefined && Number(rgb[4]) === 0) return "";
  const toHex = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, "0");
  return "#" + toHex(rgb[1]) + toHex(rgb[2]) + toHex(rgb[3]);
}

function numericPx(value) {
  const match = String(value || "").trim().match(/^(-?\d+(?:\.\d+)?)px$/i);
  return match ? Number(match[1]) : null;
}

function layoutWidth(element) {
  const dataWidth = Number(element?.getAttribute?.("data-kpop-layout-width"));
  if (Number.isFinite(dataWidth) && dataWidth > 0) return dataWidth;
  const width = numericPx(styleMap(element).get("width"));
  return width && width > 0 ? width : null;
}

function isInternalHref(href) {
  return /^\/w\//.test(String(href || ""));
}

function decodeWikiTarget(href) {
  const raw = String(href || "").replace(/^\/w\//, "");
  const [pathPart, hash] = raw.split("#", 2);
  let decoded = pathPart;
  try { decoded = decodeURIComponent(pathPart); } catch {}
  return hash ? decoded + "#" + hash : decoded;
}

function youtubeIdFromSrc(src) {
  const raw = String(src || "");
  const embed = raw.match(/youtube(?:-nocookie)?\.com\/embed\/([A-Za-z0-9_-]{6,20})/i);
  if (embed) return embed[1];
  const watch = raw.match(/[?&]v=([A-Za-z0-9_-]{6,20})/i);
  return watch ? watch[1] : "";
}

function meaningfulBorderColor(table) {
  const candidates = [table, ...table.querySelectorAll("td,th,tr")];
  for (const element of candidates) {
    const styles = styleMap(element);
    for (const key of ["border-color", "border-top-color", "border-left-color"]) {
      const color = cssColor(styles.get(key));
      if (color && !["#dddddd", "#ffffff", "#fff", "#000000", "#212529"].includes(color)) return color;
    }
  }
  return "";
}

function tableOptions(table) {
  const opts = ["<tablealign=center>"];
  const width = layoutWidth(table);
  if (width) opts.push(`<tablewidth=${Math.max(120, Math.round(width))}>`);
  const border = meaningfulBorderColor(table);
  if (border) opts.push(`<tablebordercolor=${border}>`);
  const bg = cssColor(styleMap(table).get("background-color"));
  if (bg) opts.push(`<tablebgcolor=${bg}>`);
  return opts.join("");
}

function visualCellElement(cell) {
  const descendants = cell.querySelectorAll("*");
  for (const node of descendants) {
    const display = String(styleMap(node).get("display") || "").toLowerCase();
    if (display === "table-cell") return node;
  }
  return cell;
}

function logicalCellStyle(cell, property) {
  const visual = visualCellElement(cell);
  const direct = styleMap(visual).get(property);
  if (direct) return direct;
  const own = styleMap(cell).get(property);
  if (own) return own;
  const row = styleMap(cell.parentNode).get(property);
  return row || "";
}

function cellOptions(cell, tableWidth) {
  const opts = [];
  const colspan = Number(cell.getAttribute("colspan") || 1);
  const rowspan = Number(cell.getAttribute("rowspan") || 1);
  if (Number.isFinite(colspan) && colspan > 1) opts.push(`<-${Math.round(colspan)}>`);
  if (Number.isFinite(rowspan) && rowspan > 1) opts.push(`<|${Math.round(rowspan)}>`);

  const styles = styleMap(cell);
  const visualStyles = styleMap(visualCellElement(cell));
  const rowStyles = styleMap(cell.parentNode);
  const bg = cssColor(logicalCellStyle(cell, "background-color"));
  const color = cssColor(logicalCellStyle(cell, "color"));

  if (bg) opts.push(`<bgcolor=${bg}>`);
  if (color && color !== "#212529" && color !== "#000000" && !(color === "#ffffff" && !bg)) {
    opts.push(`<color=${color}>`);
  }

  const align = String(
    visualStyles.get("text-align") ||
    styles.get("text-align") ||
    rowStyles.get("text-align") ||
    ""
  ).toLowerCase();
  if (align === "center") opts.push("<:>");
  else if (align === "right" || align === "end") opts.push("<)>");
  else if (align === "left" || align === "start") opts.push("<(>");

  const width = layoutWidth(cell);
  if (width && tableWidth && colspan <= 1) {
    const pct = Math.round((width / tableWidth) * 100);
    if (pct >= 8 && pct <= 92) {
      const rounded = Math.max(5, Math.min(95, Math.round(pct / 5) * 5));
      opts.push(`<width=${rounded}%>`);
    }
  }
  return opts.join("");
}

function textOf(node) {
  return normalizeText(node?.innerText || node?.text || node?.textContent || "");
}

function childrenToNamu(node, ctx) {
  return (node?.childNodes || []).map((child) => nodeToNamu(child, ctx)).join("");
}

function nodeToNamu(node, ctx) {
  if (!node) return "";
  const type = Number(node.nodeType);
  if (type === 3) {
    const raw = String(node.rawText ?? node.text ?? "");
    if (!raw.trim()) return raw.includes("\n") ? "\n" : " ";
    return escapeText(raw.replace(/\u00a0/g, " "));
  }

  const tag = String(node.tagName || "").toLowerCase();
  if (!tag) return childrenToNamu(node, ctx);

  if (["script", "style", "noscript", "meta", "link", "base"].includes(tag)) return "";
  if (tag === "br") return "[br]";
  if (tag === "hr") return "\n----\n";
  if (tag === "strong" || tag === "b") return "'''" + childrenToNamu(node, ctx).trim() + "'''";
  if (tag === "em" || tag === "i") return "''" + childrenToNamu(node, ctx).trim() + "''";
  if (tag === "u") return "__" + childrenToNamu(node, ctx).trim() + "__";
  if (tag === "s" || tag === "del") return "~~" + childrenToNamu(node, ctx).trim() + "~~";

  if (tag === "a") {
    const href = String(node.getAttribute("href") || "").trim();
    const label = childrenToNamu(node, ctx).trim() || textOf(node);
    if (!href || href === "#") return label;
    if (isInternalHref(href)) {
      const target = decodeWikiTarget(href);
      const plainLabel = normalizeText(textOf(node));
      if (normalizeText(target) === plainLabel) return `[[${target}]]`;
      return `[[${target}|${label || plainLabel || target}]]`;
    }
    if (/^https?:\/\//i.test(href)) return `[${href}${label ? " " + label : ""}]`;
    return label;
  }

  if (tag === "img") {
    const alt = normalizeText(node.getAttribute("alt") || "");
    if (/^(?:파일|File):/i.test(alt)) {
      const file = alt.replace(/^(?:파일|File):/i, "");
      const width = layoutWidth(node);
      return `[[파일:${file}${width ? `|width=${Math.max(12, Math.round(width))}` : ""}]]`;
    }
    return alt ? escapeText(alt) : "";
  }

  if (tag === "iframe") {
    const id = youtubeIdFromSrc(node.getAttribute("src") || "");
    return id ? `[youtube(${id})]` : "";
  }

  if (tag === "details") {
    const summary = directElements(node, ["summary"])[0];
    const title = summary ? normalizeText(summary.innerText || summary.text || "") : "Details";
    const body = (node.childNodes || [])
      .filter((child) => child !== summary)
      .map((child) => nodeToNamu(child, ctx))
      .join("")
      .trim();
    return `{{{#!folding [ ${title.replace(/^\[\s*|\s*\]$/g, "")} ]\n${body}\n}}}`;
  }

  if (tag === "table") return tableToNamu(node, ctx);

  if (tag === "p") {
    const body = childrenToNamu(node, ctx).trim();
    return body ? body + "\n" : "";
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const text = childrenToNamu(node, ctx).trim();
    const marks = "=".repeat(Math.min(6, Math.max(1, level)));
    return `\n${marks} ${text} ${marks}\n`;
  }

  if (tag === "li") return "* " + childrenToNamu(node, ctx).trim() + "\n";
  if (tag === "ul" || tag === "ol") return "\n" + childrenToNamu(node, ctx);

  return childrenToNamu(node, ctx);
}

function tableRows(table) {
  const output = [];
  const walk = (node, insideNestedTable = false) => {
    for (const child of node?.childNodes || []) {
      const tag = String(child?.tagName || "").toLowerCase();
      if (tag === "table" && child !== table) continue;
      if (tag === "tr" && !insideNestedTable) {
        output.push(child);
        continue;
      }
      walk(child, insideNestedTable || (tag === "table" && child !== table));
    }
  };
  walk(table, false);
  return output;
}

function directCells(row) {
  return (row?.childNodes || []).filter((child) => ["td", "th"].includes(String(child?.tagName || "").toLowerCase()));
}

function tableToNamu(table, ctx) {
  const rows = tableRows(table);
  if (!rows.length) return childrenToNamu(table, ctx);
  const width = layoutWidth(table);
  const rootOpts = tableOptions(table);
  const lines = [];

  rows.forEach((row, rowIndex) => {
    const cells = directCells(row);
    if (!cells.length) return;
    const rendered = cells.map((cell, cellIndex) => {
      const opts = cellOptions(cell, width);
      const prefix = rowIndex === 0 && cellIndex === 0 ? rootOpts + opts : opts;
      let body = childrenToNamu(cell, { ...ctx, inCell: true }).trim();
      body = body.replace(/^\n+|\n+$/g, "");
      return `${prefix} ${body} `;
    });
    lines.push("||" + rendered.join("||") + "||");
  });

  return "\n" + lines.join("\n") + "\n";
}

function cleanupNamu(source) {
  return String(source || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n")
    .trim() + "\n";
}

function collectDomMetrics(root) {
  const links = new Set();
  const images = new Set();
  for (const anchor of root.querySelectorAll("a")) {
    const href = String(anchor.getAttribute("href") || "");
    if (isInternalHref(href)) links.add(decodeWikiTarget(href));
  }
  for (const image of root.querySelectorAll("img")) {
    const alt = normalizeText(image.getAttribute("alt") || "");
    if (/^(?:파일|File):/i.test(alt)) images.add(alt.replace(/^(?:파일|File):/i, ""));
  }
  return {
    text: normalizeText(root.innerText || root.text || ""),
    links: [...links].sort(),
    images: [...images].sort(),
    tables: root.querySelectorAll("table").length,
    rows: root.querySelectorAll("tr").length,
    cells: root.querySelectorAll("td,th").length,
    foldings: root.querySelectorAll("details").length,
    youtube: root.querySelectorAll("iframe").map((node) => youtubeIdFromSrc(node.getAttribute("src") || "")).filter(Boolean),
  };
}

function collectNamuMetrics(source) {
  const text = normalizeText(
    String(source || "")
      .replace(/\[\[(?:파일|File):[^\]]+\]\]/gi, " ")
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
      .replace(/\[\[([^\]]+)\]\]/g, "$1")
      .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, "$1")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\{\{\{#!folding[^\n]*\n/g, " ")
      .replace(/\{\{\{|\}\}\}/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\|\|/g, " ")
      .replace(/'''|''|__|~~/g, "")
  );
  const links = [...String(source || "").matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)]
    .map((m) => m[1]).filter((value) => !/^(?:파일|File):/i.test(value));
  const images = [...String(source || "").matchAll(/\[\[(?:파일|File):([^\]|]+)(?:\|[^\]]+)?\]\]/gi)].map((m) => m[1]);
  const youtube = [...String(source || "").matchAll(/\[youtube\(([A-Za-z0-9_-]{6,20})/gi)].map((m) => m[1]);
  const lines = String(source || "").split(/\r?\n/);
  const tableLines = lines.filter((line) => line.trim().startsWith("||"));
  return {
    text,
    links: [...new Set(links)].sort(),
    images: [...new Set(images)].sort(),
    tables: tableLines.length ? 1 : 0,
    rows: tableLines.length,
    cells: tableLines.reduce((sum, line) => sum + Math.max(0, line.split("||").length - 3), 0),
    foldings: (String(source || "").match(/\{\{\{#!folding/g) || []).length,
    youtube,
  };
}

function setSimilarity(a, b) {
  const left = new Set(a || []);
  const right = new Set(b || []);
  const union = new Set([...left, ...right]);
  if (!union.size) return 1;
  let hit = 0;
  for (const item of union) if (left.has(item) && right.has(item)) hit += 1;
  return hit / union.size;
}

function compactText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff\s]+/g, "")
    .toLowerCase();
}

function textSequenceSimilarity(a, b) {
  const left = compactText(a);
  const right = compactText(b);
  if (left === right) return 1;
  if (!left || !right) return 0;

  const n = Math.min(3, left.length, right.length);
  const grams = (value) => {
    const out = [];
    if (value.length <= n) return [value];
    for (let i = 0; i <= value.length - n; i += 1) out.push(value.slice(i, i + n));
    return out;
  };

  return setSimilarity(grams(left), grams(right));
}


function ratioSimilarity(left, right) {
  const a = Math.max(0, Number(left) || 0);
  const b = Math.max(0, Number(right) || 0);
  if (a === 0 && b === 0) return 1;
  if (a === 0 || b === 0) return 0;
  return Math.min(a, b) / Math.max(a, b);
}

export function compareDomFidelity(originalHtml, renderedHtml) {
  const originalRoot = parseHtml(String(originalHtml || ""), { comment: false });
  const renderedRoot = parseHtml(String(renderedHtml || ""), { comment: false });
  const original = collectDomMetrics(originalRoot);
  const rendered = collectDomMetrics(renderedRoot);

  const detail = {
    textTokenSimilarity: textSequenceSimilarity(original.text, rendered.text),
    linkSimilarity: setSimilarity(original.links, rendered.links),
    imageSimilarity: setSimilarity(original.images, rendered.images),
    youtubeSimilarity: setSimilarity(original.youtube, rendered.youtube),
    tableSimilarity: ratioSimilarity(original.tables, rendered.tables),
    rowSimilarity: ratioSimilarity(original.rows, rendered.rows),
    cellSimilarity: ratioSimilarity(original.cells, rendered.cells),
    foldingSimilarity: ratioSimilarity(original.foldings, rendered.foldings),
    original,
    rendered,
  };

  const score =
    detail.textTokenSimilarity * 0.35 +
    detail.linkSimilarity * 0.15 +
    detail.imageSimilarity * 0.05 +
    detail.youtubeSimilarity * 0.05 +
    detail.tableSimilarity * 0.10 +
    detail.rowSimilarity * 0.10 +
    detail.cellSimilarity * 0.10 +
    detail.foldingSimilarity * 0.10;

  return {
    ...detail,
    score: Math.round(score * 10000) / 10000,
  };
}

export function convertDomToNamuMark(htmlValue, options = {}) {
  const root = parseHtml(String(htmlValue || ""), { comment: false });
  const namumark = cleanupNamu(nodeToNamu(root, { title: options.title || "", language: options.language || "ko" }));
  const dom = collectDomMetrics(root);
  const generated = collectNamuMetrics(namumark);
  const fidelity = {
    textTokenSimilarity: textSequenceSimilarity(dom.text, generated.text),
    linkSimilarity: setSimilarity(dom.links, generated.links),
    imageSimilarity: setSimilarity(dom.images, generated.images),
    youtubeSimilarity: setSimilarity(dom.youtube, generated.youtube),
    foldingsExact: dom.foldings === generated.foldings,
    dom,
    generated,
  };
  const score = (
    fidelity.textTokenSimilarity * 0.45 +
    fidelity.linkSimilarity * 0.20 +
    fidelity.imageSimilarity * 0.10 +
    fidelity.youtubeSimilarity * 0.10 +
    (fidelity.foldingsExact ? 0.15 : 0)
  );

  return {
    version: DOM_TO_NAMUMARK_VERSION,
    namumark,
    fidelity: { ...fidelity, score: Math.round(score * 10000) / 10000 },
  };
}
