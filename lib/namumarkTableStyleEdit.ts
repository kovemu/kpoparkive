import { parseNamuTableAstLossless } from "./namumarkTableAstLossless";

export type NamuTableCellStyleChange = {
  row: number;
  cell: number;
  bgcolor?: string | null;
  color?: string | null;
  width?: string | null;
  nopad?: boolean | null;
  keepall?: boolean | null;
};

export type NamuTableCellStyleModel = {
  row: number;
  cell: number;
  bgcolor: string | null;
  color: string | null;
  width: string | null;
  nopad: boolean;
  keepall: boolean;
  optionTokens: string[];
};

type Token = { raw: string; inner: string; key: string | null; value: string | null };

function normalizedKey(inner: string) {
  const trimmed = inner.trim();
  if (/^nopad$/i.test(trimmed)) return { key: "nopad", value: null };
  if (/^keepall$/i.test(trimmed)) return { key: "keepall", value: null };
  const match = trimmed.match(/^(bgcolor|color|width)\s*=\s*([\s\S]*)$/i);
  return match ? { key: match[1].toLowerCase(), value: match[2] } : { key: null, value: null };
}

function splitCell(raw: string) {
  let cursor = 0;
  while (cursor < raw.length && /\s/.test(raw[cursor]) && raw[cursor] !== "\n" && raw[cursor] !== "\r") cursor += 1;
  const leading = raw.slice(0, cursor);
  const tokens: Token[] = [];
  while (cursor < raw.length && raw[cursor] === "<") {
    const end = raw.indexOf(">", cursor + 1);
    if (end < 0 || /[\r\n]/.test(raw.slice(cursor, end + 1))) break;
    let after = end + 1;
    while (after < raw.length && (raw[after] === " " || raw[after] === "\t")) after += 1;
    const tokenRaw = raw.slice(cursor, after);
    const inner = raw.slice(cursor + 1, end);
    const parsed = normalizedKey(inner);
    tokens.push({ raw: tokenRaw, inner, ...parsed });
    cursor = after;
  }
  return { leading, tokens, content: raw.slice(cursor) };
}

function safeValue(value: unknown, label: string) {
  const text = String(value ?? "").trim();
  if (text.length > 120 || /[<>\r\n]/.test(text)) throw new Error(`${label} contains unsupported table option syntax`);
  return text;
}

function setToken(tokens: Token[], key: "bgcolor" | "color" | "width" | "nopad" | "keepall", value: string | boolean | null | undefined) {
  if (value === undefined) return tokens;
  const existing = tokens.findIndex((token) => token.key === key);
  const remove = value === null || value === false || (typeof value === "string" && !value.trim());
  if (remove) return tokens.filter((token) => token.key !== key);

  const raw = key === "nopad" || key === "keepall"
    ? `<${key}>`
    : `<${key}=${safeValue(value, key)}>`;
  const next: Token = { raw, inner: raw.slice(1, -1), key, value: typeof value === "string" ? value.trim() : null };
  if (existing >= 0) return tokens.map((token, index) => index === existing ? next : token);
  return [...tokens, next];
}

function cellAt(tableRaw: string, row: number, cell: number) {
  const model = parseNamuTableAstLossless(tableRaw);
  const rowModel = model.rows[row - 1];
  const cellModel = rowModel?.cells[cell - 1];
  if (!cellModel) throw new Error(`Table cell ${row}:${cell} no longer exists`);
  return { model, cellModel };
}

export function inspectNamuTableCellStyle(tableRaw: string, row: number, cell: number): NamuTableCellStyleModel {
  const { cellModel } = cellAt(tableRaw, row, cell);
  const parts = splitCell(cellModel.raw);
  const value = (key: string) => parts.tokens.find((token) => token.key === key)?.value || null;
  return {
    row,
    cell,
    bgcolor: value("bgcolor"),
    color: value("color"),
    width: value("width"),
    nopad: parts.tokens.some((token) => token.key === "nopad"),
    keepall: parts.tokens.some((token) => token.key === "keepall"),
    optionTokens: parts.tokens.map((token) => token.inner),
  };
}

export function applyNamuTableCellStyleChanges(tableRaw: string, changes: NamuTableCellStyleChange[]) {
  const source = String(tableRaw ?? "");
  if (!Array.isArray(changes) || !changes.length) throw new Error("No table cell style changes were supplied");
  if (changes.length > 200) throw new Error("Too many table cell style changes in one table");

  const originalModel = parseNamuTableAstLossless(source);
  const patches: Array<{ start: number; end: number; before: string; after: string; row: number; cell: number }> = [];
  const seen = new Set<string>();

  for (const change of changes) {
    const row = Number(change.row);
    const cell = Number(change.cell);
    if (!Number.isInteger(row) || !Number.isInteger(cell) || row < 1 || cell < 1) throw new Error("Invalid table cell coordinates");
    const key = `${row}:${cell}`;
    if (seen.has(key)) throw new Error(`Duplicate table cell style change (${key})`);
    seen.add(key);
    const cellModel = originalModel.rows[row - 1]?.cells[cell - 1];
    if (!cellModel) throw new Error(`Table cell ${key} no longer exists`);
    const parts = splitCell(cellModel.raw);
    let tokens = [...parts.tokens];
    tokens = setToken(tokens, "bgcolor", change.bgcolor);
    tokens = setToken(tokens, "color", change.color);
    tokens = setToken(tokens, "width", change.width);
    tokens = setToken(tokens, "nopad", change.nopad);
    tokens = setToken(tokens, "keepall", change.keepall);
    const after = `${parts.leading}${tokens.map((token) => token.raw).join("")}${parts.content}`;
    if (after !== cellModel.raw) patches.push({ start: cellModel.sourceStart, end: cellModel.sourceEnd, before: cellModel.raw, after, row, cell });
  }

  let proposed = source;
  for (const patch of [...patches].sort((a, b) => b.start - a.start || b.end - a.end)) {
    if (source.slice(patch.start, patch.end) !== patch.before) throw new Error(`Table cell ${patch.row}:${patch.cell} source changed during style editing`);
    proposed = `${proposed.slice(0, patch.start)}${patch.after}${proposed.slice(patch.end)}`;
  }

  const nextModel = parseNamuTableAstLossless(proposed);
  if (nextModel.rows.length !== originalModel.rows.length || nextModel.cellCount !== originalModel.cellCount) {
    throw new Error("Cell style edit changed table structure unexpectedly");
  }
  if (originalModel.rows.some((row, index) => row.cells.length !== nextModel.rows[index]?.cells.length)) {
    throw new Error("Cell style edit changed row structure unexpectedly");
  }

  return { proposed, changed: patches };
}
