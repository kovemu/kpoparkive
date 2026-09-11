"use client";

import { useEffect, useRef, useState } from "react";
import { editorElementToWikitext, wikiBlockToEditorHtml } from "../../lib/wikiVisualEdit";
import { registerV3OperationProvider, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

type InlineNode = {
  id: string;
  type: string;
  raw: string;
  sourceStart: number;
  sourceEnd: number;
  children?: InlineNode[];
};

type Block = {
  id: string;
  type: string;
  raw: string;
  sourceStart: number;
  sourceEnd: number;
  children?: InlineNode[];
  lines?: Array<{ children?: InlineNode[] }>;
};

type Payload = { ok?: boolean; ast?: { blocks?: Block[] }; error?: string };
type Atomic = InlineNode & { token: string };
type SurfaceRecord = { nodeId: string; originalWikitext: string; original: HTMLElement; surface: HTMLElement; oldDisplay: string };

const EDITING_CLASS = "kpoparkiveAstEditing";
const STYLE_ID = "kpoparkive-ve3-atomic-text-style";

function normalize(value: string) {
  return value.normalize("NFKC").replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
}

function compact(value: string) {
  return normalize(value).replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
}

function sectionNumberFromEditLink(anchor: HTMLAnchorElement) {
  try {
    const value = new URL(anchor.href, window.location.href).searchParams.get("section");
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

function blocksBySection(blocks: Block[]) {
  const result = new Map<number, Block[]>();
  let section = 0;
  result.set(0, []);
  for (const block of blocks) {
    if (block.type === "heading") { section += 1; if (!result.has(section)) result.set(section, []); continue; }
    result.get(section)?.push(block);
  }
  return result;
}

function collectAtomic(block: Block) {
  const nodes: InlineNode[] = [];
  const visit = (items: InlineNode[] | undefined) => {
    for (const node of items || []) {
      if (node.type === "raw-inline" || node.type === "inline-media") nodes.push(node);
      if (node.children?.length) visit(node.children);
    }
  };
  visit(block.children);
  for (const line of block.lines || []) visit(line.children);
  return nodes
    .filter((node) => block.sourceStart <= node.sourceStart && node.sourceEnd <= block.sourceEnd)
    .sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd)
    .filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && other.sourceStart <= node.sourceStart && node.sourceEnd <= other.sourceEnd));
}

function maskBlock(block: Block) {
  const atomic = collectAtomic(block).map((node, index) => ({ ...node, token: `VE3ATOMIC${index}X${Math.abs(node.sourceStart - block.sourceStart)}END` }));
  let raw = block.raw;
  for (const node of [...atomic].sort((a, b) => b.sourceStart - a.sourceStart)) {
    const start = node.sourceStart - block.sourceStart;
    const end = node.sourceEnd - block.sourceStart;
    raw = `${raw.slice(0, start)}${node.token}${raw.slice(end)}`;
  }
  return { raw, atomic };
}

