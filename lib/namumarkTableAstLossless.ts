import {
  applyNamuTableFieldChanges as applyNormalizedNamuTableFieldChanges,
  parseNamuTableAst as parseNormalizedNamuTableAst,
  type NamuTableAst,
} from "./namumarkTableAst";

export type {
  NamuTableAst,
  NamuTableCell,
  NamuTableEditableField,
  NamuTableRow,
} from "./namumarkTableAst";

type EolMap = {
  source: string;
  normalized: string;
  boundaryToSource: number[];
};

function normalizeEolWithBoundaryMap(value: string): EolMap {
  const source = String(value ?? "");
  let normalized = "";
  const boundaryToSource = [0];
  let sourceIndex = 0;

  while (sourceIndex < source.length) {
    const char = source[sourceIndex];
    if (char === "\r") {
      if (source[sourceIndex + 1] === "\n") sourceIndex += 2;
      else sourceIndex += 1;
      normalized += "\n";
      boundaryToSource.push(sourceIndex);
      continue;
    }
    normalized += char;
    sourceIndex += 1;
    boundaryToSource.push(sourceIndex);
  }

  return { source, normalized, boundaryToSource };
}

function sourceBoundary(map: EolMap, normalizedOffset: number) {
  if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0 || normalizedOffset >= map.boundaryToSource.length) {
    throw new Error("Table AST produced an invalid normalized source offset");
  }
  return map.boundaryToSource[normalizedOffset];
}

function sourceRange(map: EolMap, start: number, end: number) {
  const sourceStart = sourceBoundary(map, start);
  const sourceEnd = sourceBoundary(map, end);
  if (sourceEnd < sourceStart) throw new Error("Table AST produced an inverted source range");
  return { sourceStart, sourceEnd };
}

function remapModel(map: EolMap, model: NamuTableAst): NamuTableAst {
  return {
    ...model,
    rows: model.rows.map((row) => {
      const rowRange = sourceRange(map, row.sourceStart, row.sourceEnd);
      return {
        ...row,
        sourceStart: rowRange.sourceStart,
        sourceEnd: rowRange.sourceEnd,
        raw: map.source.slice(rowRange.sourceStart, rowRange.sourceEnd),
        cells: row.cells.map((cell) => {
          const cellRange = sourceRange(map, cell.sourceStart, cell.sourceEnd);
          return {
            ...cell,
            sourceStart: cellRange.sourceStart,
            sourceEnd: cellRange.sourceEnd,
            raw: map.source.slice(cellRange.sourceStart, cellRange.sourceEnd),
            fields: cell.fields.map((field) => {
              const fieldRange = sourceRange(map, field.sourceStart, field.sourceEnd);
              return {
                ...field,
                sourceStart: fieldRange.sourceStart,
                sourceEnd: fieldRange.sourceEnd,
                valueWikitext: map.source.slice(fieldRange.sourceStart, fieldRange.sourceEnd),
              };
            }),
          };
        }),
      };
    }),
  };
}

function preferredEol(value: string) {
  if (value.includes("\r\n")) return "\r\n";
  if (value.includes("\r")) return "\r";
  if (value.includes("\n")) return "\n";
  return null;
}

function preserveFieldEolStyle(value: string, before: string) {
  const normalized = value.replace(/\r\n?/g, "\n");
  const eol = preferredEol(before);
  if (!eol || eol === "\n") return normalized;
  return normalized.replace(/\n/g, eol);
}

/**
 * Parse table fields using the existing conservative table parser while exposing
 * every sourceStart/sourceEnd against the exact, untouched input string.
 *
 * The legacy parser intentionally normalizes CRLF/CR to LF for recognition.
 * This adapter keeps its stable field ids, but maps every normalized boundary
 * back to the original source before anything is exposed to the visual editor.
 */
export function parseNamuTableAstLossless(tableRaw: string): NamuTableAst {
  const map = normalizeEolWithBoundaryMap(tableRaw);
  const model = parseNormalizedNamuTableAst(map.normalized);
  return remapModel(map, model);
}

/**
 * Validate edits through the legacy conservative parser, then patch the exact
 * original table source ranges. Untouched CRLF/CR bytes are never normalized.
 */
export function applyNamuTableFieldChangesLossless(
  tableRaw: string,
  changes: Array<{ fieldId: string; proposedWikitext: string }>,
) {
  const map = normalizeEolWithBoundaryMap(tableRaw);
  const normalizedResult = applyNormalizedNamuTableFieldChanges(map.normalized, changes);
  const model = remapModel(map, normalizedResult.model);
  const fields = new Map(
    model.rows.flatMap((row) => row.cells.flatMap((cell) => cell.fields)).map((field) => [field.id, field]),
  );
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const changed: Array<{ fieldId: string; row: number; cell: number; before: string; after: string }> = [];

  for (const item of normalizedResult.changed) {
    const field = fields.get(item.fieldId);
    if (!field) throw new Error("Table field range disappeared during source offset remapping");
    const after = preserveFieldEolStyle(item.after, field.valueWikitext);
    replacements.push({ start: field.sourceStart, end: field.sourceEnd, value: after });
    changed.push({
      fieldId: item.fieldId,
      row: item.row,
      cell: item.cell,
      before: field.valueWikitext,
      after,
    });
  }

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let proposed = map.source;
  for (const replacement of replacements) {
    if (replacement.start < 0 || replacement.end < replacement.start || replacement.end > map.source.length) {
      throw new Error("Invalid lossless table field source range");
    }
    if (replacement.end > previousStart) throw new Error("Overlapping table field edits are not supported");
    proposed = `${proposed.slice(0, replacement.start)}${replacement.value}${proposed.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  return { model, proposed, changed };
}
