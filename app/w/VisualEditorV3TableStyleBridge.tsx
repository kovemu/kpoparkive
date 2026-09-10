"use client";

import { useEffect, useMemo, useState } from "react";
import { inspectNamuTableCellStyle, type NamuTableCellStyleChange } from "../../lib/namumarkTableStyleEdit";
import { parseNamuTableAstLossless } from "../../lib/namumarkTableAstLossless";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type Block = { id: string; type: string; raw: string };
type TableInfo = { nodeId: string; sectionIndex: number };
type Payload = { ok?: boolean; ast?: { blocks?: Block[] }; tables?: TableInfo[]; error?: string };
type Item = TableInfo & { raw: string; rows: number; columns: number };
type Draft = {
  bgcolor: string | null;
  color: string | null;
  width: string | null;
  nopad: boolean;
  keepall: boolean;
};

type DraftMap = Record<string, Draft>;

const EDITING = "kpoparkiveAstEditing";
const BUTTON = "kpoparkive-ve3-table-style-button";
const STYLE_ID = "kpoparkive-ve3-table-style-panel-style";

function key(nodeId: string, row: number, cell: number) {
  return `${nodeId}:${row}:${cell}`;
}

function activeCell() {
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const surface = element?.closest<HTMLElement>(".kpoparkiveAstTableSurface")
    || (document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(".kpoparkiveAstTableSurface") : null);
  if (!surface) return null;
  const nodeId = surface.dataset.ve3TableNodeId;
  const row = Number(surface.dataset.ve3Row);
  const cell = Number(surface.dataset.ve3Cell);
  return nodeId && Number.isInteger(row) && Number.isInteger(cell) ? { nodeId, row, cell } : null;
}

function initialDraft(item: Item, row: number, cell: number): Draft {
  const style = inspectNamuTableCellStyle(item.raw, row, cell);
  return {
    bgcolor: style.bgcolor,
    color: style.color,
    width: style.width,
    nopad: style.nopad,
    keepall: style.keepall,
  };
}

function equal(a: Draft, b: Draft) {
  return a.bgcolor === b.bgcolor && a.color === b.color && a.width === b.width && a.nopad === b.nopad && a.keepall === b.keepall;
}

function validCoordinate(item: Item | null, row: number, cell: number) {
  return Boolean(item && row >= 1 && row <= item.rows && cell >= 1 && cell <= item.columns);
}

