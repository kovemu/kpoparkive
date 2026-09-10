"use client";

import { useEffect, useMemo, useState } from "react";
import { applyVisualCommand } from "../../lib/wikiVisualEdit";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type AstInline = { id: string; type: string; raw: string; body?: string; sourceStart?: number; sourceEnd?: number; children?: AstInline[] };
type AstBlock = { id: string; type: string; children?: AstInline[]; lines?: Array<{ children: AstInline[] }> };
type FootnotePayload = { ok?: boolean; ast?: { blocks?: AstBlock[] }; error?: string };
type V3Footnote = {
  nodeId: string;
  parentNodeId: string;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  raw: string;
  body: string;
  editable: boolean;
  lockedReason: string | null;
};

const STYLE_ID = "kpoparkive-ve3-footnote-bridge-style";
const TOOLBAR_BUTTON_ID = "kpoparkive-ve3-footnotes-button";
const CITE_BUTTON_ID = "kpoparkive-ve3-cite-button";
const EDITING_CLASS = "kpoparkiveAstEditing";

function extractFootnotes(payload: FootnotePayload) {
  const output: V3Footnote[] = [];
  let sectionIndex = 0;
  const visit = (nodes: AstInline[], parentNodeId: string) => {
    for (const node of nodes) {
      if (node.type === "footnote") {
        const body = String(node.body ?? "").trim();
        const reason = !body ? "Empty footnote" : body.length > 20_000 ? "Footnote is too large" : /\r|\n/.test(body) ? "Multiline footnote" : null;
        output.push({
          nodeId: node.id,
          parentNodeId,
          sectionIndex,
          sourceStart: Number(node.sourceStart || 0),
          sourceEnd: Number(node.sourceEnd || 0),
          raw: node.raw,
          body,
          editable: !reason,
          lockedReason: reason,
        });
      }
      if (node.children?.length) visit(node.children, parentNodeId);
    }
  };
  for (const block of payload.ast?.blocks || []) {
    if (block.type === "heading") {
      sectionIndex += 1;
      if (block.children?.length) visit(block.children, block.id);
      continue;
    }
    if (block.children?.length) visit(block.children, block.id);
    for (const line of block.lines || []) visit(line.children || [], block.id);
  }
  return output.sort((a, b) => a.sourceStart - b.sourceStart);
}

function editorSurfaceForNode(nodeId: string) {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-ve3-node-id]"))
    .find((element) => element.dataset.ve3NodeId === nodeId && element.isContentEditable) || null;
}

function markerFor(footnote: V3Footnote) {
  const surface = editorSurfaceForNode(footnote.parentNodeId);
  if (!surface) return null;
  return Array.from(surface.querySelectorAll<HTMLElement>("span[data-ve3-footnote-id]"))
    .find((element) => element.dataset.ve3FootnoteId === footnote.nodeId) || null;
}

