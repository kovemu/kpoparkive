"use client";

import { useEffect, useMemo, useState } from "react";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type AstBlock = {
  id: string;
  type: string;
  raw: string;
  sourceStart: number;
  sourceEnd: number;
  level?: number;
};

type Payload = { ok?: boolean; ast?: { blocks?: AstBlock[] }; error?: string };
type PendingInsert = { id: string; anchorNodeId: string; position: "before" | "after"; wikitext: string; label: string };
type InsertKind = "paragraph" | "heading" | "list" | "table" | "template" | "image" | "youtube" | "divider";
type Tab = "insert" | "blocks" | "advanced";

const EDITING_CLASS = "kpoparkiveAstEditing";
const BUTTON_ID = "kpoparkive-ve3-structure-button";
const DELETE_BUTTON_ID = "kpoparkive-ve3-delete-button";
const STYLE_ID = "kpoparkive-ve3-structure-style";
const DELETABLE = new Set(["paragraph", "list", "table", "template", "media", "divider", "styled-block", "raw-block"]);
const ADVANCED = new Set(["styled-block", "raw-block"]);

function sectionedBlocks(blocks: AstBlock[]) {
  let section = 0;
  return blocks.map((block) => {
    if (block.type === "heading") section += 1;
    return { ...block, sectionIndex: section };
  });
}

function shortRaw(block: AstBlock) {
  const value = block.raw.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  return value.slice(0, 74) || block.type;
}

function activeNodeId() {
  const selection = window.getSelection();
  const selectedNode = selection?.anchorNode || selection?.focusNode || null;
  const element = selectedNode instanceof Element ? selectedNode : selectedNode?.parentElement;
  const direct = element?.closest<HTMLElement>("[data-ve3-node-id]")?.dataset.ve3NodeId;
  if (direct) return direct;
  const table = element?.closest<HTMLElement>("[data-ve3-table-node-id]")?.dataset.ve3TableNodeId;
  if (table) return table;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return active?.dataset.ve3NodeId || active?.dataset.ve3TableNodeId || null;
}

function buildInsert(kind: InsertKind, form: Record<string, string>) {
  if (kind === "paragraph") {
    const text = (form.text || "").trim();
    if (!text) throw new Error("Paragraph text is required");
    return { wikitext: text, label: `Paragraph · ${text.slice(0, 45)}` };
  }
  if (kind === "heading") {
    const text = (form.text || "").trim();
    if (!text) throw new Error("Heading text is required");
    const level = Math.max(2, Math.min(6, Number(form.level || 2)));
    const marks = "=".repeat(level);
    return { wikitext: `${marks} ${text} ${marks}`, label: `Heading H${level} · ${text.slice(0, 45)}` };
  }
  if (kind === "list") {
    const lines = (form.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) throw new Error("At least one list item is required");
    return { wikitext: lines.map((line) => ` * ${line}`).join("\n"), label: `List · ${lines.length} items` };
  }
  if (kind === "table") {
    const rows = Math.max(1, Math.min(12, Number(form.rows || 2)));
    const columns = Math.max(1, Math.min(8, Number(form.columns || 2)));
    const wikitext = Array.from({ length: rows }, (_, row) => `||${Array.from({ length: columns }, (_, column) => ` Cell ${row + 1}-${column + 1} `).join("||")}||`).join("\n");
    return { wikitext, label: `Table · ${rows}×${columns}` };
  }
  if (kind === "template") {
    const name = (form.name || "").trim();
    if (!name) throw new Error("Template name is required");
    const args = (form.args || "").trim();
    return { wikitext: `[include(${name}${args ? `,${args}` : ""})]`, label: `Template · ${name}` };
  }
  if (kind === "image") {
    const target = (form.target || "").trim().replace(/^(?:파일|File):/i, "");
    if (!target) throw new Error("Image filename is required");
    const options = [form.width?.trim() ? `width=${form.width.trim()}` : "", form.align?.trim() ? `align=${form.align.trim()}` : ""].filter(Boolean);
    return { wikitext: `[[파일:${target}${options.length ? `|${options.join("|")}` : ""}]]`, label: `Image · ${target}` };
  }
  if (kind === "youtube") {
    const target = (form.target || "").trim();
    if (!target) throw new Error("YouTube video id is required");
    const options = [form.width?.trim() ? `width=${form.width.trim()}` : "", form.height?.trim() ? `height=${form.height.trim()}` : ""].filter(Boolean);
    return { wikitext: `[youtube(${target}${options.length ? `, ${options.join(", ")}` : ""})]`, label: `YouTube · ${target}` };
  }
  return { wikitext: "----", label: "Divider" };
}

