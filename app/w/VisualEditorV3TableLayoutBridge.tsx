"use client";

import { useEffect, useMemo, useState } from "react";
import { applyNamuTableLayoutChanges, inspectNamuTableLayout, type NamuTableLayoutAction } from "../../lib/namumarkTableLayoutEdit";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type AstBlock = { id: string; type: string; raw: string };
type TablePayload = {
  ok?: boolean;
  ast?: { blocks?: AstBlock[] };
  tables?: Array<{ nodeId: string; sectionIndex: number; rowCount: number; cellCount: number }>;
  error?: string;
};
type TableItem = {
  nodeId: string;
  sectionIndex: number;
  raw: string;
  editable: boolean;
  lockedReason: string | null;
  rowCount: number;
  columnCount: number;
};
type Draft = { raw: string; actions: NamuTableLayoutAction[] };

const EDITING_CLASS = "kpoparkiveAstEditing";
const BUTTON_ID = "kpoparkive-ve3-table-layout-button";
const STYLE_ID = "kpoparkive-ve3-table-layout-style";

function activeTableNodeId() {
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const selected = element?.closest<HTMLElement>("[data-ve3-table-node-id]")?.dataset.ve3TableNodeId;
  if (selected) return selected;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return active?.closest<HTMLElement>("[data-ve3-table-node-id]")?.dataset.ve3TableNodeId || active?.dataset.ve3TableNodeId || null;
}

function displayLabel(item: TableItem, index: number, draft?: Draft) {
  const model = inspectNamuTableLayout(draft?.raw ?? item.raw);
  return `${index + 1}. §${item.sectionIndex} · ${model.rowCount}×${model.columnCount}${item.editable ? "" : " · protected"}`;
}

