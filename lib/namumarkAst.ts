export type NamuAstNodeType =
  | "document"
  | "whitespace"
  | "heading"
  | "paragraph"
  | "list"
  | "table"
  | "template"
  | "media"
  | "divider"
  | "styled-block"
  | "raw-block"
  | "text"
  | "link"
  | "external-link"
  | "format"
  | "footnote"
  | "inline-media"
  | "raw-inline";

export type NamuAstMark = "bold" | "italic" | "underline" | "strike" | "superscript";

export type NamuAstBase = {
  id: string;
  type: NamuAstNodeType;
  sourceStart: number;
  sourceEnd: number;
  raw: string;
};

export type NamuAstText = NamuAstBase & {
  type: "text";
  text: string;
};

export type NamuAstLink = NamuAstBase & {
  type: "link";
  target: string;
  label: string;
  explicitLabel: boolean;
  labelStart: number;
  labelEnd: number;
  children: NamuAstInlineNode[];
};

export type NamuAstExternalLink = NamuAstBase & {
  type: "external-link";
  url: string;
  label: string;
  explicitLabel: boolean;
  labelStart: number;
  labelEnd: number;
  children: NamuAstInlineNode[];
};

export type NamuAstFormat = NamuAstBase & {
  type: "format";
  mark: NamuAstMark;
  contentStart: number;
  contentEnd: number;
  children: NamuAstInlineNode[];
};

export type NamuAstFootnote = NamuAstBase & {
  type: "footnote";
  body: string;
};

export type NamuAstInlineMedia = NamuAstBase & {
  type: "inline-media";
  mediaKind: "file" | "youtube" | "other";
  target: string;
};

export type NamuAstRawInline = NamuAstBase & {
  type: "raw-inline";
  reason: string;
};

export type NamuAstInlineNode =
  | NamuAstText
  | NamuAstLink
  | NamuAstExternalLink
  | NamuAstFormat
  | NamuAstFootnote
  | NamuAstInlineMedia
  | NamuAstRawInline;

export type NamuAstWhitespaceBlock = NamuAstBase & {
  type: "whitespace";
};

export type NamuAstHeading = NamuAstBase & {
  type: "heading";
  level: number;
  contentStart: number;
  contentEnd: number;
  children: NamuAstInlineNode[];
};

export type NamuAstParagraph = NamuAstBase & {
  type: "paragraph";
  children: NamuAstInlineNode[];
};

export type NamuAstList = NamuAstBase & {
  type: "list";
  lines: Array<{
    sourceStart: number;
    sourceEnd: number;
    marker: string;
    indent: number;
    children: NamuAstInlineNode[];
  }>;
};

export type NamuAstTable = NamuAstBase & {
  type: "table";
  rowCount: number;
  editingMode: "structured-bridge";
};

export type NamuAstTemplate = NamuAstBase & {
  type: "template";
  name: string;
  args: string[];
};

export type NamuAstMedia = NamuAstBase & {
  type: "media";
  mediaKind: "file" | "youtube" | "other";
  target: string;
};

export type NamuAstDivider = NamuAstBase & {
  type: "divider";
};

export type NamuAstStyledBlock = NamuAstBase & {
  type: "styled-block";
  editingMode: "source-fallback";
};

export type NamuAstRawBlock = NamuAstBase & {
  type: "raw-block";
  reason: string;
  editingMode: "source-fallback";
};

export type NamuAstBlockNode =
  | NamuAstWhitespaceBlock
  | NamuAstHeading
  | NamuAstParagraph
  | NamuAstList
  | NamuAstTable
  | NamuAstTemplate
  | NamuAstMedia
  | NamuAstDivider
  | NamuAstStyledBlock
  | NamuAstRawBlock;

export type NamuAstDocument = NamuAstBase & {
  type: "document";
  version: 1;
  source: string;
  blocks: NamuAstBlockNode[];
  stats: {
    blockCount: number;
    inlineNodeCount: number;
    headingCount: number;
    linkCount: number;
    tableCount: number;
    templateCount: number;
    mediaCount: number;
    fallbackBlockCount: number;
  };
};