function decorateDeleted(ids: string[]) {
  for (const old of Array.from(document.querySelectorAll<HTMLElement>(".kpoparkiveVe3PendingDelete"))) old.classList.remove("kpoparkiveVe3PendingDelete");
  for (const id of ids) {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[data-ve3-node-id],[data-ve3-table-node-id]"))) {
      if (element.dataset.ve3NodeId === id || element.dataset.ve3TableNodeId === id) element.classList.add("kpoparkiveVe3PendingDelete");
    }
  }
}

export default function VisualEditorV3StructureBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [blocks, setBlocks] = useState<ReturnType<typeof sectionedBlocks>>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("insert");
  const [anchorId, setAnchorId] = useState<string>("");
  const [position, setPosition] = useState<"before" | "after">("after");
  const [kind, setKind] = useState<InsertKind>("paragraph");
  const [form, setForm] = useState<Record<string, string>>({ level: "2", rows: "2", columns: "2" });
  const [pendingInserts, setPendingInserts] = useState<PendingInsert[]>([]);
  const [pendingDeletes, setPendingDeletes] = useState<string[]>([]);
  const [advancedDrafts, setAdvancedDrafts] = useState<Record<string, string>>({});
  const [advancedId, setAdvancedId] = useState<string>("");
  const semanticBlocks = useMemo(() => blocks.filter((block) => block.type !== "whitespace"), [blocks]);
  const advancedBlocks = useMemo(() => blocks.filter((block) => ADVANCED.has(block.type)), [blocks]);
  const changedAdvanced = useMemo(() => advancedBlocks.filter((block) => (advancedDrafts[block.id] ?? block.raw) !== block.raw && !pendingDeletes.includes(block.id)), [advancedBlocks, advancedDrafts, pendingDeletes]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3StructurePanel{position:fixed;z-index:12140;top:112px;right:14px;width:min(520px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}
.kpoparkiveVe3StructureHeader,.kpoparkiveVe3StructureTabs,.kpoparkiveVe3StructureBody{padding:12px 14px}.kpoparkiveVe3StructureHeader{display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3StructureHeader>div{display:grid;gap:2px}.kpoparkiveVe3StructureHeader strong{color:#5832c6}.kpoparkiveVe3StructureHeader span{font-size:11px;color:#82768e}.kpoparkiveVe3StructureHeader button,.kpoparkiveVe3StructureTabs button,.kpoparkiveVe3StructureBody button,.kpoparkiveVe3StructureBody select,.kpoparkiveVe3StructureBody input,.kpoparkiveVe3StructureBody textarea{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3StructureHeader button{width:32px;height:32px;font-size:20px;cursor:pointer}
.kpoparkiveVe3StructureTabs{display:flex;gap:7px;border-bottom:1px solid #eee9f4}.kpoparkiveVe3StructureTabs button{height:34px;padding:0 11px;cursor:pointer;font-weight:800}.kpoparkiveVe3StructureTabs button.active{border-color:#6b3ce8;color:#5832c6;background:#f4f0ff}.kpoparkiveVe3StructureBody{display:grid;gap:11px}.kpoparkiveVe3StructureBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3StructureBody input,.kpoparkiveVe3StructureBody select{height:36px;padding:0 9px;min-width:0}.kpoparkiveVe3StructureBody textarea{min-height:112px;padding:9px;resize:vertical;line-height:1.45}.kpoparkiveVe3StructureGrid{display:grid;grid-template-columns:1fr 1fr;gap:8px}.kpoparkiveVe3StructureActions{display:flex;justify-content:flex-end;gap:8px}.kpoparkiveVe3StructureActions button{height:36px;padding:0 12px;cursor:pointer;font-weight:800}.kpoparkiveVe3StructureActions .primary{border-color:#6b3ce8;background:#6b3ce8;color:#fff}.kpoparkiveVe3StructureList{display:grid;gap:6px}.kpoparkiveVe3StructureRow{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;padding:8px;border:1px solid #ece7f2;border-radius:8px}.kpoparkiveVe3StructureRow div{min-width:0;display:grid;gap:2px}.kpoparkiveVe3StructureRow b{font-size:11px}.kpoparkiveVe3StructureRow span{font-size:11px;color:#82768e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kpoparkiveVe3StructureRow button{height:32px;padding:0 9px;cursor:pointer}.kpoparkiveVe3StructureRow button.danger{color:#a22a3c}.kpoparkiveVe3PendingDelete{outline:2px solid rgba(180,45,65,.7)!important;opacity:.42!important}.kpoparkiveVe3StructureNote{font-size:11px;color:#82768e;line-height:1.5}.kpoparkiveVe3StructureDirty{color:#6b3ce8;font-weight:800}
@media(max-width:760px){.kpoparkiveVe3StructurePanel{top:150px;max-height:calc(100vh - 164px)}.kpoparkiveVe3StructureGrid{grid-template-columns:1fr}}
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
      setBlocks([]); setPanelOpen(false); setPendingInserts([]); setPendingDeletes([]); setAdvancedDrafts({}); setAnchorId(""); setAdvancedId("");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as Payload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load structure AST");
        const next = sectionedBlocks(payload.ast?.blocks || []);
        setBlocks(next);
        const first = next.find((block) => block.type !== "whitespace");
        setAnchorId(first?.id || "");
        const raw = next.filter((block) => ADVANCED.has(block.type));
        setAdvancedDrafts(Object.fromEntries(raw.map((block) => [block.id, block.raw])));
        setAdvancedId(raw[0]?.id || "");
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[VisualEditorV3StructureBridge]", error);
      }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    const unregister = registerV3OperationProvider("structure", () => {
      const operations: V3RegisteredOperation[] = [];
      for (const block of changedAdvanced) operations.push({ op: "replace-raw", nodeId: block.id, wikitext: advancedDrafts[block.id] });
      for (const nodeId of pendingDeletes) operations.push({ op: "delete-node", nodeId });
      for (const item of pendingInserts) operations.push({ op: "insert-block", anchorNodeId: item.anchorNodeId, position: item.position, wikitext: item.wikitext });
      return operations;
    });
    return unregister;
  }, [editing, changedAdvanced, advancedDrafts, pendingDeletes, pendingInserts]);

  useEffect(() => { if (editing) decorateDeleted(pendingDeletes); return () => decorateDeleted([]); }, [editing, pendingDeletes]);

  const toggleDelete = (nodeId: string) => {
    const block = blocks.find((item) => item.id === nodeId);
    if (!block || !DELETABLE.has(block.type)) return;
    setPendingDeletes((current) => current.includes(nodeId) ? current.filter((id) => id !== nodeId) : [...current, nodeId]);
  };

  useEffect(() => {
    const remove = () => { document.getElementById(BUTTON_ID)?.remove(); document.getElementById(DELETE_BUTTON_ID)?.remove(); };
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar) return;
      let insert = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
      if (!insert) {
        insert = document.createElement("button"); insert.id = BUTTON_ID; insert.type = "button"; insert.title = "Insert or manage structural wiki blocks";
        insert.addEventListener("mousedown", (event) => event.preventDefault());
        insert.addEventListener("click", () => { const active = activeNodeId(); if (active && blocks.some((block) => block.id === active)) setAnchorId(active); setTab("insert"); setPanelOpen((value) => !value); });
        const templates = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Templates");
        (templates || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", insert);
      }
      insert.textContent = `Insert${pendingInserts.length ? ` (${pendingInserts.length})` : ""}`;

      let removeButton = document.getElementById(DELETE_BUTTON_ID) as HTMLButtonElement | null;
      if (!removeButton) {
        removeButton = document.createElement("button"); removeButton.id = DELETE_BUTTON_ID; removeButton.type = "button"; removeButton.title = "Delete the active AST block";
        removeButton.addEventListener("mousedown", (event) => event.preventDefault());
        removeButton.addEventListener("click", () => {
          const id = activeNodeId();
          const block = blocks.find((item) => item.id === id);
          if (!block || !DELETABLE.has(block.type)) { setTab("blocks"); setPanelOpen(true); return; }
          toggleDelete(block.id);
        });
        insert.insertAdjacentElement("afterend", removeButton);
      }
      removeButton.textContent = pendingDeletes.length ? `Delete (${pendingDeletes.length})` : "Delete block";
    };
    ensure();
    const observer = new MutationObserver(ensure); observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); remove(); };
  }, [editing, blocks, pendingInserts.length, pendingDeletes.length]);

  const addInsert = () => {
    if (!anchorId) { window.alert("Choose where to insert the new block."); return; }
    try {
      const built = buildInsert(kind, form);
      setPendingInserts((current) => [...current, { id: `${Date.now()}-${Math.random()}`, anchorNodeId: anchorId, position, wikitext: built.wikitext, label: built.label }]);
      setForm((current) => ({ ...current, text: "", name: "", args: "", target: "" }));
    } catch (error) { window.alert(error instanceof Error ? error.message : "Could not create block"); }
  };

  if (!editing || !panelOpen) return null;
  const selectedAdvanced = advancedBlocks.find((block) => block.id === advancedId) || null;
  return <aside className="kpoparkiveVe3StructurePanel" aria-label="Structure editor">
    <div className="kpoparkiveVe3StructureHeader"><div><strong>Structure editor</strong><span>{pendingInserts.length} insert · {pendingDeletes.length} delete · {changedAdvanced.length} advanced source change</span></div><button type="button" onClick={() => setPanelOpen(false)}>×</button></div>
    <div className="kpoparkiveVe3StructureTabs">
      {(["insert", "blocks", "advanced"] as Tab[]).map((value) => <button type="button" key={value} className={tab === value ? "active" : ""} onClick={() => setTab(value)}>{value === "insert" ? "Insert" : value === "blocks" ? "Blocks" : "Advanced"}</button>)}
    </div>
    {tab === "insert" ? <div className="kpoparkiveVe3StructureBody">
      <label>Anchor<select value={anchorId} onChange={(event) => setAnchorId(event.target.value)}>{semanticBlocks.map((block, index) => <option value={block.id} key={block.id}>{index + 1}. §{block.sectionIndex} · {block.type} · {shortRaw(block)}</option>)}</select></label>
      <div className="kpoparkiveVe3StructureGrid"><label>Position<select value={position} onChange={(event) => setPosition(event.target.value as "before" | "after")}><option value="before">Before</option><option value="after">After</option></select></label><label>Block type<select value={kind} onChange={(event) => setKind(event.target.value as InsertKind)}>{["paragraph","heading","list","table","template","image","youtube","divider"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label></div>
      {kind === "paragraph" || kind === "heading" || kind === "list" ? <label>{kind === "list" ? "Items (one per line)" : "Text"}<textarea value={form.text || ""} onChange={(event) => setForm((current) => ({ ...current, text: event.target.value }))} />{kind === "heading" ? <select value={form.level || "2"} onChange={(event) => setForm((current) => ({ ...current, level: event.target.value }))}>{[2,3,4,5,6].map((level) => <option key={level} value={level}>H{level}</option>)}</select> : null}</label> : null}
      {kind === "table" ? <div className="kpoparkiveVe3StructureGrid"><label>Rows<input type="number" min="1" max="12" value={form.rows || "2"} onChange={(event) => setForm((current) => ({ ...current, rows: event.target.value }))} /></label><label>Columns<input type="number" min="1" max="8" value={form.columns || "2"} onChange={(event) => setForm((current) => ({ ...current, columns: event.target.value }))} /></label></div> : null}
      {kind === "template" ? <><label>Template name<input value={form.name || ""} placeholder="틀:그룹 정보" onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} /></label><label>Arguments<input value={form.args || ""} placeholder="name=value,other=value" onChange={(event) => setForm((current) => ({ ...current, args: event.target.value }))} /></label></> : null}
      {kind === "image" || kind === "youtube" ? <><label>{kind === "image" ? "Filename" : "Video ID"}<input value={form.target || ""} onChange={(event) => setForm((current) => ({ ...current, target: event.target.value }))} /></label><div className="kpoparkiveVe3StructureGrid"><label>Width<input value={form.width || ""} placeholder="640" onChange={(event) => setForm((current) => ({ ...current, width: event.target.value }))} /></label>{kind === "youtube" ? <label>Height<input value={form.height || ""} placeholder="360" onChange={(event) => setForm((current) => ({ ...current, height: event.target.value }))} /></label> : <label>Align<input value={form.align || ""} placeholder="center" onChange={(event) => setForm((current) => ({ ...current, align: event.target.value }))} /></label>}</div></> : null}
      <div className="kpoparkiveVe3StructureActions"><button type="button" className="primary" onClick={addInsert}>Add to pending edits</button></div>
      {pendingInserts.length ? <div className="kpoparkiveVe3StructureList">{pendingInserts.map((item) => <div className="kpoparkiveVe3StructureRow" key={item.id}><div><b>{item.position} selected block</b><span>{item.label}</span></div><button type="button" className="danger" onClick={() => setPendingInserts((current) => current.filter((entry) => entry.id !== item.id))}>Remove</button></div>)}</div> : null}
      <div className="kpoparkiveVe3StructureNote">Insertions are validated as exactly one NamuMark structural block before the proposal is accepted. They do not mutate the captured source directly.</div>
    </div> : null}
    {tab === "blocks" ? <div className="kpoparkiveVe3StructureBody"><div className="kpoparkiveVe3StructureList">{semanticBlocks.map((block, index) => <div className="kpoparkiveVe3StructureRow" key={block.id}><div><b>{index + 1}. §{block.sectionIndex} · {block.type}</b><span>{shortRaw(block)}</span></div>{DELETABLE.has(block.type) ? <button type="button" className="danger" onClick={() => toggleDelete(block.id)}>{pendingDeletes.includes(block.id) ? "Undo delete" : "Delete"}</button> : <button type="button" disabled>Protected</button>}</div>)}</div><div className="kpoparkiveVe3StructureNote">Deleting a block takes precedence over edits inside that same block. Headings are protected from one-click deletion because deleting a heading changes section ownership; insert a replacement heading first or use source editing.</div></div> : null}
    {tab === "advanced" ? <div className="kpoparkiveVe3StructureBody">{selectedAdvanced ? <><label>Protected block<select value={selectedAdvanced.id} onChange={(event) => setAdvancedId(event.target.value)}>{advancedBlocks.map((block) => <option value={block.id} key={block.id}>§{block.sectionIndex} · {block.type} · {shortRaw(block)}</option>)}</select></label><label>Exact NamuMark<textarea value={advancedDrafts[selectedAdvanced.id] ?? selectedAdvanced.raw} onChange={(event) => setAdvancedDrafts((current) => ({ ...current, [selectedAdvanced.id]: event.target.value }))} spellCheck={false} /></label><div className="kpoparkiveVe3StructureActions"><button type="button" onClick={() => setAdvancedDrafts((current) => ({ ...current, [selectedAdvanced.id]: selectedAdvanced.raw }))}>Reset</button></div><div className="kpoparkiveVe3StructureNote">Advanced mode exists only for syntax the visual AST cannot safely decompose yet. The server still patches the exact selected node range and runs a full lossless AST round-trip before accepting it.</div></> : <div className="kpoparkiveVe3StructureNote">No protected styled/raw blocks were found.</div>}</div> : null}
  </aside>;
}