export default function VisualEditorV3TableStyleBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [selectedId, setSelectedId] = useState("");
  const [row, setRow] = useState(1);
  const [cell, setCell] = useState(1);
  const [open, setOpen] = useState(false);

  const selected = useMemo(() => items.find((item) => item.nodeId === selectedId) || items[0] || null, [items, selectedId]);
  const original = selected && validCoordinate(selected, row, cell) ? initialDraft(selected, row, cell) : null;
  const draftKey = selected ? key(selected.nodeId, row, cell) : "";
  const current = original ? drafts[draftKey] || original : null;
  const optionTokens = selected && validCoordinate(selected, row, cell)
    ? inspectNamuTableCellStyle(selected.raw, row, cell).optionTokens
    : [];

  const dirtyCount = useMemo(() => {
    let count = 0;
    for (const item of items) {
      for (let r = 1; r <= item.rows; r += 1) {
        for (let c = 1; c <= item.columns; c += 1) {
          const id = key(item.nodeId, r, c);
          const draft = drafts[id];
          if (draft && !equal(draft, initialDraft(item, r, c))) count += 1;
        }
      }
    }
    return count;
  }, [items, drafts]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3TableStylePanel{position:fixed;z-index:12170;top:112px;right:14px;width:min(460px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:#fff;box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}.kpoparkiveVe3TableStyleHeader,.kpoparkiveVe3TableStyleBody{padding:12px 14px}.kpoparkiveVe3TableStyleHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3TableStyleHeader>div{display:grid;gap:2px}.kpoparkiveVe3TableStyleHeader strong{color:#5832c6}.kpoparkiveVe3TableStyleHeader span{font-size:11px;color:#82768e}.kpoparkiveVe3TableStyleHeader button,.kpoparkiveVe3TableStyleBody button,.kpoparkiveVe3TableStyleBody select,.kpoparkiveVe3TableStyleBody input{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3TableStyleHeader button{width:32px;height:32px;font-size:20px}.kpoparkiveVe3TableStyleBody{display:grid;gap:10px}.kpoparkiveVe3TableStyleBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3TableStyleBody input,.kpoparkiveVe3TableStyleBody select{height:36px;padding:0 9px;min-width:0}.kpoparkiveVe3TableStyleGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kpoparkiveVe3TableStyleChecks{display:flex;gap:16px;flex-wrap:wrap}.kpoparkiveVe3TableStyleChecks label{display:flex;align-items:center;gap:6px}.kpoparkiveVe3TableStyleChecks input{width:16px;height:16px;padding:0}.kpoparkiveVe3TableStyleMeta{padding:9px;border:1px solid #eee8f5;border-radius:8px;background:#fbfaff;font-size:11px;color:#756b80;line-height:1.5;word-break:break-word}.kpoparkiveVe3TableStyleMeta code{font-size:10px}.kpoparkiveVe3TableStyleActions{display:flex;justify-content:flex-end;gap:8px}.kpoparkiveVe3TableStyleActions button{height:36px;padding:0 11px;cursor:pointer}.kpoparkiveVe3TableStyleActions .primary{border-color:#6b3ce8;background:#6b3ce8;color:#fff;font-weight:800}@media(max-width:760px){.kpoparkiveVe3TableStylePanel{top:150px;max-height:calc(100vh - 164px)}.kpoparkiveVe3TableStyleGrid{grid-template-columns:1fr}}
`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    const sync = () => setEditing(document.body.classList.contains(EDITING));
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) { setItems([]); setDrafts({}); setSelectedId(""); setRow(1); setCell(1); setOpen(false); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as Payload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load table style AST");
        const blocks = new Map((payload.ast?.blocks || []).map((block) => [block.id, block]));
        const next = (payload.tables || []).flatMap((table) => {
          const raw = blocks.get(table.nodeId)?.raw || "";
          if (!raw) return [];
          try {
            const model = parseNamuTableAstLossless(raw);
            const columns = Math.max(0, ...model.rows.map((r) => r.cells.length));
            return [{ ...table, raw, rows: model.rows.length, columns } satisfies Item];
          } catch { return []; }
        });
        setItems(next);
        setSelectedId(next[0]?.nodeId || "");
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[VisualEditorV3TableStyleBridge]", error);
      }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    return registerV3OperationProvider("table-cell-style", () => {
      const grouped = new Map<string, NamuTableCellStyleChange[]>();
      for (const item of items) {
        for (let r = 1; r <= item.rows; r += 1) {
          for (let c = 1; c <= item.columns; c += 1) {
            const id = key(item.nodeId, r, c);
            const draft = drafts[id];
            if (!draft) continue;
            const before = initialDraft(item, r, c);
            if (equal(before, draft)) continue;
            const list = grouped.get(item.nodeId) || [];
            list.push({
              row: r,
              cell: c,
              bgcolor: draft.bgcolor,
              color: draft.color,
              width: draft.width,
              nopad: draft.nopad,
              keepall: draft.keepall,
            });
            grouped.set(item.nodeId, list);
          }
        }
      }
      return Array.from(grouped.entries()).map(([nodeId, changes]) => ({ op: "table-cell-style", nodeId, changes }) satisfies V3RegisteredOperation);
    });
  }, [editing, items, drafts]);

  useEffect(() => {
    if (!editing) return;
    const select = () => {
      const active = activeCell();
      if (!active) return;
      const item = items.find((entry) => entry.nodeId === active.nodeId);
      if (!item || !validCoordinate(item, active.row, active.cell)) return;
      setSelectedId(active.nodeId); setRow(active.row); setCell(active.cell);
    };
    document.addEventListener("focusin", select, true);
    document.addEventListener("mousedown", select, true);
    return () => { document.removeEventListener("focusin", select, true); document.removeEventListener("mousedown", select, true); };
  }, [editing, items]);

  useEffect(() => {
    const remove = () => document.getElementById(BUTTON)?.remove();
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar"); if (!toolbar) return;
      let button = document.getElementById(BUTTON) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button"); button.id = BUTTON; button.type = "button"; button.title = "Edit table cell colors, width and spacing";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => { const active = activeCell(); if (active) { setSelectedId(active.nodeId); setRow(active.row); setCell(active.cell); } setOpen((value) => !value); });
        const layout = document.getElementById("kpoparkive-ve3-table-layout-button");
        (layout || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", button);
      }
      button.textContent = `Cell style${dirtyCount ? ` (${dirtyCount})` : ""}`;
      button.disabled = !items.length;
    };
    ensure(); const observer = new MutationObserver(ensure); observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); remove(); };
  }, [editing, items, dirtyCount]);

  const update = (patch: Partial<Draft>) => {
    if (!selected || !original) return;
    setDrafts((all) => ({ ...all, [draftKey]: { ...(all[draftKey] || original), ...patch } }));
  };
  const reset = () => setDrafts((all) => { const next = { ...all }; delete next[draftKey]; return next; });
  const reveal = () => {
    if (!selected) return;
    const surface = Array.from(document.querySelectorAll<HTMLElement>(".kpoparkiveAstTableSurface"))
      .find((element) => element.dataset.ve3TableNodeId === selected.nodeId && Number(element.dataset.ve3Row) === row && Number(element.dataset.ve3Cell) === cell);
    surface?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!editing || !open) return null;
  const maxRow = selected?.rows || 1;
  const maxCell = selected ? parseNamuTableAstLossless(selected.raw).rows[row - 1]?.cells.length || selected.columns : 1;

  return <aside className="kpoparkiveVe3TableStylePanel" aria-label="Table cell style editor">
    <div className="kpoparkiveVe3TableStyleHeader"><div><strong>Cell style</strong><span>Safe NamuMark table options</span></div><button type="button" onClick={() => setOpen(false)}>×</button></div>
    <div className="kpoparkiveVe3TableStyleBody">
      {selected && current ? <>
        <label>Table<select value={selected.nodeId} onChange={(event) => { setSelectedId(event.target.value); setRow(1); setCell(1); }}>{items.map((item, index) => <option value={item.nodeId} key={item.nodeId}>{index + 1}. §{item.sectionIndex} · {item.rows} rows</option>)}</select></label>
        <div className="kpoparkiveVe3TableStyleGrid"><label>Row<input type="number" min="1" max={maxRow} value={row} onChange={(event) => { setRow(Math.max(1, Math.min(maxRow, Number(event.target.value) || 1))); setCell(1); }} /></label><label>Cell<input type="number" min="1" max={maxCell} value={cell} onChange={(event) => setCell(Math.max(1, Math.min(maxCell, Number(event.target.value) || 1)))} /></label></div>
        <div className="kpoparkiveVe3TableStyleGrid"><label>Background<input value={current.bgcolor || ""} placeholder="#fc6fcf or #fff,#222" onChange={(event) => update({ bgcolor: event.target.value || null })} /></label><label>Text color<input value={current.color || ""} placeholder="#fff or #fff,#ddd" onChange={(event) => update({ color: event.target.value || null })} /></label></div>
        <label>Width<input value={current.width || ""} placeholder="20% or 180" onChange={(event) => update({ width: event.target.value || null })} /></label>
        <div className="kpoparkiveVe3TableStyleChecks"><label><input type="checkbox" checked={current.nopad} onChange={(event) => update({ nopad: event.target.checked })} />No padding</label><label><input type="checkbox" checked={current.keepall} onChange={(event) => update({ keepall: event.target.checked })} />Keep words together</label></div>
        <div className="kpoparkiveVe3TableStyleMeta">Existing option tokens: {optionTokens.length ? optionTokens.map((token) => <code key={token}> &lt;{token}&gt;</code>) : "none"}. Unsupported options are displayed but never removed or normalized.</div>
        <div className="kpoparkiveVe3TableStyleActions"><button type="button" onClick={reveal}>Go to cell</button><button type="button" onClick={reset}>Reset cell</button></div>
      </> : <div className="kpoparkiveVe3TableStyleMeta">No editable table cell is selected.</div>}
    </div>
  </aside>;
}