type SourceLine = {
  start: number;
  contentEnd: number;
  end: number;
  content: string;
  eol: string;
};

const HEADING_RE = /^(={2,6})\s*(.*?)\s*\1\s*$/;
const LIST_RE = /^(\s+)((?:\*|[-+]|\d+[.)]|[A-Za-z][.)]))\s+(.*)$/;

function tinyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function nodeId(type: NamuAstNodeType, start: number, end: number, raw: string) {
  return `nm:${type}:${start}:${end}:${tinyHash(raw)}`;
}

function baseNode<T extends NamuAstNodeType>(source: string, type: T, start: number, end: number) {
  const raw = source.slice(start, end);
  return { id: nodeId(type, start, end, raw), type, sourceStart: start, sourceEnd: end, raw };
}

function sourceLines(source: string): SourceLine[] {
  if (!source) return [];
  const lines: SourceLine[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    const start = cursor;
    let contentEnd = cursor;
    while (contentEnd < source.length && source[contentEnd] !== "\n" && source[contentEnd] !== "\r") contentEnd += 1;
    let end = contentEnd;
    let eol = "";
    if (end < source.length) {
      if (source[end] === "\r" && source[end + 1] === "\n") {
        eol = "\r\n";
        end += 2;
      } else {
        eol = source[end];
        end += 1;
      }
    }
    lines.push({ start, contentEnd, end, content: source.slice(start, contentEnd), eol });
    cursor = end;
  }
  return lines;
}

function countToken(value: string, token: string) {
  let count = 0;
  let cursor = 0;
  while (cursor < value.length) {
    const at = value.indexOf(token, cursor);
    if (at < 0) break;
    count += 1;
    cursor = at + token.length;
  }
  return count;
}

function curlyDelta(value: string) {
  return countToken(value, "{{{") - countToken(value, "}}}");
}

function findBalancedPair(source: string, start: number, open: string, close: string, limit: number) {
  let depth = 1;
  let cursor = start + open.length;
  while (cursor < limit) {
    if (source.startsWith(open, cursor)) {
      depth += 1;
      cursor += open.length;
      continue;
    }
    if (source.startsWith(close, cursor)) {
      depth -= 1;
      if (depth === 0) return cursor + close.length;
      cursor += close.length;
      continue;
    }
    cursor += 1;
  }
  return -1;
}

function findBalancedSingleBracket(source: string, start: number, limit: number) {
  let depth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    if (source.startsWith("[[", cursor)) {
      const end = findBalancedPair(source, cursor, "[[", "]]", limit);
      if (end < 0) return -1;
      cursor = end - 1;
      continue;
    }
    if (source[cursor] === "[") depth += 1;
    else if (source[cursor] === "]") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

function splitFirstPipe(value: string) {
  let squareDepth = 0;
  let curlyDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value.startsWith("[[", index)) {
      squareDepth += 1;
      index += 1;
      continue;
    }
    if (value.startsWith("]]", index) && squareDepth > 0) {
      squareDepth -= 1;
      index += 1;
      continue;
    }
    if (value.startsWith("{{{", index)) {
      curlyDepth += 1;
      index += 2;
      continue;
    }
    if (value.startsWith("}}}", index) && curlyDepth > 0) {
      curlyDepth -= 1;
      index += 2;
      continue;
    }
    if (value[index] === "|" && squareDepth === 0 && curlyDepth === 0) return index;
  }
  return -1;
}

function parseInternalLink(source: string, start: number, end: number): NamuAstInlineNode | null {
  const close = findBalancedPair(source, start, "[[", "]]", end);
  if (close < 0) return null;
  const raw = source.slice(start, close);
  const innerStart = start + 2;
  const innerEnd = close - 2;
  const inner = source.slice(innerStart, innerEnd);
  const pipe = splitFirstPipe(inner);
  const targetRaw = pipe < 0 ? inner : inner.slice(0, pipe);
  const target = targetRaw.trim();

  if (/^(?:파일|File):/i.test(target)) {
    return {
      ...baseNode(source, "inline-media", start, close),
      type: "inline-media",
      mediaKind: "file",
      target,
    };
  }
  if (/^(?:분류|Category):/i.test(target)) {
    return {
      ...baseNode(source, "raw-inline", start, close),
      type: "raw-inline",
      reason: "Category link is document metadata",
    };
  }

  const explicitLabel = pipe >= 0;
  const labelStart = explicitLabel ? innerStart + pipe + 1 : innerStart;
  const labelEnd = innerEnd;
  const label = source.slice(labelStart, labelEnd);
  return {
    ...baseNode(source, "link", start, close),
    type: "link",
    target,
    label,
    explicitLabel,
    labelStart,
    labelEnd,
    children: parseNamuInline(source, labelStart, labelEnd),
  };
}