export default function VisualEditorV3TableLayoutBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [tables, setTables] = useState<TableItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedId, setSelectedId] = useState<string>("");
  const [panelOpen, setPanelOpen] = useState(false);
  const [row, setRow] = useState(1);
  const [column, setColumn] = useState(1);

  const selected = useMemo(() => tables.find((table) => table.nodeId === selectedId) || tables[0] || null, [tables, selectedId]);
  const selectedDraft = selected ? drafts[selected.nodeId] : undefined;
  const selectedModel = selected ? inspectNamuTableLayout(selectedDraft?.raw ?? selected.raw) : null;
  const dirtyCount = useMemo(() => Object.values(drafts).filter((draft) => draft.actions.length > 0).length, [drafts]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3TableLayoutPanel{position:fixed;z-index:12160;top:112px;right:14px;width:min(460px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}
.kpoparkiveVe3TableLayoutHeader,.kpoparkiveVe3TableLayoutBody{padding:12px 14px}.kpoparkiveVe3TableLayoutHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3TableLayoutHeader>div{display:grid;gap:2px}.kpoparkiveVe3TableLayoutHeader strong{color:#5832c6}.kpoparkiveVe3TableLayoutHeader span{font-size:11px;color:#82768e}.kpoparkiveVe3TableLayoutHeader button,.kpoparkiveVe3TableLayoutBody button,.kpoparkiveVe3TableLayoutBody select,.kpoparkiveVe3TableLayoutBody input{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3TableLayoutHeader button{width:32px;height:32px;font-size:20px;cursor:pointer}.kpoparkiveVe3TableLayoutBody{display:grid;gap:11px}.kpoparkiveVe3TableLayoutBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3TableLayoutBody select,.kpoparkiveVe3TableLayoutBody input{height:36px;padding:0 9px;min-width:0}.kpoparkiveVe3TableLayoutGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kpoparkiveVe3TableLayoutActions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.kpoparkiveVe3TableLayoutActions button{min-height:36px;padding:6px 9px;cursor:pointer;font-weight:750}.kpoparkiveVe3TableLayoutActions button:disabled{opacity:.4;cursor:default}.kpoparkiveVe3TableLayoutDanger{color:#a22a3c}.kpoparkiveVe3TableLayoutMeta{padding:9px;border:1px solid #eee8f5;border-radius:8px;background:#fbfaff;font-size:11px;line-height:1.5;color:#756b80}.kpoparkiveVe3TableLayoutLocked{color:#9a6b36;font-weight:700}.kpoparkiveVe3TableLayoutFooter{display:flex;justify-content:space-between;gap:8px}.kpoparkiveVe3TableLayoutFooter button{height:36px;padding:0 12px;cursor:pointer}.kpoparkiveVe3TableLayoutFooter .primary{border-color:#6b3ce8;background:#6b3ce8;color:#fff;font-weight:800}
@media(max-width:760px){.kpoparkiveVe3TableLayoutPanel{top:150px;max-height:calc(100vh - 164px)}.kpoparkiveVe3TableLayoutGrid,.kpoparkiveVe3TableLayoutActions{grid-template-columns:1fr}}
`;
    document.head.appendChild(style);
    return () => style.remove();
  }, []);

  useEffect(() => {
    const sync = () => setEditing(document.body.classList.contains(EDITING_CLASS));
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editing) {
      setTables([]); setDrafts({}); setSelectedId(""); setPanelOpen(false); setRow(1); setColumn(1);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as TablePayload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load table layout AST");
        const blocks = new Map((payload.ast?.blocks || []).map((block) => [block.id, block]));
        const items = (payload.tables || []).map((table) => {
          const raw = blocks.get(table.nodeId)?.raw || "";
          const model = inspectNamuTableLayout(raw);
          return { nodeId: table.nodeId, sectionIndex: table.sectionIndex, raw, ...model } satisfies TableItem;
        });
        setTables(items);
        setDrafts(Object.fromEntries(items.map((item) => [item.nodeId, { raw: item.raw, actions: [] }])));
        setSelectedId(items[0]?.nodeId || "");
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[VisualEditorV3TableLayoutBridge]", error);
      }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    const unregister = registerV3OperationProvider("table-layout", () => {
      const operations: V3RegisteredOperation[] = [];
      for (const item of tables) {
        const draft = drafts[item.nodeId];
        if (!draft?.actions.length || draft.raw === item.raw) continue;
        operations.push({ op: "replace-raw", nodeId: item.nodeId, wikitext: draft.raw });
      }
      return operations;
    });
    return unregister;
  }, [editing, tables, drafts]);

  useEffect(() => {
    const remove = () => document.getElementById(BUTTON_ID)?.remove();
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar) return;
      let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button");
        button.id = BUTTON_ID; button.type = "button"; button.title = "Add or remove rows and columns in simple tables";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => {
          const active = activeTableNodeId();
          if (active && tables.some((table) => table.nodeId === active)) setSelectedId(active);
          setPanelOpen((value) => !value);
        });
        const structure = document.getElementById("kpoparkive-ve3-structure-button");
        (structure || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", button);
      }
      button.textContent = `Table layout${dirtyCount ? ` (${dirtyCount})` : ""}`;
      button.disabled = !tables.length;
    };
    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); remove(); };
  }, [editing, tables, dirtyCount]);

  const applyAction = (action: NamuTableLayoutAction) => {
    if (!selected) return;
    const current = drafts[selected.nodeId] || { raw: selected.raw, actions: [] };
    try {
      const result = applyNamuTableLayoutChanges(current.raw, [action]);
      setDrafts((all) => ({ ...all, [selected.nodeId]: { raw: result.proposed, actions: [...current.actions, action] } }));
      const next = inspectNamuTableLayout(result.proposed);
      setRow((value) => Math.max(1, Math.min(value, next.rowCount)));
      setColumn((value) => Math.max(1, Math.min(value, next.columnCount)));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not change table layout");
    }
  };

  const resetSelected = () => {
    if (!selected) return;
    setDrafts((all) => ({ ...all, [selected.nodeId]: { raw: selected.raw, actions: [] } }));
    setRow(1); setColumn(1);
  };

  const reveal = () => {
    if (!selected) return;
    const element = Array.from(document.querySelectorAll<HTMLElement>("[data-ve3-table-node-id]"))
      .find((node) => node.dataset.ve3TableNodeId === selected.nodeId);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!editing || !panelOpen) return null;
  const canEdit = Boolean(selected?.editable && selectedModel?.editable);
  const maxRow = Math.max(1, selectedModel?.rowCount || 1);
  const maxColumn = Math.max(1, selectedModel?.columnCount || 1);

  return <aside className="kpoparkiveVe3TableLayoutPanel" aria-label="Table layout editor">
    <div className="kpoparkiveVe3TableLayoutHeader"><div><strong>Table layout</strong><span>Safe structural row/column editing</span></div><button type="button" onClick={() => setPanelOpen(false)}>×</button></div>
    <div className="kpoparkiveVe3TableLayoutBody">
      {selected ? <>
        <label>Table<select value={selected.nodeId} onChange={(event) => { setSelectedId(event.target.value); setRow(1); setColumn(1); }}>{tables.map((item, index) => <option value={item.nodeId} key={item.nodeId}>{displayLabel(item, index, drafts[item.nodeId])}</option>)}</select></label>
        <div className="kpoparkiveVe3TableLayoutMeta">
          Current draft: <b>{selectedModel?.rowCount || 0} rows × {selectedModel?.columnCount || 0} columns</b><br />
          {canEdit ? <>This table is rectangular and has no merged/multiline structural cells.</> : <span className="kpoparkiveVe3TableLayoutLocked">Protected · {selectedModel?.lockedReason || selected.lockedReason || "complex table"}</span>}
        </div>
        <div className="kpoparkiveVe3TableLayoutGrid">
          <label>Row<input type="number" min="1" max={maxRow} value={row} onChange={(event) => setRow(Math.max(1, Math.min(maxRow, Number(event.target.value) || 1)))} /></label>
          <label>Column<input type="number" min="1" max={maxColumn} value={column} onChange={(event) => setColumn(Math.max(1, Math.min(maxColumn, Number(event.target.value) || 1)))} /></label>
        </div>
        <div className="kpoparkiveVe3TableLayoutActions">
          <button type="button" disabled={!canEdit} onClick={() => applyAction({ kind: "insert-row", at: row - 1 })}>Insert row above</button>
          <button type="button" disabled={!canEdit} onClick={() => applyAction({ kind: "insert-row", at: row })}>Insert row below</button>
          <button type="button" disabled={!canEdit || maxRow <= 1} className="kpoparkiveVe3TableLayoutDanger" onClick={() => applyAction({ kind: "delete-row", row })}>Delete row</button>
          <span />
          <button type="button" disabled={!canEdit} onClick={() => applyAction({ kind: "insert-column", at: column - 1 })}>Insert column left</button>
          <button type="button" disabled={!canEdit} onClick={() => applyAction({ kind: "insert-column", at: column })}>Insert column right</button>
          <button type="button" disabled={!canEdit || maxColumn <= 1} className="kpoparkiveVe3TableLayoutDanger" onClick={() => applyAction({ kind: "delete-column", column })}>Delete column</button>
          <span />
        </div>
        <div className="kpoparkiveVe3TableLayoutMeta">Layout edits preserve every untouched cell&apos;s exact NamuMark. Merged cells and multiline logical rows are intentionally source-protected. Avoid changing cell contents and layout of the same table in one proposal; save one structural step first.</div>
        <div className="kpoparkiveVe3TableLayoutFooter"><button type="button" onClick={reveal}>Go to table</button><div><button type="button" onClick={resetSelected}>Reset table</button></div></div>
      </> : <div className="kpoparkiveVe3TableLayoutMeta">No tables were found.</div>}
    </div>
  </aside>;
}