function activeVisualSurface() {
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const selected = element?.closest<HTMLElement>(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface");
  if (selected?.isContentEditable) return selected;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  return active?.matches(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface") && active.isContentEditable ? active : null;
}

function rebuildFootnoteRaw(originalRaw: string, bodyValue: string) {
  const body = bodyValue.trim();
  const inner = originalRaw.startsWith("[*") && originalRaw.endsWith("]") ? originalRaw.slice(2, -1) : " ";
  const leading = inner.match(/^\s*/)?.[0] || "";
  const trailing = inner.match(/\s*$/)?.[0] || "";
  return `[*${leading}${body}${trailing}]`;
}

function decorateFootnotes(footnotes: V3Footnote[]) {
  const mapped = new Set<string>();
  const groups = new Map<string, V3Footnote[]>();
  for (const footnote of footnotes) groups.set(footnote.parentNodeId, [...(groups.get(footnote.parentNodeId) || []), footnote]);
  for (const [parentNodeId, items] of groups.entries()) {
    const surface = editorSurfaceForNode(parentNodeId);
    if (!surface) continue;
    const citations = Array.from(surface.querySelectorAll<HTMLElement>("span[data-wiki-footnote]"));
    const claimed = new Set<HTMLElement>();
    for (const footnote of [...items].sort((a, b) => a.sourceStart - b.sourceStart)) {
      const existing = citations.find((citation) => citation.dataset.ve3FootnoteId === footnote.nodeId);
      if (existing) { mapped.add(footnote.nodeId); claimed.add(existing); continue; }
      const citation = citations.find((candidate) => !claimed.has(candidate) && candidate.dataset.wikiFootnote === footnote.raw);
      if (!citation) continue;
      citation.dataset.ve3FootnoteId = footnote.nodeId;
      citation.classList.add("kpoparkiveVe3FootnoteMarker");
      citation.title = footnote.body || "Footnote";
      claimed.add(citation);
      mapped.add(footnote.nodeId);
    }
  }
  return mapped;
}

function sectionRoot(sectionIndex: number) {
  if (sectionIndex === 0) return document.querySelector<HTMLElement>(".thetreeWikiBaseline");
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="section="]'))) {
    try {
      const section = Number(new URL(anchor.href, window.location.href).searchParams.get("section"));
      if (section !== sectionIndex) continue;
      const heading = anchor.closest<HTMLElement>(".wiki-heading");
      let sibling = heading?.nextElementSibling || null;
      while (sibling) {
        if (sibling.classList.contains("wiki-heading-content")) return sibling as HTMLElement;
        if (sibling.classList.contains("wiki-heading")) break;
        sibling = sibling.nextElementSibling;
      }
    } catch { /* ignore malformed edit link */ }
  }
  return null;
}

