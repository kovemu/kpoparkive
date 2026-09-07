export type NamuInline =
  | { type: "text"; text: string }
  | { type: "link"; target: string; label: string }
  | { type: "image"; file: string; width?: string; height?: string }
  | { type: "footnote"; id?: string; children: NamuInline[] };

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

export type NamuDirectiveKind = "wiki" | "if" | "style" | "folding" | "html" | "unknown";

export type NamuRawNode =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; children: NamuInline[] }
  | { type: "tab"; label: string }
  | { type: "table"; rows: NamuRawCell[][] }
  | { type: "directive"; kind: NamuDirectiveKind; args: string; title?: string; children: NamuRawNode[]; source: string }
  | { type: "list"; ordered: boolean; items: Array<{ depth: number; children: NamuInline[] }> }
  | { type: "quote"; children: NamuRawNode[] }
  | { type: "raw-control"; source: string };

function decodeBasic(value: string) {
  return value
    // namu.moe exposes source code with escaped line breaks inside <pre><code>.
    // Decode them before any structural parsing so wiki/table blocks stay multiline.
    .replace(/\\n/g, "\n")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#123;/gi, "{")
    .replace(/&#125;/gi, "}")
    .replace(/&#8203;|&#x200b;/gi, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function stripFormatting(value: string) {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\[br\]/gi, "\n")
    .replace(/\{\{\{#!html\b[\s\S]*?\}\}\}/gi, "")
    .replace(/'''([\s\S]*?)'''/g, "$1")
    .replace(/''([\s\S]*?)''/g, "$1")
    .replace(/\{\{\{[+-]?\d+\s*/g, "")
    .replace(/\{\{\{#!(?:wiki|if|style|folding)\b[^\n]*\n?/gi, "")
    .replace(/\}\}\}/g, "")
    .replace(/#!(?:wiki|if|style|html|folding)\b[^\n]*/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/^\s+|\s+$/g, "");
}

function syntaxBalance(value: string) {
  let square = 0;
  let curly = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value.slice(i, i + 2) === "[[") { square += 1; i += 1; continue; }
    if (value.slice(i, i + 2) === "]]" && square > 0) { square -= 1; i += 1; continue; }
    if (value.slice(i, i + 3) === "{{{") { curly += 1; i += 2; continue; }
    if (value.slice(i, i + 3) === "}}}" && curly > 0) { curly -= 1; i += 2; continue; }
  }
  return { square, curly, open: square > 0 || curly > 0 };
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

function splitTopLevelTableDelimiters(value: string) {
  const parts: string[] = [];
  let start = 0;
  let square = 0;
  let curly = 0;
  for (let i = 0; i < value.length - 1; i += 1) {
    const pair = value.slice(i, i + 2);
    const triple = value.slice(i, i + 3);
    if (pair === "[[") { square += 1; i += 1; continue; }
    if (pair === "]]" && square > 0) { square -= 1; i += 1; continue; }
    if (triple === "{{{") { curly += 1; i += 2; continue; }
    if (triple === "}}}" && curly > 0) { curly -= 1; i += 2; continue; }
    if (pair === "||" && square === 0 && curly === 0) {
      parts.push(value.slice(start, i));
      start = i + 2;
      i += 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
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

function findFootnoteEnd(value: string, start: number) {
  let linkDepth = 0;
  for (let cursor = start + 2; cursor < value.length; cursor += 1) {
    if (value.slice(cursor, cursor + 2) === "[[") { linkDepth += 1; cursor += 1; continue; }
    if (value.slice(cursor, cursor + 2) === "]]" && linkDepth > 0) { linkDepth -= 1; cursor += 1; continue; }
    if (value[cursor] === "]" && linkDepth === 0) return cursor;
  }
  return -1;
}

function footnoteFromInner(inner: string): Extract<NamuInline, { type: "footnote" }> | null {
  if (!inner) return null;
  if (/^\s/.test(inner)) {
    const body = inner.trim();
    return body ? { type: "footnote", children: parseNamuInline(body) } : null;
  }
  const named = inner.match(/^([^\s]+)\s+([\s\S]+)$/);
  if (named) return { type: "footnote", id: named[1], children: parseNamuInline(named[2]) };
  return { type: "footnote", children: parseNamuInline(inner.trim()) };
}

export function parseNamuInline(source: string): NamuInline[] {
  const value = decodeBasic(source);
  const output: NamuInline[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const linkStart = value.indexOf("[[", cursor);
    const footnoteStart = value.indexOf("[*", cursor);
    const starts = [linkStart, footnoteStart].filter((position) => position >= 0);
    const start = starts.length ? Math.min(...starts) : -1;

    if (start < 0) {
      const text = stripFormatting(value.slice(cursor));
      if (text) output.push({ type: "text", text });
      break;
    }

    const before = stripFormatting(value.slice(cursor, start));
    if (before) output.push({ type: "text", text: before });

    if (start === footnoteStart) {
      const end = findFootnoteEnd(value, start);
      if (end < 0) {
        const text = stripFormatting(value.slice(start));
        if (text) output.push({ type: "text", text });
        break;
      }
      const footnote = footnoteFromInner(value.slice(start + 2, end));
      if (footnote) output.push(footnote);
      cursor = end + 1;
      continue;
    }

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
      const nested = parseNamuInline(labelSource);
      if (nested.some((node) => node.type === "image")) output.push(...nested);
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
    if (width) meta.width = /^\d+(?:\.\d+)?$/.test(width.trim()) ? `${width.trim()}px` : width.trim();
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

function makeCell(source: string): NamuRawCell {
  const { rest, meta } = parseCellDirectives(source);
  return { ...meta, children: parseNamuInline(rest) };
}

/**
 * Namu tables are logical streams, not physical lines. A cell may contain
 * multiline [[links]] / {{{wiki blocks}}}, and a bare `||` closes the row.
 * This parser keeps a pending cell until its nested syntax closes, then treats
 * the next top-level `||` as a new cell. This is what album grids depend on.
 */
function parseTableChunk(lines: string[]) {
  const rows: NamuRawCell[][] = [];
  let row: NamuRawCell[] = [];
  let pending = "";

  const pushPending = () => {
    if (!pending.trim()) { pending = ""; return; }
    row.push(makeCell(pending));
    pending = "";
  };
  const pushRow = () => {
    pushPending();
    if (row.some((cell) => cell.children.length || cell.background || cell.rowspan || cell.colspan)) rows.push(row);
    row = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    if (pending && syntaxBalance(pending).open) {
      pending += `\n${line}`;
      continue;
    }

    if (trimmed === "||") {
      pushRow();
      continue;
    }

    if (trimmed.startsWith("||")) {
      pushPending();
      const body = trimmed.slice(2);
      const parts = splitTopLevelTableDelimiters(body);
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        if (isLast) {
          if (part) pending = part;
          else if (parts.length > 1) pushRow();
        } else {
          if (part) row.push(makeCell(part));
        }
      }
      continue;
    }

    if (pending) pending += `\n${line}`;
  }

  if (pending || row.length) pushRow();
  return rows;
}

function meaningfulParagraph(source: string) {
  const text = stripFormatting(source);
  return text && !/^#!(?:wiki|if|style|html|folding)\b/i.test(text);
}

function tabLabel(source: string) {
  const text = stripFormatting(source).trim();
  const match = text.match(/^\[\s*([^\[\]\n]{1,80}?)\s*\]$/);
  return match?.[1]?.trim() || null;
}

function isStructuralStart(line: string) {
  const trimmed = line.trimStart();
  return trimmed.startsWith("||")
    || /^={2,6}\s/.test(trimmed)
    || /^#{2,6}\s/.test(trimmed)
    || /^#!/.test(trimmed)
    || /^\{\{\{#!/.test(trimmed)
    || /^\s*(?:\*|\d+\.|[a-zA-Z]\.)\s+/.test(line)
    || /^\s*>/.test(line);
}

function directiveKind(value: string): NamuDirectiveKind {
  const kind = value.toLowerCase();
  if (kind === "wiki" || kind === "if" || kind === "style" || kind === "folding" || kind === "html") return kind;
  return "unknown";
}

function parseDirectiveMacro(source: string): Extract<NamuRawNode, { type: "directive" }> | null {
  const normalized = source.trim();
  const header = normalized.match(/^\{\{\{#!([a-z]+)\b([^\n]*)/i);
  if (!header) return null;
  const kind = directiveKind(header[1]);
  const args = header[2].trim();
  const firstBreak = normalized.indexOf("\n");
  let body = firstBreak >= 0 ? normalized.slice(firstBreak + 1) : "";
  if (body.endsWith("}}}")) body = body.slice(0, -3);
  const title = kind === "folding" ? stripFormatting(args) : undefined;
  return {
    type: "directive",
    kind,
    args,
    title,
    children: body.trim() && kind !== "html" ? parseNamuRaw(body) : [],
    source: normalized,
  };
}

function bareDirective(line: string): Extract<NamuRawNode, { type: "directive" }> | null {
  const match = line.trim().match(/^#!([a-z]+)\b(.*)$/i);
  if (!match) return null;
  const kind = directiveKind(match[1]);
  const args = match[2].trim();
  return {
    type: "directive",
    kind,
    args,
    title: kind === "folding" ? stripFormatting(args) : undefined,
    children: [],
    source: line.trim(),
  };
}

function listLine(line: string) {
  const match = line.match(/^(\s+)(\*|\d+\.|[a-zA-Z]\.)\s+([\s\S]+)$/);
  if (!match) return null;
  const indent = match[1].replace(/\t/g, "  ").length;
  return {
    ordered: match[2] !== "*",
    depth: Math.min(8, Math.max(0, indent - 1)),
    content: match[3],
  };
}

export function parseNamuRaw(source: string): NamuRawNode[] {
  const lines = decodeBasic(source).replace(/\r\n?/g, "\n").split("\n");
  const nodes: NamuRawNode[] = [];
  let paragraph: string[] = [];
  let table: string[] = [];
  let tableOpen = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const joined = paragraph.join("\n").trim();
    const tab = tabLabel(joined);
    if (tab) {
      nodes.push({ type: "tab", label: tab });
    } else if (meaningfulParagraph(joined)) {
      const children = parseNamuInline(joined);
      if (children.length) nodes.push({ type: "paragraph", children });
    }
    paragraph = [];
  };
  const flushTable = () => {
    if (!table.length) return;
    const rows = parseTableChunk(table);
    if (rows.length) nodes.push({ type: "table", rows });
    table = [];
    tableOpen = false;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trimEnd();
    const trimmed = line.trimStart();

    if (table.length) {
      if (trimmed.startsWith("||") || tableOpen) {
        table.push(line);
        const joined = table.join("\n");
        tableOpen = syntaxBalance(joined).open;
        continue;
      }
      flushTable();
    }

    const macroStart = trimmed.match(/^\{\{\{#!([a-z]+)\b/i);
    if (macroStart) {
      flushParagraph();
      const macroLines = [line];
      let balance = syntaxBalance(line);
      let cursor = index;
      while (balance.open && cursor + 1 < lines.length) {
        cursor += 1;
        macroLines.push(lines[cursor].trimEnd());
        balance = syntaxBalance(macroLines.join("\n"));
      }
      if (!balance.open) {
        const directive = parseDirectiveMacro(macroLines.join("\n"));
        if (directive) nodes.push(directive);
        else nodes.push({ type: "raw-control", source: macroLines.join("\n") });
        index = cursor;
      } else {
        const directive = bareDirective(trimmed.replace(/^\{\{\{/, ""));
        if (directive) nodes.push(directive);
        else nodes.push({ type: "raw-control", source: line.trim() });
      }
      continue;
    }

    if (trimmed.startsWith("||")) {
      flushParagraph();
      table = [line];
      tableOpen = syntaxBalance(line).open;
      continue;
    }

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

    const directive = bareDirective(line);
    if (directive) {
      flushParagraph();
      nodes.push(directive);
      continue;
    }

    const list = listLine(line);
    if (list) {
      flushParagraph();
      const items: Array<{ depth: number; children: NamuInline[] }> = [];
      const ordered = list.ordered;
      let cursor = index;
      while (cursor < lines.length) {
        const item = listLine(lines[cursor]);
        if (!item || item.ordered !== ordered) break;
        items.push({ depth: item.depth, children: parseNamuInline(item.content) });
        cursor += 1;
      }
      if (items.length) nodes.push({ type: "list", ordered, items });
      index = cursor - 1;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quoteLines: string[] = [];
      let cursor = index;
      while (cursor < lines.length && /^\s*>/.test(lines[cursor])) {
        quoteLines.push(lines[cursor].replace(/^\s*>\s?/, ""));
        cursor += 1;
      }
      nodes.push({ type: "quote", children: parseNamuRaw(quoteLines.join("\n")) });
      index = cursor - 1;
      continue;
    }

    if (/^\s*\/\*/.test(line)) {
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
