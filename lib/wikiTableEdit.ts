import { findEasyEditBlock, parseEasyEditSections, type EasyEditBlock, type EasyEditSection } from "./wikiEasyEdit";

export type WikiTableField = {
  key: string;
  row: number;
  column: number;
  label: string;
  valueWikitext: string;
  plainText: string;
};

export type WikiTableModel = {
  key: string;
  sectionKey: string;
  sectionHeading: string;
  blockKey: string;
  blockIndex: number;
  editableCount: number;
  lockedCount: number;
  fields: WikiTableField[];
};

type ParsedTableField = WikiTableField & {
  replaceStart: number;
  replaceEnd: number;
};

type ParsedTableModel = Omit<WikiTableModel, "fields"> & {
  originalWikitext: string;
  fields: ParsedTableField[];
};

type CellSpan = { text: string; start: number; end: number };
type RowSpan = { text: string; start: number };
type EditableSpan = { value: string; start: number; end: number };

function normalize(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function removeBalancedFootnotes(value: string) {
  let out = "";
  let index = 0;
  while (index < value.length) {
    if (!value.startsWith("[*", index)) {
      out += value[index++];
      continue;
    }
    let depth = 0;
    let cursor = index;
    for (; cursor < value.length; cursor += 1) {
      if (value[cursor] === "[") depth += 1;
      else if (value[cursor] === "]") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) {
      out += value[index++];
      continue;
    }
    index = cursor + 1;
  }
  return out;
}

function stripInlineMarkup(value: string) {
  return removeBalancedFootnotes(value)
    .replace(/\[br\]/gi, "\n")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, _target: string, label: string) => label)
    .replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => target)
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, (_match, label: string) => label)
    .replace(/\[https?:\/\/[^\]]+\]/g, "")
    .replace(/'''|''|__|~~|\^\^/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function lineOffsets(lines: string[]) {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  return offsets;
}

function countToken(value: string, token: string) {
  let count = 0;
  let cursor = 0;
  while ((cursor = value.indexOf(token, cursor)) >= 0) {
    count += 1;
    cursor += token.length;
  }
  return count;
}

function logicalRows(source: string): RowSpan[] {
  const lines = source.split("\n");
  const offsets = lineOffsets(lines);
  const rows: RowSpan[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const first = line.indexOf("||");
    if (first < 0 || line.slice(0, first).trim()) continue;

    let text = line.slice(first);
    let curlyDepth = countToken(text, "{{{") - countToken(text, "}}}");
    let endIndex = lineIndex;
    while ((curlyDepth > 0 || !text.trimEnd().endsWith("||")) && endIndex + 1 < lines.length) {
      endIndex += 1;
      const next = lines[endIndex];
      text += `\n${next}`;
      curlyDepth += countToken(next, "{{{") - countToken(next, "}}}");
      if (text.length > 120_000) break;
    }
    if (text.trimEnd().endsWith("||")) rows.push({ text, start: offsets[lineIndex] + first });
  }
  return rows;
}

function splitRowCells(row: RowSpan): CellSpan[] | null {
  const positions: number[] = [];
  let curlyDepth = 0;
  let squareDepth = 0;
  for (let index = 0; index < row.text.length - 1; index += 1) {
    const pair = row.text.slice(index, index + 2);
    const triple = row.text.slice(index, index + 3);
    if (triple === "{{{") { curlyDepth += 1; index += 2; continue; }
    if (triple === "}}}") { curlyDepth = Math.max(0, curlyDepth - 1); index += 2; continue; }
    if (pair === "[[") { squareDepth += 1; index += 1; continue; }
    if (pair === "]]" && squareDepth > 0) { squareDepth -= 1; index += 1; continue; }
    if (pair === "||" && curlyDepth === 0 && squareDepth === 0) { positions.push(index); index += 1; }
  }
  if (positions.length < 2) return null;
  const last = positions[positions.length - 1];
  if (row.text.slice(last + 2).trim()) return null;
  const cells: CellSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] + 2;
    const end = positions[index + 1];
    cells.push({ text: row.text.slice(start, end), start: row.start + start, end: row.start + end });
  }
  return cells;
}

function baseContentSpan(cell: CellSpan): EditableSpan {
  const optionMatch = cell.text.match(/^(\s*(?:<[^>\n]*>\s*)+)/);
  const optionPrefix = optionMatch?.[1] || "";
  const afterOptions = cell.text.slice(optionPrefix.length);
  const leading = afterOptions.match(/^\s*/)?.[0] || "";
  const trailing = afterOptions.match(/\s*$/)?.[0] || "";
  const start = cell.start + optionPrefix.length + leading.length;
  const end = cell.end - trailing.length;
  return {
    value: cell.text.slice(optionPrefix.length + leading.length, cell.text.length - trailing.length),
    start,
    end,
  };
}

function peelPresentationWrappers(input: EditableSpan) {
  let { value, start, end } = input;
  for (let depth = 0; depth < 10; depth += 1) {
    const linked = value.match(/^\[\[([^\]|]+)\|([\s\S]+)\]\]$/);
    if (linked) {
      // File/category links are structure, not visible text. Never expose width=100%, height=30, etc.
      if (/^(?:파일|File|분류|Category):/i.test(linked[1].trim())) break;
      const inner = linked[2];
      const innerIndex = value.indexOf(inner);
      start += innerIndex;
      end = start + inner.length;
      value = inner;
      continue;
    }
    const wikiStyle = value.match(/^\{\{\{#!wiki[^\n]*\n([\s\S]*?)\n?\}\}\}$/i);
    if (wikiStyle) {
      const inner = wikiStyle[1];
      const innerIndex = value.indexOf(inner);
      start += innerIndex;
      end = start + inner.length;
      value = inner;
      continue;
    }
    const styled = value.match(/^\{\{\{(?:[+-]\d+|#[^\s{}]+)\s+([\s\S]*?)\}\}\}$/);
    if (styled) {
      const inner = styled[1];
      const innerIndex = value.indexOf(inner);
      start += innerIndex;
      end = start + inner.length;
      value = inner;
      continue;
    }
    break;
  }
  return { value, start, end };
}

function unsafeFragmentReason(value: string) {
  const text = value.trim();
  if (!text) return "Empty cell";
  if (/\|\|/.test(text)) return "Nested table";
  if (/\{\{\{|\}\}\}/.test(text)) return "Structured formatting";
  if (/\[include\(/i.test(text)) return "Template include";
  if (/\[youtube\(/i.test(text)) return "Embedded media";
  if (/\[\[(?:파일|File|분류|Category):/i.test(text)) return "File or metadata cell";
  if (/^(?:width|height|theme|align|valign|bgcolor|color|dark-style)\s*=/i.test(text)) return "Media or presentation option";
  if (/\[(?:age|dday)\(/i.test(text)) return "Dynamic macro";
  if (/\[(?:목차|각주|clearfix)\]/i.test(text)) return "Document macro";
  if (/^\s*={2,6}.*={2,6}\s*$/m.test(text)) return "Heading syntax";
  if (text.length > 30_000) return "Text fragment is too large";
  return null;
}

function formattedInnerSpans(cell: CellSpan): EditableSpan[] {
  const value = cell.text;
  const stack: number[] = [];
  const spans: EditableSpan[] = [];
  for (let index = 0; index < value.length - 2; index += 1) {
    const triple = value.slice(index, index + 3);
    if (triple === "{{{") { stack.push(index); index += 2; continue; }
    if (triple !== "}}}" || !stack.length) continue;
    const open = stack.pop()!;
    const bodyStart = open + 3;
    const body = value.slice(bodyStart, index);
    let content = "";
    let contentStartInBody = -1;
    const wikiStyle = body.match(/^#!wiki[^\n]*\n([\s\S]*)$/i);
    if (wikiStyle) {
      content = wikiStyle[1];
      contentStartInBody = body.indexOf(content);
    } else {
      const styled = body.match(/^(?:[+-]\d+|#[^\s{}]+)\s+([\s\S]*)$/);
      if (styled) {
        content = styled[1];
        contentStartInBody = body.indexOf(content);
      }
    }
    if (contentStartInBody >= 0 && content && !unsafeFragmentReason(content)) {
      const start = cell.start + bodyStart + contentStartInBody;
      spans.push({ value: content, start, end: start + content.length });
    }
    index += 2;
  }
  return spans;
}

function editableSpansInCell(cell: CellSpan) {
  const base = baseContentSpan(cell);
  const peeled = peelPresentationWrappers(base);
  if (!unsafeFragmentReason(peeled.value)) return [peeled];
  return formattedInnerSpans(cell)
    .filter((span) => !unsafeFragmentReason(span.value))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

function validateProposedCell(value: string) {
  const normalized = normalize(value).trim();
  const reason = unsafeFragmentReason(normalized);
  if (reason) throw new Error(`Table text contains unsupported wiki syntax (${reason})`);
  return normalized;
}

function keepMostSpecificNonOverlappingFields(fields: ParsedTableField[]) {
  const bySpecificity = [...fields].sort((a, b) => {
    const aLength = a.replaceEnd - a.replaceStart;
    const bLength = b.replaceEnd - b.replaceStart;
    return aLength - bLength || a.replaceStart - b.replaceStart || a.replaceEnd - b.replaceEnd;
  });
  const kept: ParsedTableField[] = [];
  for (const field of bySpecificity) {
    const overlaps = kept.some((other) => field.replaceStart < other.replaceEnd && field.replaceEnd > other.replaceStart);
    if (!overlaps) kept.push(field);
  }
  return kept.sort((a, b) => a.replaceStart - b.replaceStart || a.replaceEnd - b.replaceEnd);
}

function parseTableBlock(section: EasyEditSection, block: EasyEditBlock): ParsedTableModel | null {
  const originalWikitext = normalize(block.originalWikitext);
  if (!originalWikitext.includes("||")) return null;
  const collected: ParsedTableField[] = [];
  let lockedCount = 0;
  let rowNumber = 0;

  for (const row of logicalRows(originalWikitext)) {
    const cells = splitRowCells(row);
    if (!cells) continue;
    rowNumber += 1;
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const spans = editableSpansInCell(cells[cellIndex]);
      if (!spans.length) { lockedCount += 1; continue; }
      let fragment = 0;
      for (const span of spans) {
        const plainText = stripInlineMarkup(span.value);
        if (!plainText) { lockedCount += 1; continue; }
        fragment += 1;
        collected.push({
          key: `${block.key}:${rowNumber}:${cellIndex + 1}:${span.start}`,
          row: rowNumber,
          column: cellIndex + 1,
          label: `Row ${rowNumber} · Column ${cellIndex + 1}${spans.length > 1 ? ` · Text ${fragment}` : ""}`,
          valueWikitext: span.value,
          plainText,
          replaceStart: span.start,
          replaceEnd: span.end,
        });
      }
    }
  }

  const fields = keepMostSpecificNonOverlappingFields(collected);
  if (!fields.length) return null;
  lockedCount += Math.max(0, collected.length - fields.length);
  return {
    key: `table:${block.key}`,
    sectionKey: section.key,
    sectionHeading: section.heading,
    blockKey: block.key,
    blockIndex: block.blockIndex,
    editableCount: fields.length,
    lockedCount,
    fields,
    originalWikitext,
  };
}

export function parseWikiTables(source: string): WikiTableModel[] {
  const models: WikiTableModel[] = [];
  for (const section of parseEasyEditSections(source)) {
    for (const block of section.blocks) {
      const parsed = parseTableBlock(section, block);
      if (!parsed) continue;
      models.push({
        key: parsed.key,
        sectionKey: parsed.sectionKey,
        sectionHeading: parsed.sectionHeading,
        blockKey: parsed.blockKey,
        blockIndex: parsed.blockIndex,
        editableCount: parsed.editableCount,
        lockedCount: parsed.lockedCount,
        fields: parsed.fields.map(({ replaceStart: _replaceStart, replaceEnd: _replaceEnd, ...field }) => field),
      });
    }
  }
  return models;
}

export function applyWikiTableChanges(source: string, blockKey: string, changes: Array<{ key: string; proposedWikitext: string }>) {
  const found = findEasyEditBlock(source, blockKey);
  if (!found) throw new Error("Table block no longer exists");
  const parsed = parseTableBlock(found.section, found.block);
  if (!parsed) throw new Error("Editable table was not found");
  if (!changes.length) throw new Error("No table changes were supplied");
  const byKey = new Map(parsed.fields.map((field) => [field.key, field]));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const changedCells: Array<{ label: string; original: string; proposed: string }> = [];

  for (const change of changes) {
    const field = byKey.get(change.key);
    if (!field) throw new Error("A table text field no longer exists");
    const proposed = validateProposedCell(change.proposedWikitext);
    if (proposed === field.valueWikitext.trim()) continue;
    replacements.push({ start: field.replaceStart, end: field.replaceEnd, value: proposed });
    changedCells.push({ label: field.label, original: field.valueWikitext, proposed });
  }
  if (!changedCells.length) throw new Error("No changes were made");
  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let proposedTable = parsed.originalWikitext;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error("Overlapping table edits are not supported");
    proposedTable = `${proposedTable.slice(0, replacement.start)}${replacement.value}${proposedTable.slice(replacement.end)}`;
    previousStart = replacement.start;
  }
  return { found, parsed, proposedTable, changedCells };
}
