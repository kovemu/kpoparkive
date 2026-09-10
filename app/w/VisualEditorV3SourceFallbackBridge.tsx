"use client";

import { useEffect, useMemo, useState } from "react";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type Block = { id: string; type: string; raw: string; sourceStart: number; sourceEnd: number };
type Payload = { ok?: boolean; ast?: { blocks?: Block[] }; error?: string };

const EDITING_CLASS = "kpoparkiveAstEditing";
const BUTTON_ID = "kpoparkive-ve3-source-fallback-button";
const STYLE_ID = "kpoparkive-ve3-source-fallback-style";
const FALLBACK_TYPES = new Set(["table", "template", "media"]);

function short(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim().slice(0, 70);
}

export default function VisualEditorV3SourceFallbackBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);
  const selected = useMemo(() => blocks.find((block) => block.id === selectedId) || blocks[0] || null, [blocks, selectedId]);
  const dirty = useMemo(() => blocks.filter((block) => (drafts[block.id] ?? block.raw) !== block.raw).length, [blocks, drafts]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3SourcePanel{position:fixed;z-index:12180;top:112px;right:14px;width:min(620px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}.kpoparkiveVe3SourceHeader,.kpoparkiveVe3SourceBody{padding:12px 14px}.kpoparkiveVe3SourceHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3SourceHeader>div{display:grid;gap:2px}.kpoparkiveVe3SourceHeader strong{color:#5832c6}.kpoparkiveVe3SourceHeader span{font-size:11px;color:#82768e}.kpoparkiveVe3SourceHeader button,.kpoparkiveVe3SourceBody button,.kpoparkiveVe3SourceBody select,.kpoparkiveVe3SourceBody textarea{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3SourceHeader button{width:32px;height:32px;font-size:20px;cursor:pointer}.kpoparkiveVe3SourceBody{display:grid;gap:10px}.kpoparkiveVe3SourceBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3SourceBody select{height:36px;padding:0 9px;min-width:0}.kpoparkiveVe3SourceBody textarea{min-height:320px;padding:10px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.5;tab-size:2}.kpoparkiveVe3SourceMeta{padding:9px;border:1px solid #eee8f5;border-radius:8px;background:#fbfaff;color:#786e82;font-size:11px;line-height:1.5}.kpoparkiveVe3SourceActions{display:flex;justify-content:flex-end;gap:8px}.kpoparkiveVe3SourceActions button{height:36px;padding:0 12px;cursor:pointer}.kpoparkiveVe3SourceDirty{color:#6b3ce8;font-weight:800}@media(max-width:760px){.kpoparkiveVe3SourcePanel{top:150px;max-height:calc(100vh - 164px)}.kpoparkiveVe3SourceBody textarea{min-height:240px}}
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
    if (!editing) { setBlocks([]); setDrafts({}); setSelectedId(""); setOpen(false); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as Payload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load source fallback AST");
        const items = (payload.ast?.blocks || []).filter((block) => FALLBACK_TYPES.has(block.type));
        setBlocks(items);
        setDrafts(Object.fromEntries(items.map((block) => [block.id, block.raw])));
        setSelectedId(items[0]?.id || "");
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[VisualEditorV3SourceFallbackBridge]", error);
      }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    return registerV3OperationProvider("source-fallback", () => blocks
      .filter((block) => (drafts[block.id] ?? block.raw) !== block.raw)
      .map((block) => ({ op: "replace-raw", nodeId: block.id, wikitext: drafts[block.id] }) satisfies V3RegisteredOperation));
  }, [editing, blocks, drafts]);

  useEffect(() => {
    const remove = () => document.getElementById(BUTTON_ID)?.remove();
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar) return;
      let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button"); button.id = BUTTON_ID; button.type = "button"; button.title = "Advanced exact-source fallback for complex blocks";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => setOpen((value) => !value));
        const structure = document.getElementById("kpoparkive-ve3-structure-button");
        (structure || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", button);
      }
      button.textContent = `Source${dirty ? ` (${dirty})` : ""}`;
      button.disabled = !blocks.length;
    };
    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); remove(); };
  }, [editing, blocks.length, dirty]);

  const reveal = () => {
    if (!selected) return;
    const selector = selected.type === "table" ? "[data-ve3-table-node-id]" : "[data-ve3-node-id]";
    const element = Array.from(document.querySelectorAll<HTMLElement>(selector)).find((node) => node.dataset.ve3TableNodeId === selected.id || node.dataset.ve3NodeId === selected.id);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  if (!editing || !open) return null;
  return <aside className="kpoparkiveVe3SourcePanel" aria-label="Advanced source fallback">
    <div className="kpoparkiveVe3SourceHeader"><div><strong>Advanced source</strong><span>Exact AST block fallback · use only when visual controls are insufficient</span></div><button type="button" onClick={() => setOpen(false)}>×</button></div>
    <div className="kpoparkiveVe3SourceBody">
      {selected ? <>
        <label>Block<select value={selected.id} onChange={(event) => setSelectedId(event.target.value)}>{blocks.map((block, index) => <option key={block.id} value={block.id}>{index + 1}. {block.type} · {short(block.raw)}</option>)}</select></label>
        <div className="kpoparkiveVe3SourceMeta">This edits only the selected <b>{selected.type}</b> AST source range ({selected.sourceStart}–{selected.sourceEnd}). Do not combine whole-block source changes with visual edits inside the same block; the server rejects overlapping patches instead of guessing.</div>
        <label>Exact NamuMark<textarea spellCheck={false} value={drafts[selected.id] ?? selected.raw} onChange={(event) => setDrafts((current) => ({ ...current, [selected.id]: event.target.value }))} /></label>
        {(drafts[selected.id] ?? selected.raw) !== selected.raw ? <div className="kpoparkiveVe3SourceDirty">Unsaved source change</div> : null}
        <div className="kpoparkiveVe3SourceActions"><button type="button" onClick={reveal}>Go to block</button><button type="button" onClick={() => setDrafts((current) => ({ ...current, [selected.id]: selected.raw }))}>Reset</button></div>
      </> : <div className="kpoparkiveVe3SourceMeta">No complex table/template/media blocks were found.</div>}
    </div>
  </aside>;
}
