"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyNamuMediaChanges, type NamuMediaChanges } from "../../lib/namumarkMediaAst";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type MediaParam = {
  id: string;
  index: number;
  name: string | null;
  positional: boolean;
  valueRaw: string;
  editable: boolean;
  lockedReason: string | null;
};

type MediaItem = {
  ownerType: "document" | "table";
  ownerNodeId: string;
  nodeId: string | null;
  callId: string | null;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  kind: "file" | "youtube" | "video-macro";
  macroName: string;
  target: string;
  paramCount: number;
  editableParamCount: number;
  params: MediaParam[];
};

type MediaPayload = { ok?: boolean; media?: MediaItem[]; error?: string };
type AddedParam = { localId: string; name: string; value: string };
type MediaDraft = { target: string; params: Record<string, string>; removed: string[]; added: AddedParam[] };
type DraftMap = Record<string, MediaDraft>;
type MediaOperationResult =
  | { kind: "document"; operation: V3RegisteredOperation }
  | { kind: "table"; ownerNodeId: string; call: Record<string, unknown> };

const EDITING_CLASS = "kpoparkiveAstEditing";
const BUTTON_ID = "kpoparkive-ve3-media-button";
const STYLE_ID = "kpoparkive-ve3-media-style";

function mediaKey(item: MediaItem) {
  return `${item.ownerType}:${item.ownerNodeId}:${item.nodeId || item.callId || item.sourceStart}`;
}

function initialDraft(item: MediaItem): MediaDraft {
  return {
    target: item.target,
    params: Object.fromEntries(item.params.map((param) => [param.id, param.valueRaw])),
    removed: [],
    added: [],
  };
}

function normalize(value: string) {
  return value.normalize("NFKC").replace(/^\s*(?:파일|File):/i, "").replace(/\s+/g, "").toLowerCase();
}

function sectionNumberFromEditLink(anchor: HTMLAnchorElement) {
  try {
    const url = new URL(anchor.href, window.location.href);
    const value = url.searchParams.get("section");
    const parsed = value ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch { return null; }
}

function sectionRoots() {
  const roots = new Map<number, HTMLElement>();
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="section="]'))) {
    const section = sectionNumberFromEditLink(anchor);
    if (section === null || roots.has(section)) continue;
    const heading = anchor.closest<HTMLElement>(".wiki-heading");
    let sibling = heading?.nextElementSibling || null;
    while (sibling) {
      if (sibling.classList.contains("wiki-heading-content")) { roots.set(section, sibling as HTMLElement); break; }
      if (sibling.classList.contains("wiki-heading")) break;
      sibling = sibling.nextElementSibling;
    }
  }
  return roots;
}

function rootFor(item: MediaItem) {
  const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
  if (!article) return null;
  if (item.sectionIndex === 0) return article;
  return sectionRoots().get(item.sectionIndex) || article;
}

function atomicMediaChip(item: MediaItem) {
  if (item.ownerType !== "document" || !item.nodeId || item.nodeId === item.ownerNodeId) return null;
  return document.querySelector<HTMLElement>(`[data-ve3-atomic-node-id="${CSS.escape(item.nodeId)}"]`);
}

function candidateScore(item: MediaItem, element: HTMLElement) {
  const target = normalize(item.target);
  if (!target) return 0;
  const alt = normalize(element.getAttribute("alt") || "");
  const title = normalize(element.getAttribute("title") || "");
  const src = normalize(element.getAttribute("src") || element.getAttribute("data-src") || element.getAttribute("data-video-src") || element.getAttribute("href") || "");
  if (item.kind === "file") {
    if (alt === target) return 1;
    if (alt && (alt.includes(target) || target.includes(alt))) return .88;
    if (title === target) return .83;
    if (src.includes(target)) return .72;
    return 0;
  }
  if (src.includes(target)) return 1;
  if (title.includes(target)) return .74;
  return 0;
}

