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

function normalize(value: string) { return value.replace(/\r\n?/g, "\n"); }

function stripInlineMarkup(value: string) {
  return value
    .replace(/\[br\]/gi, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, _target: string, label: string) => label)
    .replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => target)
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, (_match, label: string) => label)
    .replace(/\[https?:\/\/[^\]]+\]/g, "")
    .replace(/'''|''|~~|\^\^|__/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function lineOffsets(lines: string[]) {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) { offsets.push(cursor); cursor += line.length + 1; }
  return offsets;
}

function completeRowCells(line: string, lineStart: number): CellSpan[] | null {
  const first = line.indexOf("||");
  if (first < 0 || line.slice(0, first).trim()) return null;
  const positions: number[] = [];
  let cursor = first;
  while (cursor >= 0 && cursor < line.length) {
    positions.push(cursor);
    cursor = line.indexOf("||", cursor + 2);
  }
  if (positions.length < 2) return null;
  const last = positions[positions.length - 1];
  if (line.slice(last + 2).trim()) return null;
  const cells: CellSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] + 2;
    const end = positions[index + 1];
    cells.push({ text: line.slice(start, end), start: lineStart + start, end: lineStart + end });
  }
  return cells;
}

function contentSpan(cell: CellSpan) {
  const optionMatch = cell.text.match(/^(\s*(?:<[^>\n]*>\s*)+)/);
  const optionPrefix = optionMatch?.[1] || "";
  const afterOptions = cell.text.slice(optionPrefix.length);
  const leading = afterOptions.match(/^\s*/)?.[0] || "";
  const trailing = afterOptions.match(/\s*$/)?.[0] || "";
  let start = cell.start + optionPrefix.length + leading.length;
  let end = cell.end - trailing.length;
  let value = cell.text.slice(optionPrefix.length + leading.length, cell.text.length - trailing.length);

  for (let depth = 0; depth < 6; depth += 1) {
    const linked = value.match(/^\[\[([^\]|]+)\|([\s\S]+)\]\]$/);
    if (linked) {
      const inner = linked[2];
      const innerIndex = value.indexOf(inner);
      start += innerIndex; end = start + inner.length; value = inner; continue;
    }
    const styled = value.match(/^\{\{\{(?:[+-]\d+|#[^\s{}]+)\s+([\s\S]*?)\}\}\}$/);
    if (styled) {
      const inner = styled[1];
      const innerIndex = value.indexOf(inner);
      start += innerIndex; end = start + inner.length; value = inner; continue;
    }
    break;
  }
  return { value, start, end };
}

function unsafeCellReason(value: string) {
  const text = value.trim();
  if (!text) return "Empty cell";
  if (text.includes("\n")) return "Multi-line cell";
  if (/\|\|/.test(text)) return "Nested table";
  if (/\{\{\{|\}\}\}/.test(text)) return "Structured formatting";
  if (/\[include\(/i.test(text)) return "Template include";
  if (/\[youtube\(/i.test(text)) return "Embedded media";
  if (/\[\[(?:파일|File|분류|Category):/i.test(text)) return "File or metadata cell";
  if (/\[(?:age|dday)\(/i.test(text)) return "Dynamic macro";
  if (/\[(?:목차|각주|clearfix)\]/i.test(text)) return "Document macro";
  if (/^\s*={2,6}.*={2,6}\s*$/.test(text)) return "Heading syntax";
  if (/^(?:width|height)=/i.test(text)) return "Media sizing option";
  return null;
}

function validateProposedCell(value: string) {
  const normalized = normalize(value).trim();
  const reason = unsafeCellReason(normalized);
  if (reason) throw new Error(`Table cell contains unsupported wiki syntax (${reason})`);
  if (normalized.length > 4000) throw new Error("Table cell is too long");
  return normalized;
}

function parseTableBlock(section: EasyEditSection, block: EasyEditBlock): ParsedTableModel | null {
  const originalWikitext = normalize(block.originalWikitext);
  if (!originalWikitext.includes("||")) return null;
  const lines = originalWikitext.split("\n");
  const offsets = lineOffsets(lines);
  const fields: ParsedTableField[] = [];
  let lockedCount = 0;
  let rowNumber = 0;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const cells = completeRowCells(lines[lineIndex], offsets[lineIndex]);
    if (!cells) continue;
    rowNumber += 1;
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const span = contentSpan(cells[cellIndex]);
      const reason = unsafeCellReason(span.value);
      if (reason) { lockedCount += 1; continue; }
      const plainText = stripInlineMarkup(span.value);
      if (!plainText) { lockedCount += 1; continue; }
      fields.push({
        key: `${block.key}:${rowNumber}:${cellIndex + 1}:${span.start}`,
        row: rowNumber,
        column: cellIndex + 1,
        label: `Row ${rowNumber} · Column ${cellIndex + 1}`,
        valueWikitext: span.value,
        plainText,
        replaceStart: span.start,
        replaceEnd: span.end,
      });
    }
  }

  if (!fields.length) return null;
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
    if (!field) throw new Error("A table cell no longer exists");
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