function parseExternalLink(source: string, start: number, end: number): NamuAstExternalLink | null {
  if (!/^\[(?:https?:\/\/)/i.test(source.slice(start, Math.min(end, start + 12)))) return null;
  const close = findBalancedSingleBracket(source, start, end);
  if (close < 0) return null;
  const innerStart = start + 1;
  const innerEnd = close - 1;
  const inner = source.slice(innerStart, innerEnd);
  const whitespace = inner.search(/\s/);
  const url = (whitespace < 0 ? inner : inner.slice(0, whitespace)).trim();
  if (!/^https?:\/\//i.test(url)) return null;
  const explicitLabel = whitespace >= 0;
  let labelStart = innerEnd;
  if (explicitLabel) {
    labelStart = innerStart + whitespace;
    while (labelStart < innerEnd && /\s/.test(source[labelStart])) labelStart += 1;
  }
  const labelEnd = innerEnd;
  const label = explicitLabel ? source.slice(labelStart, labelEnd) : url;
  return {
    ...baseNode(source, "external-link", start, close),
    type: "external-link",
    url,
    label,
    explicitLabel,
    labelStart: explicitLabel ? labelStart : innerStart,
    labelEnd: explicitLabel ? labelEnd : innerStart + url.length,
    children: explicitLabel ? parseNamuInline(source, labelStart, labelEnd) : [],
  };
}

function parseFootnote(source: string, start: number, end: number): NamuAstFootnote | null {
  if (!source.startsWith("[*", start)) return null;
  const close = findBalancedSingleBracket(source, start, end);
  if (close < 0) return null;
  return {
    ...baseNode(source, "footnote", start, close),
    type: "footnote",
    body: source.slice(start + 2, close - 1).trim(),
  };
}

const FORMATS: Array<{ token: string; mark: NamuAstMark }> = [
  { token: "'''", mark: "bold" },
  { token: "''", mark: "italic" },
  { token: "__", mark: "underline" },
  { token: "~~", mark: "strike" },
  { token: "^^", mark: "superscript" },
];

function parseFormat(source: string, start: number, end: number): NamuAstFormat | null {
  for (const format of FORMATS) {
    if (!source.startsWith(format.token, start)) continue;
    const contentStart = start + format.token.length;
    const closeAt = source.indexOf(format.token, contentStart);
    if (closeAt < 0 || closeAt >= end) continue;
    const close = closeAt + format.token.length;
    return {
      ...baseNode(source, "format", start, close),
      type: "format",
      mark: format.mark,
      contentStart,
      contentEnd: closeAt,
      children: parseNamuInline(source, contentStart, closeAt),
    };
  }
  return null;
}

function parseRawTriple(source: string, start: number, end: number): NamuAstRawInline | null {
  if (!source.startsWith("{{{", start)) return null;
  const close = findBalancedPair(source, start, "{{{", "}}}", end);
  if (close < 0) return null;
  return {
    ...baseNode(source, "raw-inline", start, close),
    type: "raw-inline",
    reason: "Formatted or styled inline NamuMark is preserved as an atomic source node",
  };
}

function parseBracketMacro(source: string, start: number, end: number): NamuAstInlineMedia | NamuAstRawInline | null {
  const rest = source.slice(start, Math.min(end, start + 40));
  const media = rest.match(/^\[(youtube|kakaotv|nicovideo|vimeo)\(/i);
  if (media) {
    const close = findBalancedSingleBracket(source, start, end);
    if (close < 0) return null;
    return {
      ...baseNode(source, "inline-media", start, close),
      type: "inline-media",
      mediaKind: media[1].toLowerCase() === "youtube" ? "youtube" : "other",
      target: source.slice(start + 1, close - 1),
    };
  }
  if (/^\[include\(/i.test(rest) || /^\[(?:목차|각주|clearfix)\]/i.test(rest) || /^\[(?:age|dday)\(/i.test(rest)) {
    const close = findBalancedSingleBracket(source, start, end);
    if (close < 0) return null;
    return {
      ...baseNode(source, "raw-inline", start, close),
      type: "raw-inline",
      reason: "Macro output is preserved as an atomic source node",
    };
  }
  return null;
}

export function parseNamuInline(source: string, start = 0, end = source.length): NamuAstInlineNode[] {
  const nodes: NamuAstInlineNode[] = [];
  let cursor = start;
  let textStart = start;

  const flushText = (until: number) => {
    if (until <= textStart) return;
    const text = source.slice(textStart, until);
    nodes.push({ ...baseNode(source, "text", textStart, until), type: "text", text });
  };

  while (cursor < end) {
    let parsed: NamuAstInlineNode | null = null;
    if (source.startsWith("[[", cursor)) parsed = parseInternalLink(source, cursor, end);
    if (!parsed && source.startsWith("[*", cursor)) parsed = parseFootnote(source, cursor, end);
    if (!parsed && source[cursor] === "[") parsed = parseExternalLink(source, cursor, end) || parseBracketMacro(source, cursor, end);
    if (!parsed && source.startsWith("{{{", cursor)) parsed = parseRawTriple(source, cursor, end);
    if (!parsed) parsed = parseFormat(source, cursor, end);

    if (!parsed) {
      cursor += 1;
      continue;
    }

    flushText(cursor);
    nodes.push(parsed);
    cursor = parsed.sourceEnd;
    textStart = cursor;
  }

  flushText(end);
  return nodes;
}

function lineLooksLikeList(line: SourceLine) {
  return LIST_RE.test(line.content);
}

function lineLooksLikeTable(line: SourceLine) {
  return /^\s*\|\|/.test(line.content);
}

function lineLooksLikeStandaloneTemplate(line: SourceLine) {
  return /^\s*\[include\([\s\S]*\)\]\s*$/i.test(line.content);
}

function lineLooksLikeStandaloneMedia(line: SourceLine) {
  return /^\s*(?:\[\[(?:파일|File):|\[(?:youtube|kakaotv|nicovideo|vimeo)\()/i.test(line.content);
}

function lineLooksLikeDivider(line: SourceLine) {
  return /^\s*-{4,}\s*$/.test(line.content);
}

function lineStartsStyledBlock(line: SourceLine) {
  return /^\s*\{\{\{#!wiki\b/i.test(line.content);
}

function lineStartsRawTripleBlock(line: SourceLine) {
  return /^\s*\{\{\{/.test(line.content);
}

function lineStartsStructuralBlock(line: SourceLine) {
  return Boolean(
    HEADING_RE.test(line.content) ||
    lineLooksLikeTable(line) ||
    lineLooksLikeList(line) ||
    lineLooksLikeStandaloneTemplate(line) ||
    lineLooksLikeStandaloneMedia(line) ||
    lineLooksLikeDivider(line) ||
    lineStartsStyledBlock(line) ||
    lineStartsRawTripleBlock(line),
  );
}

function gatherTripleBlock(lines: SourceLine[], from: number) {
  let depth = 0;
  let index = from;
  for (; index < lines.length; index += 1) {
    depth += curlyDelta(lines[index].content);
    if (depth <= 0 && index >= from) return index + 1;
  }
  return lines.length;
}

function gatherTable(lines: SourceLine[], from: number) {
  let depth = 0;
  let index = from;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > from && depth === 0 && !lineLooksLikeTable(line)) break;
    depth = Math.max(0, depth + curlyDelta(line.content));
  }
  return index;
}

function gatherList(lines: SourceLine[], from: number) {
  let index = from;
  while (index < lines.length && lineLooksLikeList(lines[index])) index += 1;
  return index;
}

function gatherParagraph(lines: SourceLine[], from: number) {
  let index = from;
  let depth = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (index > from && depth === 0 && (!line.content.trim() || lineStartsStructuralBlock(line))) break;
    depth = Math.max(0, depth + curlyDelta(line.content));
  }
  return index;
}

function blockEnd(lines: SourceLine[], endExclusive: number) {
  return endExclusive > 0 ? lines[endExclusive - 1].end : 0;
}

function parseStandaloneTemplate(source: string, start: number, end: number): NamuAstTemplate {
  const raw = source.slice(start, end);
  const trimmed = raw.trim();
  const inner = trimmed.replace(/^\[include\(/i, "").replace(/\)\]$/, "");
  const parts = inner.split(",");
  const name = (parts.shift() || "").trim();
  return {
    ...baseNode(source, "template", start, end),
    type: "template",
    name,
    args: parts.map((part) => part.trim()),
  };
}

function parseStandaloneMedia(source: string, start: number, end: number): NamuAstMedia {
  const raw = source.slice(start, end).trim();
  const file = raw.match(/^\[\[((?:파일|File):[^\]|]+)(?:\|[^\]]*)?\]\]/i);
  if (file) {
    return { ...baseNode(source, "media", start, end), type: "media", mediaKind: "file", target: file[1].trim() };
  }
  const youtube = raw.match(/^\[youtube\(([^),]+).*\)\]/i);
  if (youtube) {
    return { ...baseNode(source, "media", start, end), type: "media", mediaKind: "youtube", target: youtube[1].trim() };
  }
  return { ...baseNode(source, "media", start, end), type: "media", mediaKind: "other", target: raw };
}

function parseListBlock(source: string, lines: SourceLine[], from: number, to: number): NamuAstList {
  const start = lines[from].start;
  const end = blockEnd(lines, to);
  const parsedLines: NamuAstList["lines"] = [];
  for (let index = from; index < to; index += 1) {
    const match = lines[index].content.match(LIST_RE);
    if (!match) continue;
    const contentOffset = lines[index].content.indexOf(match[3]);
    const contentStart = lines[index].start + contentOffset;
    parsedLines.push({
      sourceStart: lines[index].start,
      sourceEnd: lines[index].end,
      marker: match[2],
      indent: match[1].length,
      children: parseNamuInline(source, contentStart, lines[index].contentEnd),
    });
  }
  return { ...baseNode(source, "list", start, end), type: "list", lines: parsedLines };
}

function parseHeadingBlock(source: string, line: SourceLine): NamuAstHeading {
  const match = line.content.match(HEADING_RE)!;
  const marks = match[1];
  const content = match[2];
  let contentOffset = line.content.indexOf(content, marks.length);
  if (contentOffset < 0) contentOffset = marks.length;
  const contentStart = line.start + contentOffset;
  const contentEnd = contentStart + content.length;
  return {
    ...baseNode(source, "heading", line.start, line.end),
    type: "heading",
    level: marks.length,
    contentStart,
    contentEnd,
    children: parseNamuInline(source, contentStart, contentEnd),
  };
}

function countTableRows(raw: string) {
  return raw.split(/\r?\n/).filter((line) => /^\s*\|\|/.test(line)).length;
}

export function parseNamuMarkAst(source: string): NamuAstDocument {
  const lines = sourceLines(source);
  const blocks: NamuAstBlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.content.trim()) {
      const from = index;
      while (index < lines.length && !lines[index].content.trim()) index += 1;
      const start = lines[from].start;
      const end = blockEnd(lines, index);
      blocks.push({ ...baseNode(source, "whitespace", start, end), type: "whitespace" });
      continue;
    }

    const heading = line.content.match(HEADING_RE);
    if (heading) {
      blocks.push(parseHeadingBlock(source, line));
      index += 1;
      continue;
    }

    if (lineLooksLikeTable(line)) {
      const to = gatherTable(lines, index);
      const start = line.start;
      const end = blockEnd(lines, to);
      const raw = source.slice(start, end);
      blocks.push({
        ...baseNode(source, "table", start, end),
        type: "table",
        rowCount: countTableRows(raw),
        editingMode: "structured-bridge",
      });
      index = to;
      continue;
    }

    if (lineLooksLikeList(line)) {
      const to = gatherList(lines, index);
      blocks.push(parseListBlock(source, lines, index, to));
      index = to;
      continue;
    }

    if (lineLooksLikeStandaloneTemplate(line)) {
      blocks.push(parseStandaloneTemplate(source, line.start, line.end));
      index += 1;
      continue;
    }

    if (lineLooksLikeStandaloneMedia(line)) {
      blocks.push(parseStandaloneMedia(source, line.start, line.end));
      index += 1;
      continue;
    }

    if (lineLooksLikeDivider(line)) {
      blocks.push({ ...baseNode(source, "divider", line.start, line.end), type: "divider" });
      index += 1;
      continue;
    }

    if (lineStartsStyledBlock(line) || lineStartsRawTripleBlock(line)) {
      const to = gatherTripleBlock(lines, index);
      const start = line.start;
      const end = blockEnd(lines, to);
      if (lineStartsStyledBlock(line)) {
        blocks.push({
          ...baseNode(source, "styled-block", start, end),
          type: "styled-block",
          editingMode: "source-fallback",
        });
      } else {
        blocks.push({
          ...baseNode(source, "raw-block", start, end),
          type: "raw-block",
          reason: "Complex formatted NamuMark block",
          editingMode: "source-fallback",
        });
      }
      index = to;
      continue;
    }

    const to = gatherParagraph(lines, index);
    const start = line.start;
    const end = blockEnd(lines, to);
    blocks.push({
      ...baseNode(source, "paragraph", start, end),
      type: "paragraph",
      children: parseNamuInline(source, start, end),
    });
    index = to;
  }

  let inlineNodeCount = 0;
  let linkCount = 0;
  const visitInline = (nodes: NamuAstInlineNode[]) => {
    for (const node of nodes) {
      inlineNodeCount += 1;
      if (node.type === "link" || node.type === "external-link") linkCount += 1;
      if (node.type === "link" || node.type === "external-link" || node.type === "format") visitInline(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") visitInline(block.children);
    if (block.type === "list") for (const line of block.lines) visitInline(line.children);
  }

  const raw = source;
  return {
    ...baseNode(source, "document", 0, source.length),
    type: "document",
    version: 1,
    raw,
    source,
    blocks,
    stats: {
      blockCount: blocks.length,
      inlineNodeCount,
      headingCount: blocks.filter((block) => block.type === "heading").length,
      linkCount,
      tableCount: blocks.filter((block) => block.type === "table").length,
      templateCount: blocks.filter((block) => block.type === "template").length,
      mediaCount: blocks.filter((block) => block.type === "media").length,
      fallbackBlockCount: blocks.filter((block) => block.type === "styled-block" || block.type === "raw-block").length,
    },
  };
}

export function serializeNamuMarkAstLossless(document: NamuAstDocument) {
  return document.blocks.map((block) => block.raw).join("");
}

export function assertNamuMarkAstLossless(source: string, document = parseNamuMarkAst(source)) {
  const rebuilt = serializeNamuMarkAstLossless(document);
  if (rebuilt !== source) {
    throw new Error(`NamuMark AST round-trip mismatch (${source.length} -> ${rebuilt.length})`);
  }
  return true;
}

export function flattenNamuAst(document: NamuAstDocument) {
  const nodes: Array<NamuAstBlockNode | NamuAstInlineNode> = [];
  const visitInline = (items: NamuAstInlineNode[]) => {
    for (const item of items) {
      nodes.push(item);
      if (item.type === "link" || item.type === "external-link" || item.type === "format") visitInline(item.children);
    }
  };
  for (const block of document.blocks) {
    nodes.push(block);
    if (block.type === "heading" || block.type === "paragraph") visitInline(block.children);
    if (block.type === "list") for (const line of block.lines) visitInline(line.children);
  }
  return nodes;
}

export function findNamuAstNode(document: NamuAstDocument, id: string) {
  if (document.id === id) return document;
  return flattenNamuAst(document).find((node) => node.id === id) || null;
}
