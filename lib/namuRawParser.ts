export type NamuInline =
  | { type: "text"; text: string }
  | { type: "link"; target: string; label: string }
  | { type: "image"; file: string; width?: string; height?: string };

export type NamuRawCell = {
  children: NamuInline[];
  rowspan?: number;
  colspan?: number;
  background?: string;
  color?: string;
  align?: "left" | "center" | "right";
  width?: string;
  nopad?: boolean;
};

export type NamuRawNode =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; children: NamuInline[] }
  | { type: "table"; rows: NamuRawCell[][] }
  | { type: "raw-control"; source: string };

function decodeBasic(value: string) {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#123;/gi, "{")
    .replace(/&#125;/gi, "}");
}

function stripFormatting(value: string) {
  return value
    .replace(/\[br\]/gi, "\n")
    .replace(/'''([^'].*?)'''/g, "$1")
    .replace(/''([^'].*?)''/g, "$1")
    .replace(/\{\{\{[+-]?\d+\s*/g, "")
    .replace(/\{\{\{#!(?:wiki|if|style|html|folding)\b[^\n]*\n?/gi, "")
    .replace(/\}\}\}/g, "")
    .replace(/#!(?:wiki|if|style|html|folding)\b[^\n]*/gi, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function splitTopLevelPipe(value: string) {
  let square = 0;
  let curly = 0;
  for (let i = 0; i < value.length; i += 1) {
    const pair = value.slice(i, i + 2);
    const triple = value.slice(i, i + 3);
    if (pair === "[[") { square += 1; i += 1; continue; }
    if (pair === "]]" && square > 0) { square -= 1; i += 1; continue; }
    if (triple === "{{{") { curly += 1; i += 2; continue; }
    if (triple === "}}}" && curly > 0) { curly -= 1; i += 2; continue; }
    if (value[i] === "|" && square === 0 && curly === 0) return i;
  }
  return -1;
}

function imageFromInner(inner: string): NamuInline | null {
  const pipe = splitTopLevelPipe(inner);
  const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
  if (!/^(?:파일|File):/i.test(target)) return null;
  const file = target.replace(/^(?:파일|File):/i, "").trim();
  const options = pipe >= 0 ? inner.slice(pipe + 1) : "";
  const width = options.match(/(?:^|\|)width=([^|\]]+)/i)?.[1]?.trim();
  const height = options.match(/(?:^|\|)height=([^|\]]+)/i)?.[1]?.trim();
  return { type: "image", file, width, height };
}

export function parseNamuInline(source: string): NamuInline[] {
  const value = decodeBasic(source);
  const output: NamuInline[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const start = value.indexOf("[[", cursor);
    if (start < 0) {
      const text = stripFormatting(value.slice(cursor));
      if (text) output.push({ type: "text", text });
      break;
    }
    const before = stripFormatting(value.slice(cursor, start));
    if (before) output.push({ type: "text", text: before });

    let depth = 1;
    let end = start + 2;
    while (end < value.length && depth > 0) {
      if (value.slice(end, end + 2) === "[[") { depth += 1; end += 2; continue; }
      if (value.slice(end, end + 2) === "]]" ) { depth -= 1; if (depth === 0) break; end += 2; continue; }
      end += 1;
    }
    if (depth !== 0) {
      const text = stripFormatting(value.slice(start));
      if (text) output.push({ type: "text", text });
      break;
    }

    const inner = value.slice(start + 2, end);
    const image = imageFromInner(inner);
    if (image) {
      output.push(image);
    } else {
      const pipe = splitTopLevelPipe(inner);
      const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      const labelSource = pipe >= 0 ? inner.slice(pipe + 1) : target;
      const nestedImage = labelSource.trim().startsWith("[[") ? parseNamuInline(labelSource) : [];
      if (nestedImage.some((node) => node.type === "image")) output.push(...nestedImage);
      else if (target) output.push({ type: "link", target, label: stripFormatting(labelSource) || target });
    }
    cursor = end + 2;
  }

  return output;
}

function parseCellDirectives(source: string) {
  let rest = source.trim();
  const directives: string[] = [];
  while (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    if (end < 0) break;
    directives.push(rest.slice(1, end));
    rest = rest.slice(end + 1).trimStart();
  }

  const meta: Omit<NamuRawCell, "children"> = {};
  for (const directive of directives) {
    if (/^nopad$/i.test(directive)) meta.nopad = true;
    const bg = directive.match(/^(?:bgcolor|tablebgcolor|colbgcolor)=([^,>]+)/i)?.[1];
    if (bg && /^#[0-9a-f]{3,8}$/i.test(bg.trim())) meta.background = bg.trim();
    const color = directive.match(/^(?:color|colcolor)=([^,>]+)/i)?.[1];
    if (color && /^#[0-9a-f]{3,8}$/i.test(color.trim())) meta.color = color.trim();
    const width = directive.match(/^width=([^>]+)/i)?.[1];
    if (width) meta.width = width.trim();
    const rowspan = directive.match(/^\|(-?\d+)$/)?.[1];
    if (rowspan) meta.rowspan = Math.max(1, Math.abs(Number(rowspan)));
    const colspan = directive.match(/^-(\d+)$/)?.[1];
    if (colspan) meta.colspan = Math.max(1, Number(colspan));
    if (/^\^/.test(directive)) meta.align = "center";
    if (/^\(/.test(directive)) meta.align = "left";
    if (/^\)/.test(directive)) meta.align = "right";
  }
  return { rest, meta };
}

function parseTableLines(lines: string[]) {
  const rows: NamuRawCell[][] = [];
  let current: NamuRawCell[] = [];

  for (const line of lines) {
    const pieces = line.split("||").slice(1);
    for (let i = 0; i < pieces.length; i += 1) {
      const piece = pieces[i];
      if (piece === "" && i === pieces.length - 1) continue;
      const { rest, meta } = parseCellDirectives(piece);
      current.push({ ...meta, children: parseNamuInline(rest) });
    }
    if (line.trimEnd().endsWith("||") || current.length >= 1) {
      rows.push(current);
      current = [];
    }
  }
  if (current.length) rows.push(current);
  return rows.filter((row) => row.some((cell) => cell.children.length || cell.background || cell.rowspan || cell.colspan));
}

function meaningfulParagraph(source: string) {
  const text = stripFormatting(source);
  return text && !/^#!(?:wiki|if|style|html|folding)\b/i.test(text);
}

export function parseNamuRaw(source: string): NamuRawNode[] {
  const lines = decodeBasic(source).replace(/\r\n?/g, "\n").split("\n");
  const nodes: NamuRawNode[] = [];
  let paragraph: string[] = [];
  let table: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join("\n").trim();
    if (meaningfulParagraph(joined)) {
      const children = parseNamuInline(joined);
      if (children.length) nodes.push({ type: "paragraph", children });
    }
    paragraph = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = parseTableLines(table);
    if (rows.length) nodes.push({ type: "table", rows });
    table = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trimStart().startsWith("||")) {
      flushParagraph();
      table.push(line.trimStart());
      continue;
    }
    if (table.length) flushTable();

    const heading = line.match(/^\s*(={2,6})\s*(.*?)\s*\1\s*$/);
    if (heading) {
      flushParagraph();
      nodes.push({ type: "heading", level: heading[1].length, text: stripFormatting(heading[2]) });
      continue;
    }
    const pseudoHeading = line.match(/^\s*#{2,6}\s*(?:🔶\s*)?(.*?)\s*$/);
    if (pseudoHeading) {
      flushParagraph();
      nodes.push({ type: "heading", level: 3, text: stripFormatting(pseudoHeading[1]) });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      continue;
    }
    if (/^\s*#!(?:style|if)\b/i.test(line) || /^\s*\/\*/.test(line)) {
      flushParagraph();
      nodes.push({ type: "raw-control", source: line.trim() });
      continue;
    }
    paragraph.push(line);
  }
  flushTable();
  flushParagraph();
  return nodes;
}
