"use client";

import { useEffect, useMemo, useState } from "react";
import { fetchVisualEditorV3Payload } from "./visualEditorV3PayloadClient";
import { applyNamuTableLayoutChanges, inspectNamuTableLayout, type NamuTableLayoutAction } from "../../lib/namumarkTableLayoutEdit";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type Block = { id: string; type: string; raw: string };
type TableInfo = { nodeId: string; sectionIndex: number };
type Payload = { ok?: boolean; ast?: { blocks?: Block[] }; tables?: TableInfo[]; error?: string };
type Item = TableInfo & { raw: string; editable: boolean; lockedReason: string | null; rowCount: number; columnCount: number };
type Draft = { previewRaw: string; actions: NamuTableLayoutAction[] };

const EDITING = "kpoparkiveAstEditing";
const BUTTON = "kpoparkive-ve3-table-layout-button";
const STYLE = "kpoparkive-ve3-table-layout-v2-style";

function activeTableId() {
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  return element?.closest<HTMLElement>("[data-ve3-table-node-id]")?.dataset.ve3TableNodeId
    || (document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-ve3-table-node-id]")?.dataset.ve3TableNodeId : null)
    || null;
}

export default function VisualEditorV3TableLayoutBridgeV2({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);
  const [row, setRow] = useState(1);
  const [column, setColumn] = useState(1);
  const selected = useMemo(() => items.find((item) => item.nodeId === selectedId) || items[0] || null, [items, selectedId]);
  const draft = selected ? drafts[selected.nodeId] : undefined;
  const model = selected ? inspectNamuTableLayout(draft?.previewRaw ?? selected.raw) : null;
  const dirty = Object.values(drafts).filter((value) => value.actions.length).length;

  useEffect(() => {
    const style = document.createElement("style"); style.id = STYLE; style.textContent = `
.kpoparkiveVe3TableLayoutPanel{position:fixed;z-index:12160;top:112px;right:14px;width:min(460px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:#fff;box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}.kpoparkiveVe3TableLayoutHeader,.kpoparkiveVe3TableLayoutBody{padding:12px 14px}.kpoparkiveVe3TableLayoutHeader{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3TableLayoutHeader strong{color:#5832c6}.kpoparkiveVe3TableLayoutHeader small{display:block;color:#82768e}.kpoparkiveVe3TableLayoutHeader button,.kpoparkiveVe3TableLayoutBody button,.kpoparkiveVe3TableLayoutBody select,.kpoparkiveVe3TableLayoutBody input{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3TableLayoutHeader button{width:32px;height:32px;font-size:20px}.kpoparkiveVe3TableLayoutBody{display:grid;gap:10px}.kpoparkiveVe3TableLayoutBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3TableLayoutBody select,.kpoparkiveVe3TableLayoutBody input{height:36px;padding:0 9px}.kpoparkiveVe3TableLayoutGrid,.kpoparkiveVe3TableLayoutActions{display:grid;grid-template-columns:1fr 1fr;gap:7px}.kpoparkiveVe3TableLayoutActions button{min-height:36px;padding:6px 8px;font-weight:750;cursor:pointer}.kpoparkiveVe3TableLayoutActions button:disabled{opacity:.4}.kpoparkiveVe3TableLayoutDanger{color:#a22a3c}.kpoparkiveVe3TableLayoutMeta{padding:9px;border:1px solid #eee8f5;border-radius:8px;background:#fbfaff;font-size:11px;color:#756b80;line-height:1.5}.kpoparkiveVe3TableLayoutLocked{color:#9a6b36;font-weight:700}.kpoparkiveVe3TableLayoutFooter{display:flex;justify-content:space-between;gap:8px}.kpoparkiveVe3TableLayoutFooter button{height:36px;padding:0 11px;cursor:pointer}@media(max-width:760px){.kpoparkiveVe3TableLayoutPanel{top:150px;max-height:calc(100vh - 164px)}.kpoparkiveVe3TableLayoutGrid,.kpoparkiveVe3TableLayoutActions{grid-template-columns:1fr}}
`;
    document.head.appendChild(style); return () => style.remove();
  }, []);

  useEffect(() => { const sync = () => setEditing(document.body.classList.contains(EDITING)); const observer = new MutationObserver(sync); observer.observe(document.body,{attributes:true,attributeFilter:["class"]}); sync(); return () => observer.disconnect(); }, []);

  useEffect(() => {
    if (!editing) { setItems([]); setDrafts({}); setSelectedId(""); setOpen(false); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchVisualEditorV3Payload(title, controller.signal);
        const payload = await response.json() as Payload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load table AST");
        const blocks = new Map((payload.ast?.blocks || []).map((block) => [block.id, block]));
        const next = (payload.tables || []).map((table) => {
          const raw = blocks.get(table.nodeId)?.raw || "";
          return { ...table, raw, ...inspectNamuTableLayout(raw) } satisfies Item;
        });
        setItems(next); setDrafts(Object.fromEntries(next.map((item) => [item.nodeId,{previewRaw:item.raw,actions:[]}]))); setSelectedId(next[0]?.nodeId || "");
      } catch (error) { if (!controller.signal.aborted) console.warn("[VisualEditorV3TableLayoutBridgeV2]", error); }
    })();
    return () => controller.abort();
  }, [editing,title]);

  useEffect(() => {
    if (!editing) return;
    return registerV3OperationProvider("table-layout", () => Object.entries(drafts)
      .filter(([,value]) => value.actions.length)
      .map(([nodeId,value]) => ({ op:"table-layout", nodeId, actions:value.actions }) satisfies V3RegisteredOperation));
  }, [editing,drafts]);

  useEffect(() => {
    const remove = () => document.getElementById(BUTTON)?.remove();
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar"); if (!toolbar) return;
      let button = document.getElementById(BUTTON) as HTMLButtonElement | null;
      if (!button) { button=document.createElement("button"); button.id=BUTTON; button.type="button"; button.title="Edit table rows and columns"; button.addEventListener("mousedown",e=>e.preventDefault()); button.addEventListener("click",()=>{const active=activeTableId(); if(active&&items.some(item=>item.nodeId===active))setSelectedId(active); setOpen(v=>!v);}); const structure=document.getElementById("kpoparkive-ve3-structure-button"); (structure||toolbar.querySelector("strong"))?.insertAdjacentElement("afterend",button); }
      const nextLabel=`Table layout${dirty?` (${dirty})`:""}`; if(button.textContent!==nextLabel)button.textContent=nextLabel; button.disabled=!items.length;
    };
    ensure(); const timers=[16,80,200,500].map((delay)=>window.setTimeout(ensure,delay)); return()=>{timers.forEach((timer)=>window.clearTimeout(timer));remove();};
  },[editing,items,dirty]);

  const act = (action:NamuTableLayoutAction) => {
    if(!selected)return; const current=drafts[selected.nodeId]||{previewRaw:selected.raw,actions:[]};
    try { const result=applyNamuTableLayoutChanges(current.previewRaw,[action]); const next=inspectNamuTableLayout(result.proposed); setDrafts(all=>({...all,[selected.nodeId]:{previewRaw:result.proposed,actions:[...current.actions,action]}})); setRow(v=>Math.max(1,Math.min(v,next.rowCount))); setColumn(v=>Math.max(1,Math.min(v,next.columnCount))); } catch(error){window.alert(error instanceof Error?error.message:"Could not edit table layout");}
  };
  const reset=()=>{if(selected)setDrafts(all=>({...all,[selected.nodeId]:{previewRaw:selected.raw,actions:[]}}));};
  const reveal=()=>{if(!selected)return;Array.from(document.querySelectorAll<HTMLElement>("[data-ve3-table-node-id]")).find(el=>el.dataset.ve3TableNodeId===selected.nodeId)?.scrollIntoView({behavior:"smooth",block:"center"});};

  if(!editing||!open)return null;
  const safe=Boolean(selected?.editable&&model?.editable), rows=Math.max(1,model?.rowCount||1), cols=Math.max(1,model?.columnCount||1);
  return <aside className="kpoparkiveVe3TableLayoutPanel"><div className="kpoparkiveVe3TableLayoutHeader"><div><strong>Table layout</strong><small>AST row/column operations</small></div><button type="button" onClick={()=>setOpen(false)}>×</button></div><div className="kpoparkiveVe3TableLayoutBody">
    {selected?<><label>Table<select value={selected.nodeId} onChange={e=>{setSelectedId(e.target.value);setRow(1);setColumn(1);}}>{items.map((item,index)=>{const m=inspectNamuTableLayout(drafts[item.nodeId]?.previewRaw??item.raw);return <option value={item.nodeId} key={item.nodeId}>{index+1}. §{item.sectionIndex} · {m.rowCount}×{m.columnCount}{item.editable?"":" · protected"}</option>;})}</select></label>
    <div className="kpoparkiveVe3TableLayoutMeta">Draft: <b>{model?.rowCount||0} × {model?.columnCount||0}</b><br/>{safe?"Rectangular table; structural editing is safe.":<span className="kpoparkiveVe3TableLayoutLocked">Protected · {model?.lockedReason||selected.lockedReason||"complex table"}</span>}</div>
    <div className="kpoparkiveVe3TableLayoutGrid"><label>Row<input type="number" min="1" max={rows} value={row} onChange={e=>setRow(Math.max(1,Math.min(rows,Number(e.target.value)||1)))}/></label><label>Column<input type="number" min="1" max={cols} value={column} onChange={e=>setColumn(Math.max(1,Math.min(cols,Number(e.target.value)||1)))}/></label></div>
    <div className="kpoparkiveVe3TableLayoutActions"><button disabled={!safe} onClick={()=>act({kind:"insert-row",at:row-1})}>Insert row above</button><button disabled={!safe} onClick={()=>act({kind:"insert-row",at:row})}>Insert row below</button><button className="kpoparkiveVe3TableLayoutDanger" disabled={!safe||rows<=1} onClick={()=>act({kind:"delete-row",row})}>Delete row</button><span/><button disabled={!safe} onClick={()=>act({kind:"insert-column",at:column-1})}>Insert column left</button><button disabled={!safe} onClick={()=>act({kind:"insert-column",at:column})}>Insert column right</button><button className="kpoparkiveVe3TableLayoutDanger" disabled={!safe||cols<=1} onClick={()=>act({kind:"delete-column",column})}>Delete column</button><span/></div>
    <div className="kpoparkiveVe3TableLayoutMeta">Cell text, template parameters and media edits in this same table are merged on the server first, then these layout actions are applied. The proposal is saved as one exact table AST patch.</div><div className="kpoparkiveVe3TableLayoutFooter"><button onClick={reveal}>Go to table</button><button onClick={reset}>Reset layout</button></div></>:<div className="kpoparkiveVe3TableLayoutMeta">No tables found.</div>}
  </div></aside>;
}
