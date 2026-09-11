import { parseNamuTableAstLossless } from "./namumarkTableAstLossless";

export type NamuTableLayoutAction =
  | { kind: "insert-row"; at: number }
  | { kind: "delete-row"; row: number }
  | { kind: "insert-column"; at: number }
  | { kind: "delete-column"; column: number };

export type NamuTableLayoutModel = {
  editable: boolean;
  lockedReason: string | null;
  rowCount: number;
  columnCount: number;
};

const MAX_ROWS = 100;
const MAX_COLUMNS = 30;

function preferredEol(value: string) {
  if (value.includes("\r\n")) return "\r\n";
  if (value.includes("\r")) return "\r";
  return "\n";
}

function spanOption(value: string) {
  // NamuWiki permits alignment/vertical modifiers around span syntax, e.g.
  // <|2>, <^|2>, <v|3>, <-2>. Any cell option containing these structural
  // forms is excluded from row/column visual restructuring.
  return /<[^>\r\n]*(?:\|\s*\d+|-\s*\d+)[^>\r\n]*>/.test(value);
}

function inspect(tableRaw: string) {
  const source = String(tableRaw ?? "");
  const model = parseNamuTableAstLossless(source);
  if (!model.rows.length) {
    return { source, model, editable: false as const, lockedReason: "No logical rows were parsed", rows: [] as string[][] };
  }

  const width = model.rows[0]?.cells.length || 0;
  if (!width) {
    return { source, model, editable: false as const, lockedReason: "No table cells were parsed", rows: [] as string[][] };
  }
  if (model.rows.some((row) => row.cells.length !== width)) {
    return { source, model, editable: false as const, lockedReason: "Irregular row widths", rows: [] as string[][] };
  }
  if (model.rows.some((row) => /\r|\n/.test(row.raw))) {
    return { source, model, editable: false as const, lockedReason: "Multiline logical rows", rows: [] as string[][] };
  }
  if (model.rows.some((row) => row.cells.some((cell) => spanOption(cell.optionsRaw) || spanOption(cell.raw)))) {
    return { source, model, editable: false as const, lockedReason: "Merged cells (rowspan/colspan)", rows: [] as string[][] };
  }

  for (const row of model.rows) {
    const rebuilt = `||${row.cells.map((cell) => cell.raw).join("||")}||`;
    if (rebuilt !== row.raw) {
      return { source, model, editable: false as const, lockedReason: "Row contains unsupported structural syntax", rows: [] as string[][] };
    }
  }

  const first = model.rows[0];
  const last = model.rows[model.rows.length - 1];
  const prefix = source.slice(0, first.sourceStart);
  const suffix = source.slice(last.sourceEnd);
  if (prefix.trim() || suffix.trim()) {
    return { source, model, editable: false as const, lockedReason: "Table block contains non-table source", rows: [] as string[][] };
  }
  for (let index = 0; index < model.rows.length - 1; index += 1) {
    const gap = source.slice(model.rows[index].sourceEnd, model.rows[index + 1].sourceStart);
    if (!/^(?:\r\n|\r|\n)$/.test(gap)) {
      return { source, model, editable: false as const, lockedReason: "Rows are separated by complex source", rows: [] as string[][] };
    }
  }

  return {
    source,
    model,
    editable: true as const,
    lockedReason: null,
    prefix,
    suffix,
    rows: model.rows.map((row) => row.cells.map((cell) => cell.raw)),
  };
}

export function inspectNamuTableLayout(tableRaw: string): NamuTableLayoutModel {
  const result = inspect(tableRaw);
  return {
    editable: result.editable,
    lockedReason: result.lockedReason,
    rowCount: result.model.rows.length,
    columnCount: result.model.rows[0]?.cells.length || 0,
  };
}

function integer(value: unknown, label: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

export function applyNamuTableLayoutChanges(tableRaw: string, actions: NamuTableLayoutAction[]) {
  const inspected = inspect(tableRaw);
  if (!inspected.editable) throw new Error(`Table layout is protected: ${inspected.lockedReason}`);
  if (!Array.isArray(actions) || !actions.length) throw new Error("No table layout actions were supplied");
  if (actions.length > 100) throw new Error("Too many table layout actions in one edit");

  const rows = inspected.rows.map((row) => [...row]);
  const applied: NamuTableLayoutAction[] = [];

  for (const action of actions) {
    if (action.kind === "insert-row") {
      const at = integer(action.at, "Row insertion position");
      if (at < 0 || at > rows.length) throw new Error("Row insertion position is out of range");
      if (rows.length >= MAX_ROWS) throw new Error(`Tables are limited to ${MAX_ROWS} rows in visual layout mode`);
      const width = rows[0]?.length || inspected.model.rows[0].cells.length;
      rows.splice(at, 0, Array.from({ length: width }, () => " "));
      applied.push({ kind: "insert-row", at });
      continue;
    }

    if (action.kind === "delete-row") {
      const row = integer(action.row, "Row number");
      if (row < 1 || row > rows.length) throw new Error("Row number is out of range");
      if (rows.length <= 1) throw new Error("A table must keep at least one row");
      rows.splice(row - 1, 1);
      applied.push({ kind: "delete-row", row });
      continue;
    }

    if (action.kind === "insert-column") {
      const at = integer(action.at, "Column insertion position");
      const width = rows[0]?.length || 0;
      if (at < 0 || at > width) throw new Error("Column insertion position is out of range");
      if (width >= MAX_COLUMNS) throw new Error(`Tables are limited to ${MAX_COLUMNS} columns in visual layout mode`);
      for (const row of rows) row.splice(at, 0, " ");
      applied.push({ kind: "insert-column", at });
      continue;
    }

    const column = integer(action.column, "Column number");
    const width = rows[0]?.length || 0;
    if (column < 1 || column > width) throw new Error("Column number is out of range");
    if (width <= 1) throw new Error("A table must keep at least one column");
    for (const row of rows) row.splice(column - 1, 1);
    applied.push({ kind: "delete-column", column });
  }

  const eol = preferredEol(inspected.source);
  const body = rows.map((row) => `||${row.join("||")}||`).join(eol);
  const proposed = `${inspected.prefix}${body}${inspected.suffix}`;
  const after = inspect(proposed);
  if (!after.editable) throw new Error(`Table layout edit produced unsupported structure: ${after.lockedReason}`);
  if (after.model.rows.length !== rows.length || after.model.rows.some((row, index) => row.cells.length !== rows[index].length)) {
    throw new Error("Table layout edit failed structural round-trip validation");
  }

  return {
    proposed,
    applied,
    before: inspectNamuTableLayout(inspected.source),
    after: inspectNamuTableLayout(proposed),
  };
}
