import { editorElementToWikitext, wikiBlockToEditorHtml } from "../../lib/wikiVisualEdit";

export type V3TableField = {
  id: string;
  row: number;
  cell: number;
  fragment: number;
  sourceStart: number;
  sourceEnd: number;
  valueWikitext: string;
  plainText: string;
};

export type V3TableCell = {
  id: string;
  row: number;
  cell: number;
  locked: boolean;
  lockedReason: string | null;
  fields: V3TableField[];
};

export type V3TableRow = {
  id: string;
  row: number;
  cells: V3TableCell[];
};

export type V3TableModel = {
  nodeId: string;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  rowCount: number;
  cellCount: number;
  editableFieldCount: number;
  lockedCellCount: number;
  rows: V3TableRow[];
};

export type V3TableSurfaceRecord = {
  tableNodeId: string;
  fieldId: string;
  row: number;
  cell: number;
  originalWikitext: string;
  surface: HTMLElement;
  cleanup: () => void;
};

export type V3TableFieldOperation = {
  op: "table-fields";
  nodeId: string;
  changes: Array<{ fieldId: string; proposedWikitext: string }>;
};

function normalize(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function compact(value: string) {
  return normalize(value).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

function visible(element: HTMLElement) {
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
}

function allFields(model: V3TableModel) {
  return model.rows.flatMap((row) => row.cells.flatMap((cell) => cell.fields));
}

function topLevelTables(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLTableElement>("table"))
    .filter((table) => {
      if (!visible(table)) return false;
      if (table.closest(".kpoparkiveAstToolbar, .kpoparkiveAstStatus")) return false;
      const parentTable = table.parentElement?.closest("table");
      return !parentTable || !root.contains(parentTable);
    });
}

function tableCoverage(model: V3TableModel, table: HTMLTableElement) {
  const actual = compact(table.innerText || table.textContent || "");
  if (!actual) return 0;
  const fields = allFields(model)
    .map((field) => compact(field.plainText))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .slice(0, 30);
  if (!fields.length) return 0;

  let total = 0;
  let hit = 0;
  for (const expected of fields) {
    const weight = Math.max(2, Math.min(28, expected.length));
    total += weight;
    if (actual.includes(expected)) {
      hit += weight;
      continue;
    }
    if (expected.length >= 16 && actual.includes(expected.slice(0, Math.min(40, expected.length)))) hit += weight * .72;
  }
  return total ? hit / total : 0;
}

function bestTable(root: HTMLElement, model: V3TableModel, claimed: Set<HTMLTableElement>) {
  const scored = topLevelTables(root)
    .filter((table) => !claimed.has(table))
    .map((table) => ({ table, score: tableCoverage(model, table) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < .24) return null;
  if (scored[1] && scored[0].score < .72 && scored[1].score >= scored[0].score - .035) return null;
  return scored[0].table;
}

function elementTextScore(expectedText: string, element: HTMLElement) {
  const expected = compact(expectedText);
  const actual = compact(element.innerText || element.textContent || "");
  if (!expected || !actual) return 0;
  if (expected === actual) return 1;
  if (actual.includes(expected)) return expected.length / actual.length;
  if (expected.includes(actual)) return actual.length / expected.length * .72;
  return 0;
}

function elementCandidates(cell: HTMLTableCellElement, claimed: Set<HTMLElement>) {
  const descendants = Array.from(cell.querySelectorAll<HTMLElement>("a,span,p,strong,b,em,i,small,div"));
  return [...descendants, cell].filter((element) => {
    if (claimed.has(element)) return false;
    if (Array.from(claimed).some((other) => other.contains(element) || element.contains(other))) return false;
    if (element.closest(".kpoparkiveAstTableSurface")) return false;
    if (element !== cell && element.querySelector("table")) return false;
    return visible(element);
  });
}

function bestFieldHost(cell: HTMLTableCellElement, field: V3TableField, claimed: Set<HTMLElement>) {
  const expected = compact(field.plainText);
  if (!expected) return null;
  const scored = elementCandidates(cell, claimed)
    .map((element) => {
      const score = elementTextScore(field.plainText, element);
      const actual = compact(element.innerText || element.textContent || "");
      const exactBonus = actual === expected ? .35 : 0;
      const leafBonus = element.children.length === 0 ? .06 : 0;
      const cellPenalty = element === cell ? .04 : 0;
      return { element, rank: score + exactBonus + leafBonus - cellPenalty, score };
    })
    .filter((item) => item.score >= .62)
    .sort((a, b) => b.rank - a.rank || (a.element.textContent || "").length - (b.element.textContent || "").length);
  if (!scored.length) return null;
  if (scored[1] && scored[0].score < 1 && scored[1].rank >= scored[0].rank - .02) return null;
  return scored[0].element;
}

function fallbackFieldHost(table: HTMLTableElement, field: V3TableField, claimed: Set<HTMLElement>) {
  const cells = Array.from(table.querySelectorAll<HTMLTableCellElement>(":scope > thead > tr > th, :scope > thead > tr > td, :scope > tbody > tr > th, :scope > tbody > tr > td, :scope > tfoot > tr > th, :scope > tfoot > tr > td, :scope > tr > th, :scope > tr > td"));
  const scored: Array<{ element: HTMLElement; rank: number }> = [];
  for (const cell of cells) {
    for (const element of elementCandidates(cell, claimed)) {
      const score = elementTextScore(field.plainText, element);
      if (score < .78) continue;
      const actual = compact(element.innerText || element.textContent || "");
      const expected = compact(field.plainText);
      const rank = score + (actual === expected ? .35 : 0) + (element.children.length === 0 ? .05 : 0) - (element === cell ? .04 : 0);
      scored.push({ element, rank });
    }
  }
  scored.sort((a, b) => b.rank - a.rank || (a.element.textContent || "").length - (b.element.textContent || "").length);
  if (!scored.length) return null;
  if (scored[1] && scored[1].rank >= scored[0].rank - .025) return null;
  return scored[0].element;
}

function fragmentHtml(wikitext: string) {
  const html = wikiBlockToEditorHtml(wikitext);
  const match = html.match(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/i);
  return match ? match[1] : html.replace(/<\/?p(?:\s[^>]*)?>/gi, "");
}

function makeSurface(host: HTMLElement, model: V3TableModel, field: V3TableField, onActivate: (surface: HTMLElement) => void): V3TableSurfaceRecord {
  const surface = document.createElement(host.matches("td,th,div,p") ? "div" : "span");
  surface.className = "kpoparkiveAstTableSurface";
  surface.contentEditable = "true";
  surface.spellcheck = true;
  surface.dataset.ve3TableNodeId = model.nodeId;
  surface.dataset.ve3FieldId = field.id;
  surface.dataset.ve3Row = String(field.row);
  surface.dataset.ve3Cell = String(field.cell);
  surface.innerHTML = fragmentHtml(field.valueWikitext);
  surface.addEventListener("focusin", () => onActivate(surface));
  surface.addEventListener("mousedown", () => onActivate(surface));
  surface.addEventListener("click", (event) => {
    const anchor = (event.target as Element | null)?.closest?.("a");
    if (anchor) event.preventDefault();
  });
  surface.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    document.execCommand("insertHTML", false, "<br>");
    surface.dispatchEvent(new Event("input", { bubbles: true }));
  });

  if (host.matches("td,th")) {
    const cell = host as HTMLTableCellElement;
    const holder = document.createElement("span");
    holder.dataset.ve3TableOriginal = "1";
    while (cell.firstChild) holder.appendChild(cell.firstChild);
    holder.style.display = "none";
    cell.append(holder, surface);
    return {
      tableNodeId: model.nodeId,
      fieldId: field.id,
      row: field.row,
      cell: field.cell,
      originalWikitext: field.valueWikitext,
      surface,
      cleanup: () => {
        if (!holder.isConnected) return;
        surface.remove();
        while (holder.firstChild) cell.insertBefore(holder.firstChild, holder);
        holder.remove();
      },
    };
  }

  const oldDisplay = host.style.display;
  host.style.display = "none";
  host.dataset.ve3TableOriginal = "1";
  host.parentNode?.insertBefore(surface, host);
  return {
    tableNodeId: model.nodeId,
    fieldId: field.id,
    row: field.row,
    cell: field.cell,
    originalWikitext: field.valueWikitext,
    surface,
    cleanup: () => {
      surface.remove();
      host.style.display = oldDisplay;
      host.removeAttribute("data-ve3-table-original");
    },
  };
}

function directCell(table: HTMLTableElement, field: V3TableField) {
  const row = table.rows.item(field.row - 1);
  if (!row) return null;
  return row.cells.item(field.cell - 1);
}

export function buildV3TableSurfaces(options: {
  tables: V3TableModel[];
  article: HTMLElement;
  sectionRoots: Map<number, HTMLElement>;
  onActivate: (surface: HTMLElement) => void;
}) {
  const records: V3TableSurfaceRecord[] = [];
  const claimedTables = new Set<HTMLTableElement>();
  let mappedTables = 0;
  let skippedTables = 0;

  for (const model of options.tables) {
    if (!model.editableFieldCount) {
      skippedTables += 1;
      continue;
    }
    const root = model.sectionIndex === 0 ? options.article : options.sectionRoots.get(model.sectionIndex);
    if (!root) {
      skippedTables += 1;
      continue;
    }
    const table = bestTable(root, model, claimedTables);
    if (!table) {
      skippedTables += 1;
      continue;
    }
    claimedTables.add(table);
    table.classList.add("kpoparkiveAstTableMapped");
    table.dataset.ve3TableNodeId = model.nodeId;
    mappedTables += 1;

    const claimedHosts = new Set<HTMLElement>();
    for (const field of allFields(model)) {
      const expectedCell = directCell(table, field);
      let host = expectedCell ? bestFieldHost(expectedCell, field, claimedHosts) : null;
      if (!host) host = fallbackFieldHost(table, field, claimedHosts);
      if (!host) continue;
      claimedHosts.add(host);
      records.push(makeSurface(host, model, field, options.onActivate));
    }
  }

  return { records, mappedTables, skippedTables };
}

export function cleanupV3TableSurfaces(records: V3TableSurfaceRecord[]) {
  for (const record of records.slice().reverse()) record.cleanup();
  for (const table of Array.from(document.querySelectorAll<HTMLElement>(".kpoparkiveAstTableMapped"))) {
    table.classList.remove("kpoparkiveAstTableMapped");
    table.removeAttribute("data-ve3-table-node-id");
  }
}

export function collectV3TableOperations(records: V3TableSurfaceRecord[]): V3TableFieldOperation[] {
  const grouped = new Map<string, Array<{ fieldId: string; proposedWikitext: string }>>();
  for (const record of records) {
    const proposedWikitext = editorElementToWikitext(record.surface).trim();
    if (normalize(proposedWikitext) === normalize(record.originalWikitext)) continue;
    const list = grouped.get(record.tableNodeId) || [];
    list.push({ fieldId: record.fieldId, proposedWikitext });
    grouped.set(record.tableNodeId, list);
  }
  return Array.from(grouped.entries()).map(([nodeId, changes]) => ({ op: "table-fields", nodeId, changes }));
}