function simpleStyle(raw: string) {
  const match = raw.match(/^\{\{\{(#[^\s{}]+|[+-]\d+)\s+([\s\S]*)\}\}\}$/);
  if (!match) return null;
  const body = match[2];
  if (!body.trim()) return null;
  if (/\{\{\{|\}\}\}|\[include\(|\[(?:youtube|kakaotv|nicovideo|vimeo|age|dday)\(/i.test(body)) return null;
  if (/\[\[(?:파일|File|분류|Category):/i.test(body) || /\|\|/.test(body) || /\r|\n/.test(body)) return null;
  const bodyStart = raw.indexOf(body);
  return { prefix: raw.slice(0, bodyStart), suffix: raw.slice(bodyStart + body.length), body, styleToken: match[1] };
}

function styleSimpleSpan(span: HTMLElement, token: string) {
  const previewColor = token.split(",")[0]?.trim() || "";
  if (/^#[0-9a-f]{3,8}$/i.test(previewColor)) span.style.color = previewColor;
  const size = token.match(/^([+-])(\d+)$/);
  if (size) {
    const delta = Math.min(5, Number(size[2]));
    const scale = size[1] === "+" ? 1 + delta * .12 : Math.max(.55, 1 - delta * .10);
    span.style.fontSize = `${scale}em`;
  }
}

function replaceToken(node: Text, atomic: Atomic) {
  const index = node.data.indexOf(atomic.token);
  if (index < 0) return false;
  const fragment = document.createDocumentFragment();
  if (index) fragment.append(document.createTextNode(node.data.slice(0, index)));
  const simple = atomic.type === "raw-inline" ? simpleStyle(atomic.raw) : null;
  const span = document.createElement("span");
  span.dataset.ve3AtomicRaw = atomic.raw;
  span.dataset.ve3AtomicOriginalRaw = atomic.raw;
  span.dataset.ve3AtomicNodeId = atomic.id;
  if (simple) {
    span.className = "kpoparkiveVe3SimpleInline";
    span.dataset.ve3SimplePrefix = simple.prefix;
    span.dataset.ve3SimpleSuffix = simple.suffix;
    span.textContent = simple.body;
    span.title = "NamuMark style preserved while editing text";
    styleSimpleSpan(span, simple.styleToken);
  } else {
    span.className = "kpoparkiveVe3AtomicInline";
    span.contentEditable = "false";
    span.dataset.ve3AtomicType = atomic.type;
    span.textContent = atomic.type === "inline-media" ? "Media" : "Advanced";
    const title = atomic.raw.replace(/\s+/g, " ").trim();
    span.title = title.length > 180 ? `${title.slice(0, 177)}…` : title;
  }
  fragment.append(span);
  const tail = node.data.slice(index + atomic.token.length);
  if (tail) fragment.append(document.createTextNode(tail));
  node.replaceWith(fragment);
  return true;
}

function renderSurface(block: Block) {
  const { raw, atomic } = maskBlock(block);
  const surface = document.createElement("div");
  surface.className = "kpoparkiveAstSurface kpoparkiveVe3AtomicSurface";
  surface.contentEditable = "true";
  surface.spellcheck = true;
  surface.dataset.ve3NodeId = block.id;
  surface.dataset.ve3NodeType = block.type;
  surface.innerHTML = wikiBlockToEditorHtml(raw);
  for (const item of atomic) {
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode as Text);
    const target = texts.find((text) => text.data.includes(item.token));
    if (target) replaceToken(target, item);
  }
  return surface;
}

function serializeSurface(surface: HTMLElement) {
  const clone = surface.cloneNode(true) as HTMLElement;
  for (const span of Array.from(clone.querySelectorAll<HTMLElement>("[data-ve3-atomic-raw]"))) {
    const prefix = span.dataset.ve3SimplePrefix;
    const suffix = span.dataset.ve3SimpleSuffix;
    if (prefix !== undefined && suffix !== undefined) {
      const holder = document.createElement("div");
      const p = document.createElement("p");
      while (span.firstChild) p.appendChild(span.firstChild);
      holder.appendChild(p);
      span.replaceWith(document.createTextNode(`${prefix}${editorElementToWikitext(holder)}${suffix}`));
    } else {
      span.replaceWith(document.createTextNode(span.dataset.ve3AtomicRaw || ""));
    }
  }
  return editorElementToWikitext(clone);
}

function candidateElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(".wiki-paragraph,.wiki-list,ul,ol,blockquote,.wiki-indent,.wiki-quote"))
    .filter((element) => {
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (element.closest("table,.wiki-table,.wiki-folding")) return false;
      if (element.closest("[data-ve3-node-id]")) return false;
      if (element.dataset.ve3Original === "1" || element.dataset.ve3TableOriginal === "1") return false;
      if (element.querySelector("table")) return false;
      return Boolean(normalize(element.innerText || element.textContent || ""));
    });
}

function anchorText(block: Block) {
  let raw = block.raw;
  for (const atomic of [...collectAtomic(block)].sort((a, b) => b.sourceStart - a.sourceStart)) {
    const start = atomic.sourceStart - block.sourceStart;
    const end = atomic.sourceEnd - block.sourceStart;
    const simple = atomic.type === "raw-inline" ? simpleStyle(atomic.raw) : null;
    raw = `${raw.slice(0, start)}${simple?.body || " "}${raw.slice(end)}`;
  }
  const holder = document.createElement("div");
  holder.innerHTML = wikiBlockToEditorHtml(raw);
  return normalize(holder.innerText || holder.textContent || "");
}

function score(expected: string, actual: string) {
  const a = compact(expected); const b = compact(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a)) return a.length / b.length;
  if (a.includes(b)) return b.length / a.length * .8;
  const prefix = a.slice(0, Math.min(32, a.length));
  return prefix.length >= 8 && b.includes(prefix) ? .7 : 0;
}

function bestCandidate(root: HTMLElement, block: Block, claimed: Set<HTMLElement>) {
  const expected = anchorText(block);
  if (compact(expected).length < 4) return null;
  const scored = candidateElements(root).filter((element) => !claimed.has(element))
    .map((element) => ({ element, score: score(expected, element.innerText || element.textContent || "") }))
    .filter((entry) => entry.score >= .62)
    .sort((a, b) => b.score - a.score || (a.element.textContent || "").length - (b.element.textContent || "").length);
  if (!scored.length) return null;
  if (scored[1] && scored[0].score < .9 && scored[1].score >= scored[0].score - .04) return null;
  return scored[0].element;
}

export default function VisualEditorV3AtomicTextBridge({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [records, setRecords] = useState<SurfaceRecord[]>([]);
  const recordsRef = useRef<SurfaceRecord[]>([]);

  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `.kpoparkiveVe3AtomicInline{display:inline-flex;align-items:center;vertical-align:baseline;margin:0 2px;padding:0 5px;border:1px solid #d8d0e8;border-radius:4px;background:#f5f2fb;color:#6c6078;font-size:.82em;font-weight:750;cursor:default;user-select:none}.kpoparkiveVe3SimpleInline{border-bottom:1px dotted rgba(107,60,232,.45)}.kpoparkiveVe3SimpleInline:hover{background:rgba(107,60,232,.05)}.kpoparkiveVe3AtomicInline::before{content:"◇";margin-right:3px;color:#6b3ce8;font-size:.8em}`;
    document.head.appendChild(style); return () => style.remove();
  }, []);

  const cleanup = () => {
    for (const record of recordsRef.current.slice().reverse()) {
      record.surface.remove(); record.original.style.display = record.oldDisplay; record.original.removeAttribute("data-ve3-atomic-original");
    }
    recordsRef.current = []; setRecords([]);
  };

  useEffect(() => { const sync = () => setEditing(document.body.classList.contains(EDITING_CLASS)); const observer = new MutationObserver(sync); observer.observe(document.body,{attributes:true,attributeFilter:["class"]}); sync(); return()=>observer.disconnect(); }, []);

  useEffect(() => {
    if (!editing) { cleanup(); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void (async () => {
      try {
        const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache:"no-store", signal:controller.signal });
        const payload = await response.json() as Payload;
        if (!response.ok || !payload.ok) throw new Error(payload.error || "Could not load atomic text AST");
        cleanup();
        const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline"); if(!article)return;
        const roots=sectionRoots(); const grouped=blocksBySection(payload.ast?.blocks||[]); const created:SurfaceRecord[]=[];
        for(const [section,blocks] of grouped.entries()){
          const root=section===0?article:roots.get(section); if(!root)continue; const claimed=new Set<HTMLElement>();
          for(const block of blocks){
            if((block.type!=="paragraph"&&block.type!=="list")||!collectAtomic(block).length)continue;
            if(document.querySelector(`[data-ve3-node-id="${CSS.escape(block.id)}"]`))continue;
            const candidate=bestCandidate(root,block,claimed); if(!candidate)continue; claimed.add(candidate);
            const surface=renderSurface(block); surface.addEventListener("click",event=>{if((event.target as Element|null)?.closest?.("a"))event.preventDefault();});
            const oldDisplay=candidate.style.display; candidate.style.display="none"; candidate.dataset.ve3AtomicOriginal="1"; candidate.parentNode?.insertBefore(surface,candidate);
            created.push({nodeId:block.id,originalWikitext:block.raw,original:candidate,surface,oldDisplay});
          }
        }
        recordsRef.current=created; setRecords(created);
        window.dispatchEvent(new Event("kpoparkive-ve3-atomic-surfaces-ready"));
      } catch(error){if(!controller.signal.aborted)console.warn("[VisualEditorV3AtomicTextBridge]",error);}
    })(); }, 30);
    return()=>{window.clearTimeout(timer);controller.abort();cleanup();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[editing,title]);

  useEffect(()=>{
    if(!editing)return;
    return registerV3OperationProvider("atomic-text",()=>records.flatMap(record=>{
      const proposed=serializeSurface(record.surface);
      return normalize(proposed)===normalize(record.originalWikitext)?[]:[{op:"replace-node",nodeId:record.nodeId,wikitext:proposed} satisfies V3RegisteredOperation];
    }));
  },[editing,records]);

  return null;
}