function decorateMedia(items: MediaItem[]) {
  for (const old of Array.from(document.querySelectorAll<HTMLElement>("[data-ve3-media-key]"))) {
    if (old.dataset.ve3AtomicNodeId) continue;
    old.removeAttribute("data-ve3-media-key");
    old.classList.remove("kpoparkiveVe3MediaTarget");
  }
  const mapped = new Map<string, HTMLElement>();
  const claimed = new Set<HTMLElement>();
  for (const item of [...items].sort((a, b) => a.sourceStart - b.sourceStart)) {
    const atomic = atomicMediaChip(item);
    if (atomic) {
      const key = mediaKey(item);
      atomic.dataset.ve3MediaKey = key;
      atomic.classList.add("kpoparkiveVe3MediaTarget");
      mapped.set(key, atomic);
      continue;
    }
    const root = rootFor(item);
    if (!root) continue;
    const selector = item.kind === "file"
      ? "img,video,[data-video-src]"
      : "iframe,video,a[href*='youtube'],a[href*='youtu'],[data-video-src]";
    const scored = Array.from(root.querySelectorAll<HTMLElement>(selector))
      .filter((element) => !claimed.has(element) && !element.closest(".kpoparkiveAstToolbar,.kpoparkiveVe3MediaPanel"))
      .map((element) => ({ element, score: candidateScore(item, element) }))
      .filter((entry) => entry.score >= .7)
      .sort((a, b) => b.score - a.score);
    if (!scored.length) continue;
    if (scored[1] && scored[0].score < .9 && scored[1].score >= scored[0].score - .05) continue;
    const element = scored[0].element;
    const key = mediaKey(item);
    element.dataset.ve3MediaKey = key;
    element.classList.add("kpoparkiveVe3MediaTarget");
    claimed.add(element);
    mapped.set(key, element);
  }
  return mapped;
}

function draftChanged(item: MediaItem, draft: MediaDraft | undefined) {
  if (!draft) return false;
  if (draft.target.trim() !== item.target) return true;
  if (draft.removed.length || draft.added.some((entry) => entry.name.trim())) return true;
  return item.params.some((param) => (draft.params[param.id] ?? param.valueRaw) !== param.valueRaw);
}

function mediaChanges(item: MediaItem, draft: MediaDraft): NamuMediaChanges {
  const params = item.params
    .filter((param) => param.editable && !draft.removed.includes(param.id))
    .map((param) => ({ paramId: param.id, proposedValue: draft.params[param.id] ?? param.valueRaw }))
    .filter((change) => item.params.find((param) => param.id === change.paramId)?.valueRaw !== change.proposedValue);
  const appendParams = draft.added
    .map((entry) => ({ name: entry.name.trim(), value: entry.value.trim() }))
    .filter((entry) => entry.name);
  return {
    target: draft.target.trim() !== item.target ? draft.target.trim() : undefined,
    params: params.length ? params : undefined,
    removeParamIds: draft.removed.length ? draft.removed : undefined,
    appendParams: appendParams.length ? appendParams : undefined,
  };
}

function operationFor(item: MediaItem, draft: MediaDraft): MediaOperationResult {
  const changes = mediaChanges(item, draft);
  if (item.ownerType === "table") {
    return { kind: "table", ownerNodeId: item.ownerNodeId, call: { callId: item.callId!, ...changes } };
  }
  return {
    kind: "document",
    operation: { op: "media-fields", nodeId: item.nodeId!, ...changes } as V3RegisteredOperation,
  };
}

function collectOperations(items: MediaItem[], drafts: DraftMap) {
  const operations: V3RegisteredOperation[] = [];
  const tableCalls = new Map<string, Array<Record<string, unknown>>>();
  for (const item of items) {
    const draft = drafts[mediaKey(item)];
    if (!draft || !draftChanged(item, draft)) continue;
    const atomic = atomicMediaChip(item);
    if (atomic) {
      const syncError = atomic.dataset.ve3AtomicMediaSyncError;
      if (syncError) throw new Error(syncError);
      continue;
    }
    const result = operationFor(item, draft);
    if (result.kind === "document") {
      operations.push(result.operation);
    } else {
      const list = tableCalls.get(result.ownerNodeId) || [];
      list.push(result.call);
      tableCalls.set(result.ownerNodeId, list);
    }
  }
  for (const [nodeId, mediaCalls] of tableCalls.entries()) operations.push({ op: "table-media", nodeId, mediaCalls });
  return operations;
}

