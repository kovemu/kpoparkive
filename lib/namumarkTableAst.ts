export type NamuTableEditableField = {
  id: string;
  row: number;
  cell: number;
  fragment: number;
  sourceStart: number;
  sourceEnd: number;
  valueWikitext: string;
  plainText: string;
};

export type NamuTableCell = {
  id: string;
  row: number;
  cell: number;
  sourceStart: number;
  sourceEnd: number;
  raw: string;
  optionsRaw: string;
  locked: boolean;
  lockedReason: string | null;
  fields: NamuTableEditableField[];
};

export type NamuTableRow = {
  id: string;
  row: number;
  sourceStart: number;
  sourceEnd: number;
  raw: string;
  cells: NamuTableCell[];
};

export type NamuTableAst = {
  version: 1;
  rowCount: number;
  cellCount: number;
  editableFieldCount: number;
  lockedCellCount: number;
  rows: NamuTableRow[];
};

type RowSpan = { text: string; start: number; end: number };
type CellSpan = { text: string; start: number; end: number };
type EditableSpan = { value: string; start: number; end: number };

function tinyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function id(kind: string, start: number, end: number, raw: string) {
  return `nmt:${kind}:${start}:${end}:${tinyHash(raw)}`;
}

function normalize(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function lineOffsets(lines: string[]) {
  const offsets: number[] = [];
  let cursor = 0;
  for (let index = 0; index < lines.length; index += 1) {
    offsets.push(cursor);
    cursor += lines[index].length;
    if (index < lines.length - 1) cursor += 1;
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
  const normalized = normalize(source);
  const lines = normalized.split("\n");
  const offsets = lineOffsets(lines);
  const rows: RowSpan[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const first = line.indexOf("||");
    if (first < 0 || line.slice(0, first).trim()) continue;

    let text = line.slice(first);
    let curlyDepth = countToken(text, "{{{") - countToken(text, "}}}");
    let squareDepth = countToken(text, "[[") - countToken(text, "]]");
    let endIndex = lineIndex;

    while ((curlyDepth > 0 || squareDepth > 0 || !text.trimEnd().endsWith("||")) && endIndex + 1 < lines.length) {
      endIndex += 1;
      const next = lines[endIndex];
      text += `\n${next}`;
      curlyDepth += countToken(next, "{{{") - countToken(next, "}}}");
      squareDepth += countToken(next, "[[") - countToken(next, "]]");
      if (text.length > 200_000) break;
    }

    if (!text.trimEnd().endsWith("||")) continue;
    const start = offsets[lineIndex] + first;
    const end = start + text.length;
    rows.push({ text, start, end });
    lineIndex = endIndex;
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
    if (triple === "}}}" && curlyDepth > 0) { curlyDepth -= 1; index += 2; continue; }
    if (pair === "[[") { squareDepth += 1; index += 1; continue; }
    if (pair === "]]" && squareDepth > 0) { squareDepth -= 1; index += 1; continue; }
    if (pair === "||" && curlyDepth === 0 && squareDepth === 0) {
      positions.push(index);
      index += 1;
    }
  }

  if (positions.length < 2) return null;
  const last = positions[positions.length - 1];
  if (row.text.slice(last + 2).trim()) return null;

  const cells: CellSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const localStart = positions[index] + 2;
    const localEnd = positions[index + 1];
    cells.push({
      text: row.text.slice(localStart, localEnd),
      start: row.start + localStart,
      end: row.start + localEnd,
    });
  }
  return cells;
}

function cellPresentationPrefix(cell: CellSpan) {
  const match = cell.text.match(/^(\s*(?:<[^>\n]*>\s*)+)/);
  return match?.[1] || "";
}

function baseContentSpan(cell: CellSpan): EditableSpan {
  const prefix = cellPresentationPrefix(cell);
  const after = cell.text.slice(prefix.length);
  const leading = after.match(/^\s*/)?.[0] || "";
  const trailing = after.match(/\s*$/)?.[0] || "";
  const start = cell.start + prefix.length + leading.length;
  const end = cell.end - trailing.length;
  return {
    value: cell.text.slice(prefix.length + leading.length, cell.text.length - trailing.length),
    start,
    end,
  };
}

function peelPresentationWrappers(input: EditableSpan) {
  let { value, start, end } = input;
  for (let depth = 0; depth < 12; depth += 1) {
    const linked = value.match(/^\[\[([^\]|]+)\|([\s\S]+)\]\]$/);
    if (linked) {
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

function unsafeFragmentReason(value: string) {
  const text = value.trim();
  if (!text) return "Empty cell";
  if (/\|\|/.test(text)) return "Nested table";
  if (/\[include\(/i.test(text)) return "Template include";
  if (/\[(?:youtube|kakaotv|nicovideo|vimeo)\(/i.test(text)) return "Embedded media";
  if (/\[\[(?:파일|File|분류|Category):/i.test(text)) return "File or metadata cell";
  if (/^(?:width|height|theme|align|valign|bgcolor|color|dark-style)\s*=/i.test(text)) return "Media or presentation option";
  if (/\[(?:age|dday)\(/i.test(text)) return "Dynamic macro";
  if (/\[(?:목차|각주|clearfix)\]/i.test(text)) return "Document macro";
  if (/^\s*={2,6}.*={2,6}\s*$/m.test(text)) return "Heading syntax";
  if (/\{\{\{|\}\}\}/.test(text)) return "Structured formatting";
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

function keepMostSpecificNonOverlapping(spans: EditableSpan[]) {
  const ordered = [...spans].sort((a, b) => {
    const aLength = a.end - a.start;
    const bLength = b.end - b.start;
    return aLength - bLength || a.start - b.start || a.end - b.end;
  });
  const kept: EditableSpan[] = [];
  for (const span of ordered) {
    if (kept.some((other) => span.start < other.end && span.end > other.start)) continue;
    kept.push(span);
  }
  return kept.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function parseNamuTableAst(tableRaw: string): NamuTableAst {
  const source = normalize(tableRaw);
  const rows: NamuTableRow[] = [];
  let cellCount = 0;
  let editableFieldCount = 0;
  let lockedCellCount = 0;

  for (const [rowIndex, rowSpan] of logicalRows(source).entries()) {
    const cellSpans = splitRowCells(rowSpan);
    if (!cellSpans) continue;
    const cells: NamuTableCell[] = [];

    for (const [cellIndex, cellSpan] of cellSpans.entries()) {
      cellCount += 1;
      const spans = keepMostSpecificNonOverlapping(editableSpansInCell(cellSpan));
      const fields: NamuTableEditableField[] = spans
        .map((span, fragmentIndex) => {
          const plainText = stripInlineMarkup(span.value);
          if (!plainText) return null;
          editableFieldCount += 1;
          return {
            id: id("field", span.start, span.end, span.value),
            row: rowIndex + 1,
            cell: cellIndex + 1,
            fragment: fragmentIndex + 1,
            sourceStart: span.start,
            sourceEnd: span.end,
            valueWikitext: span.value,
            plainText,
          } satisfies NamuTableEditableField;
        })
        .filter((field): field is NamuTableEditableField => Boolean(field));

      const base = peelPresentationWrappers(baseContentSpan(cellSpan));
      const reason = fields.length ? null : unsafeFragmentReason(base.value) || "No safe editable text";
      if (!fields.length) lockedCellCount += 1;
      cells.push({
        id: id("cell", cellSpan.start, cellSpan.end, cellSpan.text),
        row: rowIndex + 1,
        cell: cellIndex + 1,
        sourceStart: cellSpan.start,
        sourceEnd: cellSpan.end,
        raw: cellSpan.text,
        optionsRaw: cellPresentationPrefix(cellSpan).trim(),
        locked: !fields.length,
        lockedReason: reason,
        fields,
      });
    }

    rows.push({
      id: id("row", rowSpan.start, rowSpan.end, rowSpan.text),
      row: rowIndex + 1,
      sourceStart: rowSpan.start,
      sourceEnd: rowSpan.end,
      raw: rowSpan.text,
      cells,
    });
  }

  return {
    version: 1,
    rowCount: rows.length,
    cellCount,
    editableFieldCount,
    lockedCellCount,
    rows,
  };
}

function validateCellReplacement(value: string) {
  const proposed = normalize(value).trim();
  const reason = unsafeFragmentReason(proposed);
  if (reason) throw new Error(`Table field contains unsupported NamuMark (${reason})`);
  return proposed;
}

export function applyNamuTableFieldChanges(
  tableRaw: string,
  changes: Array<{ fieldId: string; proposedWikitext: string }>,
) {
  const source = normalize(tableRaw);
  const model = parseNamuTableAst(source);
  const fields = new Map(model.rows.flatMap((row) => row.cells.flatMap((cell) => cell.fields)).map((field) => [field.id, field]));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const changed: Array<{ fieldId: string; row: number; cell: number; before: string; after: string }> = [];

  for (const change of changes) {
    const field = fields.get(change.fieldId);
    if (!field) throw new Error("Table field no longer exists. Reload and try again.");
    const value = validateCellReplacement(change.proposedWikitext);
    if (value === field.valueWikitext.trim()) continue;
    replacements.push({ start: field.sourceStart, end: field.sourceEnd, value });
    changed.push({ fieldId: field.id, row: field.row, cell: field.cell, before: field.valueWikitext, after: value });
  }

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let proposed = source;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error("Overlapping table field edits are not supported");
    proposed = `${proposed.slice(0, replacement.start)}${replacement.value}${proposed.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  return { model, proposed, changed };
}