export default function VisualEditorV3FootnoteBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [footnotes, setFootnotes] = useState<V3Footnote[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mappedIds, setMappedIds] = useState<Set<string>>(new Set());
  const [deletedIds, setDeletedIds] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = useMemo(() => footnotes.find((footnote) => footnote.nodeId === selectedId) || footnotes[0] || null, [footnotes, selectedId]);
  const dirtyCount = useMemo(() => footnotes.filter((footnote) => deletedIds.includes(footnote.nodeId) || (drafts[footnote.nodeId] ?? footnote.body).trim() !== footnote.body).length, [footnotes, drafts, deletedIds]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
+.kpoparkiveVe3FootnoteMarker{cursor:pointer!important;outline:1px dotted rgba(107,60,232,.5);outline-offset:2px;border-radius:3px}.kpoparkiveVe3FootnoteMarker:hover{background:rgba(107,60,232,.09)}.kpoparkiveVe3FootnoteMarker[data-wiki-footnote=""]{opacity:.35;text-decoration:line-through}
+.kpoparkiveVe3FootnotePanel{position:fixed;z-index:12120;top:112px;right:14px;width:min(450px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}.kpoparkiveVe3FootnoteHeader,.kpoparkiveVe3FootnotePicker,.kpoparkiveVe3FootnoteEditor{padding:12px 14px}.kpoparkiveVe3FootnoteHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}.kpoparkiveVe3FootnoteHeader>div{display:grid;gap:2px}.kpoparkiveVe3FootnoteHeader strong{color:#5832c6}.kpoparkiveVe3FootnoteHeader span{font-size:11px;color:#82768e}.kpoparkiveVe3FootnoteHeader button,.kpoparkiveVe3FootnotePicker button,.kpoparkiveVe3FootnoteEditor button,.kpoparkiveVe3FootnotePicker select,.kpoparkiveVe3FootnoteEditor textarea{border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit}.kpoparkiveVe3FootnoteHeader button{width:32px;height:32px;font-size:20px;cursor:pointer}.kpoparkiveVe3FootnotePicker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.kpoparkiveVe3FootnotePicker select{min-width:0;height:36px;padding:0 8px}.kpoparkiveVe3FootnotePicker button{padding:0 10px;cursor:pointer}.kpoparkiveVe3FootnoteEditor{display:grid;gap:9px;border-top:1px solid #eee9f4}.kpoparkiveVe3FootnoteEditor label{font-size:12px;font-weight:800}.kpoparkiveVe3FootnoteEditor textarea{min-height:118px;padding:9px;resize:vertical;line-height:1.45}.kpoparkiveVe3FootnoteEditor small{color:#82768e;line-height:1.45}.kpoparkiveVe3FootnoteEditor .locked{color:#9a6b36}.kpoparkiveVe3FootnoteActions{display:flex;justify-content:flex-end;gap:8px}.kpoparkiveVe3FootnoteEditor button{height:36px;padding:0 12px;cursor:pointer;font-weight:800}.kpoparkiveVe3FootnoteEditor button.danger{color:#a22a3c}.kpoparkiveVe3FootnoteEditor button:disabled{opacity:.45;cursor:default}@media(max-width:760px){.kpoparkiveVe3FootnotePanel{top:150px;max-height:calc(100vh - 164px)}}
+`;
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
    if (!editing) { setFootnotes([]); setDrafts({}); setMappedIds(new Set()); setDeletedIds([]); setPanelOpen(false); setSelectedId(null); return; }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as FootnotePayload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load footnotes");
        const items = extractFootnotes(payload);
        setFootnotes(items);
        setDrafts(Object.fromEntries(items.map((footnote) => [footnote.nodeId, footnote.body])));
        setSelectedId(items[0]?.nodeId || null);
      } catch (error) { if (!controller.signal.aborted) console.warn("[VisualEditorV3FootnoteBridge]", error); }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing || !footnotes.length) return;
    let queued = false;
    const decorate = () => { queued = false; setMappedIds(decorateFootnotes(footnotes)); };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(decorate); } };
    queue();
    const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
    if (!article) return;
    const observer = new MutationObserver(queue);
    observer.observe(article, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-wiki-footnote"] });
    return () => observer.disconnect();
  }, [editing, footnotes]);

  useEffect(() => {
    if (!editing) return;
    const unregister = registerV3OperationProvider("footnotes", () => {
      const operations: V3RegisteredOperation[] = [];
      for (const footnote of footnotes) {
        if (mappedIds.has(footnote.nodeId)) continue;
        if (deletedIds.includes(footnote.nodeId)) { operations.push({ op: "delete-inline-node", nodeId: footnote.nodeId }); continue; }
        const body = (drafts[footnote.nodeId] ?? footnote.body).trim();
        if (footnote.editable && body && body !== footnote.body) operations.push({ op: "set-footnote", nodeId: footnote.nodeId, body });
      }
      return operations;
    });
    return unregister;
  }, [editing, footnotes, mappedIds, drafts, deletedIds]);

  useEffect(() => {
    if (!editing) return;
    const onClick = (event: MouseEvent) => {
      const marker = event.target instanceof Element ? event.target.closest<HTMLElement>(".kpoparkiveVe3FootnoteMarker[data-ve3-footnote-id]") : null;
      if (!marker?.dataset.ve3FootnoteId) return;
      event.preventDefault(); event.stopPropagation();
      setSelectedId(marker.dataset.ve3FootnoteId); setPanelOpen(true);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [editing]);

  useEffect(() => {
    const removeButtons = () => { document.getElementById(TOOLBAR_BUTTON_ID)?.remove(); document.getElementById(CITE_BUTTON_ID)?.remove(); };
    if (!editing) { removeButtons(); return; }
    const ensureButtons = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar) return;
      let cite = document.getElementById(CITE_BUTTON_ID) as HTMLButtonElement | null;
      if (!cite) {
        cite = document.createElement("button"); cite.id = CITE_BUTTON_ID; cite.type = "button"; cite.textContent = "Cite"; cite.title = "Insert citation / footnote";
        cite.addEventListener("mousedown", (event) => event.preventDefault());
        cite.addEventListener("click", () => { const surface = activeVisualSurface(); if (!surface) { window.alert("Click editable text or a table field first."); return; } applyVisualCommand("citation", surface); });
        const unlink = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "Unlink");
        (unlink || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", cite);
      }
      let button = document.getElementById(TOOLBAR_BUTTON_ID) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button"); button.id = TOOLBAR_BUTTON_ID; button.type = "button"; button.title = "Edit AST footnotes";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => setPanelOpen((value) => !value));
        const templates = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Templates");
        (templates || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", button);
      }
      button.disabled = !footnotes.length;
      button.textContent = `Footnotes (${footnotes.length}${dirtyCount ? ` · ${dirtyCount}*` : ""})`;
    };
    ensureButtons();
    const observer = new MutationObserver(ensureButtons); observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); removeButtons(); };
  }, [editing, footnotes.length, dirtyCount]);

  const updateBody = (footnote: V3Footnote, body: string) => {
    setDrafts((current) => ({ ...current, [footnote.nodeId]: body }));
    if (!mappedIds.has(footnote.nodeId)) return;
    const marker = markerFor(footnote);
    const surface = editorSurfaceForNode(footnote.parentNodeId);
    if (!marker || !surface) return;
    marker.dataset.wikiFootnote = rebuildFootnoteRaw(footnote.raw, body);
    marker.title = body.trim() || "Footnote";
    if (deletedIds.includes(footnote.nodeId)) setDeletedIds((current) => current.filter((id) => id !== footnote.nodeId));
    surface.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const toggleDelete = (footnote: V3Footnote) => {
    const deleting = !deletedIds.includes(footnote.nodeId);
    setDeletedIds((current) => deleting ? [...current, footnote.nodeId] : current.filter((id) => id !== footnote.nodeId));
    if (!mappedIds.has(footnote.nodeId)) return;
    const marker = markerFor(footnote);
    const surface = editorSurfaceForNode(footnote.parentNodeId);
    if (!marker || !surface) return;
    const body = (drafts[footnote.nodeId] ?? footnote.body).trim();
    marker.dataset.wikiFootnote = deleting ? "" : rebuildFootnoteRaw(footnote.raw, body);
    marker.textContent = deleting ? "[citation removed]" : "[citation]";
    marker.title = deleting ? "Footnote pending deletion" : body;
    surface.dispatchEvent(new Event("input", { bubbles: true }));
  };

  const reveal = (footnote: V3Footnote) => (markerFor(footnote) || editorSurfaceForNode(footnote.parentNodeId) || sectionRoot(footnote.sectionIndex))?.scrollIntoView({ behavior: "smooth", block: "center" });

  if (!editing || !panelOpen) return null;
  return <aside className="kpoparkiveVe3FootnotePanel" aria-label="Footnote inspector">
    <div className="kpoparkiveVe3FootnoteHeader"><div><strong>Footnote inspector</strong><span>{mappedIds.size}/{footnotes.length} mapped visually · {dirtyCount} changed</span></div><button type="button" onClick={() => setPanelOpen(false)}>×</button></div>
    {selected ? <><div className="kpoparkiveVe3FootnotePicker"><select value={selected.nodeId} onChange={(event) => setSelectedId(event.target.value)}>{footnotes.map((footnote, index) => <option key={footnote.nodeId} value={footnote.nodeId}>{index + 1}. §{footnote.sectionIndex} · {footnote.body.slice(0, 55)}</option>)}</select><button type="button" onClick={() => reveal(selected)}>Go to note</button></div><div className="kpoparkiveVe3FootnoteEditor">
      <label>Footnote text</label><textarea value={drafts[selected.nodeId] ?? selected.body} disabled={!selected.editable || deletedIds.includes(selected.nodeId)} onChange={(event) => updateBody(selected, event.target.value)} />
      {!selected.editable ? <small className="locked">Protected · {selected.lockedReason || "complex footnote"}</small> : null}
      <small>{mappedIds.has(selected.nodeId) ? "This note is synchronized into its parent visual surface, so surrounding text and the citation save as one source patch." : "This note is not visually mapped; Save will patch its exact footnote AST node range directly."}</small>
      <div className="kpoparkiveVe3FootnoteActions"><button type="button" onClick={() => updateBody(selected, selected.body)}>Reset</button><button type="button" className="danger" onClick={() => toggleDelete(selected)}>{deletedIds.includes(selected.nodeId) ? "Undo delete" : "Delete footnote"}</button><button type="button" onClick={() => setPanelOpen(false)}>Done</button></div>
    </div></> : <div className="kpoparkiveVe3FootnoteEditor"><small>No footnotes were found.</small></div>}
  </aside>;
}