export default function VisualEditorV3MediaBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [drafts, setDrafts] = useState<DraftMap>({});
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [mappedCount, setMappedCount] = useState(0);
  const mappedRef = useRef<Map<string, HTMLElement>>(new Map());
  const selected = useMemo(() => items.find((item) => mediaKey(item) === selectedKey) || items[0] || null, [items, selectedKey]);
  const dirtyCount = useMemo(() => items.filter((item) => draftChanged(item, drafts[mediaKey(item)])).length, [items, drafts]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
.kpoparkiveVe3MediaTarget { outline: 2px solid rgba(107,60,232,.42) !important; outline-offset: 3px; cursor: pointer !important; }
.kpoparkiveVe3MediaTarget:hover { outline-color: rgba(107,60,232,.9) !important; }
.kpoparkiveVe3MediaPanel { position: fixed; z-index: 12130; top: 112px; right: 14px; width: min(470px, calc(100vw - 28px)); max-height: calc(100vh - 128px); overflow: auto; border: 1px solid #d8d0eb; border-radius: 12px; background: rgba(255,255,255,.99); box-shadow: 0 18px 55px rgba(39,28,70,.22); color: #342c40; }
.kpoparkiveVe3MediaHeader,.kpoparkiveVe3MediaPicker,.kpoparkiveVe3MediaBody { padding: 12px 14px; }
.kpoparkiveVe3MediaHeader { display:flex;align-items:center;justify-content:space-between;gap:10px;border-bottom:1px solid #e6e0ef;background:#fbf9ff; }
.kpoparkiveVe3MediaHeader>div { display:grid;gap:2px; }.kpoparkiveVe3MediaHeader strong{color:#5832c6}.kpoparkiveVe3MediaHeader span{font-size:11px;color:#82768e}
.kpoparkiveVe3MediaHeader button,.kpoparkiveVe3MediaPicker button,.kpoparkiveVe3MediaPicker select,.kpoparkiveVe3MediaBody input,.kpoparkiveVe3MediaBody button { border:1px solid #dcd5e8;border-radius:8px;background:#fff;color:#352e40;font:inherit; }
.kpoparkiveVe3MediaHeader button{width:32px;height:32px;font-size:20px;cursor:pointer}.kpoparkiveVe3MediaPicker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}.kpoparkiveVe3MediaPicker select{height:36px;min-width:0;padding:0 8px}.kpoparkiveVe3MediaPicker button{padding:0 10px;cursor:pointer}
.kpoparkiveVe3MediaBody{display:grid;gap:12px;border-top:1px solid #eee9f4}.kpoparkiveVe3MediaBody label{display:grid;gap:5px;font-size:12px;font-weight:800}.kpoparkiveVe3MediaBody input{height:36px;padding:0 9px;min-width:0}.kpoparkiveVe3MediaParam{display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:7px;align-items:center}.kpoparkiveVe3MediaParam code{font-size:11px;overflow:hidden;text-overflow:ellipsis}.kpoparkiveVe3MediaParam button{height:34px;padding:0 9px;cursor:pointer}.kpoparkiveVe3MediaParam.locked{opacity:.62}.kpoparkiveVe3MediaAdd{display:grid;grid-template-columns:110px minmax(0,1fr) auto;gap:7px}.kpoparkiveVe3MediaMeta{font-size:11px;color:#82768e;line-height:1.45}.kpoparkiveVe3MediaDirty{color:#6b3ce8;font-weight:800}.kpoparkiveVe3MediaRemove{color:#a22a3c}.kpoparkiveVe3MediaFooter{display:flex;justify-content:flex-end;gap:8px}.kpoparkiveVe3MediaFooter button{height:36px;padding:0 12px;cursor:pointer;font-weight:800}
@media(max-width:760px){.kpoparkiveVe3MediaPanel{top:150px;max-height:calc(100vh - 164px)}.kpoparkiveVe3MediaParam,.kpoparkiveVe3MediaAdd{grid-template-columns:90px minmax(0,1fr) auto}}
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
      setItems([]); setDrafts({}); setSelectedKey(null); setPanelOpen(false); setMappedCount(0);
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store", signal: controller.signal });
        const payload = await response.json() as MediaPayload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load media AST");
        const media = payload.media || [];
        setItems(media);
        setDrafts(Object.fromEntries(media.map((item) => [mediaKey(item), initialDraft(item)])));
        setSelectedKey(media[0] ? mediaKey(media[0]) : null);
      } catch (error) {
        if (!controller.signal.aborted) console.warn("[VisualEditorV3MediaBridge]", error);
      }
    })();
    return () => controller.abort();
  }, [editing, title]);

  useEffect(() => {
    if (!editing) return;
    const sync = () => {
      for (const item of items) {
        const chip = atomicMediaChip(item);
        if (!chip || chip.dataset.ve3AtomicDeleted === "1") continue;
        const originalRaw = chip.dataset.ve3AtomicOriginalRaw || chip.dataset.ve3AtomicRaw || "";
        const draft = drafts[mediaKey(item)] || initialDraft(item);
        try {
          const proposed = draftChanged(item, draft)
            ? applyNamuMediaChanges(originalRaw, mediaChanges(item, draft)).proposed
            : originalRaw;
          chip.dataset.ve3AtomicRaw = proposed;
          if (proposed !== originalRaw) {
            const surface = chip.closest<HTMLElement>(".kpoparkiveVe3AtomicSurface");
            if (surface) surface.dataset.ve3Dirty = "1";
          }
          delete chip.dataset.ve3AtomicMediaSyncError;
        } catch (error) {
          chip.dataset.ve3AtomicMediaSyncError = error instanceof Error ? error.message : "Could not synchronize inline media";
        }
      }
    };
    sync();
    window.addEventListener("kpoparkive-ve3-atomic-media-sync", sync);
    window.addEventListener("kpoparkive-ve3-atomic-surfaces-ready", sync);
    return () => {
      window.removeEventListener("kpoparkive-ve3-atomic-media-sync", sync);
      window.removeEventListener("kpoparkive-ve3-atomic-surfaces-ready", sync);
    };
  }, [editing, items, drafts]);

  useEffect(() => {
    if (!editing) return;
    const unregister = registerV3OperationProvider("media", () => collectOperations(items, drafts));
    return unregister;
  }, [editing, items, drafts]);

  useEffect(() => {
    if (!editing || !items.length) return;
    let queued = false;
    const decorate = () => {
      queued = false;
      mappedRef.current = decorateMedia(items);
      setMappedCount(mappedRef.current.size);
    };
    const queue = () => { if (!queued) { queued = true; requestAnimationFrame(decorate); } };
    queue();
    const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
    if (!article) return;
    const observer = new MutationObserver(queue);
    observer.observe(article, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "alt", "data-video-src"] });
    return () => observer.disconnect();
  }, [editing, items]);

  useEffect(() => {
    if (!editing) return;
    const click = (event: MouseEvent) => {
      const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-ve3-media-key]") : null;
      const key = element?.dataset.ve3MediaKey;
      if (!key) return;
      event.preventDefault(); event.stopImmediatePropagation();
      setSelectedKey(key); setPanelOpen(true);
    };
    document.addEventListener("click", click, true);
    return () => document.removeEventListener("click", click, true);
  }, [editing]);

  useEffect(() => {
    const remove = () => document.getElementById(BUTTON_ID)?.remove();
    if (!editing) { remove(); return; }
    const ensure = () => {
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar) return;
      let button = document.getElementById(BUTTON_ID) as HTMLButtonElement | null;
      if (!button) {
        button = document.createElement("button");
        button.id = BUTTON_ID; button.type = "button"; button.title = "Edit images and video embeds";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => setPanelOpen((value) => !value));
        const templates = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent?.trim() === "Templates");
        (templates || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", button);
      }
      button.disabled = !items.length;
      button.textContent = `Media (${items.length}${dirtyCount ? ` · ${dirtyCount}*` : ""})`;
    };
    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { subtree: true, childList: true });
    return () => { observer.disconnect(); remove(); };
  }, [editing, items.length, dirtyCount]);

  const updateDraft = (key: string, updater: (draft: MediaDraft) => MediaDraft) => {
    setDrafts((current) => ({ ...current, [key]: updater(current[key] || initialDraft(items.find((item) => mediaKey(item) === key)!)) }));
  };

  if (!editing || !panelOpen) return null;
  return (
    <aside className="kpoparkiveVe3MediaPanel" aria-label="Media inspector">
      <div className="kpoparkiveVe3MediaHeader">
        <div><strong>Media inspector</strong><span>{mappedCount}/{items.length} mapped visually · {dirtyCount} changed</span></div>
        <button type="button" onClick={() => setPanelOpen(false)} aria-label="Close media inspector">×</button>
      </div>
      {selected ? (() => {
        const key = mediaKey(selected);
        const draft = drafts[key] || initialDraft(selected);
        return <>
          <div className="kpoparkiveVe3MediaPicker">
            <select value={key} onChange={(event) => setSelectedKey(event.target.value)} aria-label="Media item">
              {items.map((item, index) => <option key={mediaKey(item)} value={mediaKey(item)}>{index + 1}. {item.macroName} · §{item.sectionIndex} · {item.target.slice(0, 45)}</option>)}
            </select>
            <button type="button" onClick={() => (mappedRef.current.get(key) || rootFor(selected))?.scrollIntoView({ behavior: "smooth", block: "center" })}>Go to media</button>
          </div>
          <div className="kpoparkiveVe3MediaBody">
            <div className="kpoparkiveVe3MediaMeta">{selected.ownerType === "table" ? "Inside table · changes merge atomically with table text/template edits." : "Document media AST node."} {draftChanged(selected, draft) ? <span className="kpoparkiveVe3MediaDirty">Unsaved changes</span> : null}</div>
            <label>Target<input value={draft.target} onChange={(event) => updateDraft(key, (current) => ({ ...current, target: event.target.value }))} spellCheck={false} /></label>
            {selected.params.map((param) => {
              const removed = draft.removed.includes(param.id);
              return <div key={param.id} className={`kpoparkiveVe3MediaParam${param.editable ? "" : " locked"}`}>
                <code title={param.name || param.lockedReason || "option"}>{param.name || `#${param.index}`}</code>
                <input disabled={!param.editable || removed} value={draft.params[param.id] ?? param.valueRaw} onChange={(event) => updateDraft(key, (current) => ({ ...current, params: { ...current.params, [param.id]: event.target.value } }))} />
                <button type="button" className="kpoparkiveVe3MediaRemove" disabled={!param.editable} onClick={() => updateDraft(key, (current) => ({ ...current, removed: current.removed.includes(param.id) ? current.removed.filter((id) => id !== param.id) : [...current.removed, param.id] }))}>{removed ? "Undo" : "Remove"}</button>
              </div>;
            })}
            {draft.added.map((entry) => <div className="kpoparkiveVe3MediaAdd" key={entry.localId}>
              <input placeholder="option" value={entry.name} onChange={(event) => updateDraft(key, (current) => ({ ...current, added: current.added.map((item) => item.localId === entry.localId ? { ...item, name: event.target.value } : item) }))} />
              <input placeholder="value" value={entry.value} onChange={(event) => updateDraft(key, (current) => ({ ...current, added: current.added.map((item) => item.localId === entry.localId ? { ...item, value: event.target.value } : item) }))} />
              <button type="button" className="kpoparkiveVe3MediaRemove" onClick={() => updateDraft(key, (current) => ({ ...current, added: current.added.filter((item) => item.localId !== entry.localId) }))}>×</button>
            </div>)}
            <div className="kpoparkiveVe3MediaFooter">
              <button type="button" onClick={() => updateDraft(key, () => initialDraft(selected))}>Reset</button>
              <button type="button" onClick={() => updateDraft(key, (current) => ({ ...current, added: [...current.added, { localId: `${Date.now()}-${Math.random()}`, name: "", value: "" }] }))}>Add option</button>
              <button type="button" onClick={() => setPanelOpen(false)}>Done</button>
            </div>
          </div>
        </>;
      })() : <div className="kpoparkiveVe3MediaBody">No editable media was found.</div>}
    </aside>
  );
}
