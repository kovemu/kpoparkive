"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyVisualCommand, editorElementToWikitext, wikiBlockToEditorHtml } from "../../lib/wikiVisualEdit";
import { fetchVisualEditorV3Payload } from "./visualEditorV3PayloadClient";
import VisualEditorV3TemplateInspector, {
  collectV3TemplateEdits,
  createV3TemplateDrafts,
  createV3TemplateTargets,
  type V3NestedTemplateCall,
  type V3TemplateDrafts,
  type V3TemplateModel,
  type V3TemplateTarget,
} from "./VisualEditorV3TemplateInspector";
import {
  buildV3TableSurfaces,
  cleanupV3TableSurfaces,
  type V3TableModel,
  type V3TableSurfaceRecord,
} from "./visualEditorV3TableBridge";
import {
  clearV3OperationProviders,
  collectV3RegisteredOperations,
  preflightV3Operations,
  type V3RegisteredOperation,
} from "./visualEditorV3OperationRegistry";

type AstInlineNode = {
  id: string;
  type: string;
  raw: string;
  children?: AstInlineNode[];
};

type AstListLine = {
  marker: string;
  indent: number;
  children: AstInlineNode[];
};

type AstBlock = {
  id: string;
  type: string;
  raw: string;
  sourceStart: number;
  sourceEnd: number;
  level?: number;
  children?: AstInlineNode[];
  lines?: AstListLine[];
};

type AstTableModel = V3TableModel & {
  templateCalls?: V3NestedTemplateCall[];
};

type AstPayload = {
  ok: boolean;
  editorVersion: string;
  document: {
    title: string;
    publicRevisionNo: number;
    sourceMode: "captured" | "published";
    sourceHash: string;
  };
  ast: {
    id: string;
    type: "document";
    blocks: AstBlock[];
    stats: {
      blockCount: number;
      inlineNodeCount: number;
      headingCount: number;
      linkCount: number;
      tableCount: number;
      templateCount: number;
      mediaCount: number;
      fallbackBlockCount: number;
    };
  };
  tables?: AstTableModel[];
  templates?: V3TemplateModel[];
};

type CanvasBlockRecord = {
  nodeId: string;
  nodeType: "paragraph" | "list";
  originalWikitext: string;
  element: HTMLElement;
};

type CanvasHeadingRecord = {
  nodeId: string;
  originalWikitext: string;
  originalLevel: number;
  level: number;
  element: HTMLElement;
};

type NewCanvasBlock = {
  id: string;
  anchorNodeId: string;
  element: HTMLElement;
};

const EDITING_CLASS = "kpoparkiveAstEditing";

const CANVAS_STYLES = `
body.${EDITING_CLASS}{padding-top:104px}
body.${EDITING_CLASS} .wiki-edit-section{display:none!important}
body.${EDITING_CLASS} .wiki-heading-content{display:block!important;height:auto!important;max-height:none!important;visibility:visible!important}
body.${EDITING_CLASS} .thetreeWikiBaseline a{cursor:text!important}
.kpoparkiveAstToolbar{position:fixed;z-index:12000;inset:0 0 auto 0;min-height:58px;display:flex;align-items:center;gap:7px;padding:8px 14px;border-bottom:3px solid #6b3ce8;background:rgba(255,255,255,.97);box-shadow:0 8px 28px rgba(39,28,70,.16);backdrop-filter:blur(10px);overflow-x:auto}
.kpoparkiveAstToolbar strong{white-space:nowrap;margin-right:7px;color:#5630c4}
.kpoparkiveAstToolbar button,.kpoparkiveAstToolbar select{height:36px;min-width:36px;padding:0 10px;border:1px solid #d9d3e7;border-radius:7px;background:#fff;color:#322b3c;font:inherit;font-size:12px;font-weight:700;white-space:nowrap}
.kpoparkiveAstToolbar button{cursor:pointer}.kpoparkiveAstToolbar button:hover,.kpoparkiveAstToolbar select:hover{border-color:#9274df;background:#f4f0ff;color:#5630c4}
.kpoparkiveAstToolbar .primary{border-color:#6b3ce8;background:#6b3ce8;color:#fff}.kpoparkiveAstToolbar .danger{color:#a22a3c}
.kpoparkiveAstToolbar button:disabled,.kpoparkiveAstToolbar select:disabled{opacity:.45;cursor:default}
.kpoparkiveAstStatus{position:fixed;z-index:11990;inset:58px 0 auto 0;min-height:43px;display:flex;align-items:center;gap:12px;padding:7px 16px;border-bottom:1px solid #ded8ea;background:#fbfaff;color:#51485e;font-size:12px;overflow-x:auto;white-space:nowrap}
.kpoparkiveAstStatus b{color:#5b34c7}
.thetreeWikiBaseline.kpoparkiveVe3UnifiedCanvas{caret-color:#6b3ce8;outline:none!important}
.kpoparkiveVe3UnifiedCanvas .kpoparkiveAstSurface,
.kpoparkiveVe3UnifiedCanvas .kpoparkiveAstHeadingSurface,
.kpoparkiveVe3UnifiedCanvas .kpoparkiveVe3CanvasBlock{outline:none!important;border:0!important;box-shadow:none!important;border-radius:0!important}
.kpoparkiveVe3UnifiedCanvas .kpoparkiveVe3CanvasBlock{min-height:1.35em}
.kpoparkiveVe3UnifiedCanvas p.kpoparkiveVe3CanvasBlock{margin:0}
.kpoparkiveVe3UnifiedCanvas [data-ve3-canvas-atomic]{cursor:default}
.kpoparkiveVe3UnifiedCanvas [data-ve3-canvas-atomic]:hover{box-shadow:0 0 0 1px rgba(107,60,232,.16)}
.kpoparkiveVe3UnifiedCanvas .kpoparkiveVe3NewBlock:empty:before{content:"Type here…";color:#aaa}
.kpoparkiveVe3UnifiedCanvas .kpoparkiveVe3NewBlock{min-height:1.35em}
.kpoparkiveAstTemplatePanel{position:fixed;z-index:12100;top:112px;right:14px;width:min(420px,calc(100vw - 28px));max-height:calc(100vh - 128px);overflow:auto;border:1px solid #d8d0eb;border-radius:12px;background:rgba(255,255,255,.98);box-shadow:0 18px 55px rgba(39,28,70,.22);color:#342c40}
.kpoparkiveAstTemplatePanelHeader{position:sticky;z-index:2;top:0;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 14px;border-bottom:1px solid #e6e0ef;background:#fbf9ff}
.kpoparkiveAstTemplatePanelHeader>div{display:grid;gap:2px}.kpoparkiveAstTemplatePanelHeader strong{color:#5832c6}.kpoparkiveAstTemplatePanelHeader span{font-size:11px;color:#82768e}
.kpoparkiveAstTemplatePanelHeader button{width:32px;height:32px;border:1px solid #ded6eb;border-radius:8px;background:#fff;font-size:20px;cursor:pointer}
.kpoparkiveAstTemplatePicker{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;padding:12px 14px}
.kpoparkiveAstTemplatePicker select,.kpoparkiveAstTemplatePicker button,.kpoparkiveAstTemplateFields input{min-width:0;border:1px solid #dcd5e8;border-radius:7px;background:#fff;color:#352e40;font:inherit}
.kpoparkiveAstTemplatePicker select{height:36px;padding:0 8px}.kpoparkiveAstTemplatePicker button{padding:0 10px;cursor:pointer}
.kpoparkiveAstTemplateMeta{display:grid;gap:3px;padding:0 14px 10px}.kpoparkiveAstTemplateMeta b{font-size:14px}.kpoparkiveAstTemplateMeta span{font-size:11px;color:#83788d}
.kpoparkiveAstTemplateFields{display:grid;gap:10px;padding:0 14px 14px}.kpoparkiveAstTemplateFields label{display:grid;gap:5px}
.kpoparkiveAstTemplateFieldName{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:800}.kpoparkiveAstTemplateFieldName small{color:#8c8196;font-weight:600}
.kpoparkiveAstTemplateFields input{height:36px;padding:0 9px}.kpoparkiveAstTemplateFields label.locked input{background:#f4f2f6;color:#928b99}
.kpoparkiveAstTemplateLock{color:#9a6b36;font-size:10px}.kpoparkiveAstTemplateNote{margin:0;padding:11px 14px 14px;border-top:1px solid #eee9f4;color:#776e80;font-size:11px;line-height:1.5}.kpoparkiveAstTemplateEmpty{padding:18px 14px;color:#776e80;font-size:12px}
@media(max-width:760px){body.${EDITING_CLASS}{padding-top:142px}.kpoparkiveAstToolbar{min-height:94px;flex-wrap:wrap}.kpoparkiveAstStatus{top:94px}.kpoparkiveAstTemplatePanel{top:150px;max-height:calc(100vh - 164px)}}
`;

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

function textScore(expected: string, actual: string) {
  const a = compact(expected);
  const b = compact(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const prefix = a.slice(0, Math.min(80, a.length));
  if (prefix.length >= 16 && b.includes(prefix)) return .86;
  return 0;
}

function renderedPlainText(wikitext: string) {
  const holder = document.createElement("div");
  holder.innerHTML = wikiBlockToEditorHtml(wikitext);
  return normalize(holder.innerText || holder.textContent || "");
}

function headingParts(raw: string) {
  const eol = raw.match(/(?:\r\n|\r|\n)$/)?.[0] || "";
  const content = eol ? raw.slice(0, -eol.length) : raw;
  const match = content.match(/^(={2,6})\s*(.*?)\s*\1\s*$/);
  if (!match) return null;
  return { level: match[1].length, wikitext: match[2], eol };
}

function headingEditorHtml(wikitext: string) {
  const html = wikiBlockToEditorHtml(wikitext);
  const match = html.match(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/i);
  return match ? match[1] : html.replace(/<\/?p(?:\s[^>]*)?>/gi, "");
}

function sectionNumberFromEditLink(anchor: HTMLAnchorElement) {
  try {
    const url = new URL(anchor.href, window.location.href);
    const value = url.searchParams.get("section");
    if (!value) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function editAnchorForSection(sectionIndex: number) {
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="section="]'))) {
    if (sectionNumberFromEditLink(anchor) !== sectionIndex) continue;
    if (!/편집|edit/i.test(anchor.textContent || "")) continue;
    return anchor;
  }
  return null;
}

function findHeadingContent(anchor: HTMLAnchorElement) {
  const heading = anchor.closest<HTMLElement>(".wiki-heading");
  if (!heading) return null;
  let sibling = heading.nextElementSibling;
  while (sibling) {
    if (sibling.classList.contains("wiki-heading-content")) return sibling as HTMLElement;
    if (sibling.classList.contains("wiki-heading")) break;
    sibling = sibling.nextElementSibling;
  }
  return null;
}

function sectionRootsFromPage() {
  const roots = new Map<number, HTMLElement>();
  for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="section="]'))) {
    const section = sectionNumberFromEditLink(anchor);
    if (section === null || roots.has(section)) continue;
    const root = findHeadingContent(anchor);
    if (root) roots.set(section, root);
  }
  return roots;
}

function inlineSafe(nodes: AstInlineNode[] | undefined): boolean {
  if (!nodes) return true;
  for (const node of nodes) {
    if (node.type === "raw-inline" || node.type === "inline-media") return false;
    if (node.children && !inlineSafe(node.children)) return false;
  }
  return true;
}

function directSafe(block: AstBlock) {
  if (block.type === "paragraph") return inlineSafe(block.children);
  if (block.type === "list") {
    if (!block.lines?.length) return false;
    if (!block.lines.every((line) => line.marker === "*" || line.marker === "1.")) return false;
    return block.lines.every((line) => inlineSafe(line.children));
  }
  return false;
}

type CandidateRecord = { candidate: HTMLElement; text: string };

function candidateElements(root: HTMLElement, leadOnly = false): CandidateRecord[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".wiki-paragraph, .wiki-list, ul, ol, blockquote, .wiki-indent, .wiki-quote"))
    .filter((node) => {
      if (leadOnly && (node.closest(".wiki-heading-content") || node.closest(".wiki-heading"))) return false;
      if (node.closest(".wiki-table") || node.closest("table") || node.closest(".wiki-folding")) return false;
      if (node.querySelector("iframe, video, table")) return false;
      return true;
    })
    .map((candidate) => ({ candidate, text: candidate.innerText || candidate.textContent || "" }))
    .filter((record) => Boolean(normalize(record.text)));
}

function bestUniqueCandidate(candidates: CandidateRecord[], block: AstBlock, used: Set<HTMLElement>) {
  const expected = renderedPlainText(block.raw);
  if (!expected) return null;
  const usedList = Array.from(used);
  const scored = candidates
    .filter(({ candidate }) => !used.has(candidate) && !usedList.some((other) => other.contains(candidate) || candidate.contains(other)))
    .map(({ candidate, text }) => ({ candidate, score: textScore(expected, text) }))
    .sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score < .78) return null;
  if (scored[1] && scored[1].score >= scored[0].score - .04) return null;
  return scored[0].candidate;
}

function sectionedBlocks(blocks: AstBlock[]) {
  const result = new Map<number, AstBlock[]>();
  let section = 0;
  result.set(0, []);
  for (const block of blocks) {
    if (block.type === "heading") {
      section += 1;
      if (!result.has(section)) result.set(section, []);
      continue;
    }
    result.get(section)?.push(block);
  }
  return result;
}

function editorBlockElement(block: AstBlock) {
  const holder = document.createElement("div");
  holder.innerHTML = wikiBlockToEditorHtml(block.raw);
  let element: HTMLElement;
  if (holder.children.length === 1 && holder.firstElementChild instanceof HTMLElement) {
    element = holder.firstElementChild;
    holder.removeChild(element);
  } else {
    element = document.createElement("div");
    while (holder.firstChild) element.appendChild(holder.firstChild);
  }
  element.classList.add("kpoparkiveAstSurface", "kpoparkiveVe3CanvasBlock");
  if (block.type === "paragraph") element.classList.add("wiki-paragraph");
  element.dataset.ve3NodeId = block.id;
  element.dataset.ve3NodeType = block.type;
  element.spellcheck = true;
  return element;
}

function serializeBlockElement(element: HTMLElement) {
  const wrapper = document.createElement("div");
  wrapper.appendChild(element.cloneNode(true));
  return editorElementToWikitext(wrapper);
}

function selectedCanvasBlock(article: HTMLElement | null) {
  if (!article) return null;
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const block = element?.closest<HTMLElement>("[data-ve3-node-id],[data-ve3-new-block-id]") || null;
  return block && article.contains(block) ? block : null;
}

function activeAnchor(block: HTMLElement | null) {
  if (!block) return null;
  const selection = window.getSelection();
  const node = selection?.anchorNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const anchor = element?.closest("a") as HTMLAnchorElement | null;
  return anchor && block.contains(anchor) ? anchor : null;
}

function unwrapAnchor(anchor: HTMLAnchorElement) {
  const parent = anchor.parentNode;
  if (!parent) return;
  while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
  anchor.remove();
}

function caretAtStart(block: HTMLElement) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed) return false;
  const range = selection.getRangeAt(0);
  if (!block.contains(range.startContainer)) return false;
  const before = range.cloneRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  return !normalize(before.toString());
}

function moveCaretToStart(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function moveCaretToEnd(element: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function protectComplexWidgets(article: HTMLElement) {
  const selector = [
    ".wiki-table-wrap",
    ".wiki-folding",
    "iframe",
    "video",
    ".wiki-image-wrapper",
    "details",
    "summary",
  ].join(",");
  for (const element of Array.from(article.querySelectorAll<HTMLElement>(selector))) {
    if (element.closest("[data-ve3-node-id],[data-ve3-new-block-id]")) continue;
    if (element.closest("[data-ve3-canvas-atomic]")) continue;
    element.setAttribute("contenteditable", "false");
    element.dataset.ve3CanvasAtomic = element.matches(".wiki-table-wrap") ? "table" : "complex";
  }
}

export default function FullPageVisualEditorV3Canvas({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("Visual Editor V3 document canvas ready");
  const [payload, setPayload] = useState<AstPayload | null>(null);
  const [mappedCount, setMappedCount] = useState(0);
  const [protectedCount, setProtectedCount] = useState(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeHeadingLevel, setActiveHeadingLevel] = useState(2);
  const [templatePanelOpen, setTemplatePanelOpen] = useState(false);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string | null>(null);
  const [templateDrafts, setTemplateDrafts] = useState<V3TemplateDrafts>({});

  const articleRef = useRef<HTMLElement | null>(null);
  const originalHtmlRef = useRef<string | null>(null);
  const canvasBlocksRef = useRef<CanvasBlockRecord[]>([]);
  const headingsRef = useRef<CanvasHeadingRecord[]>([]);
  const newBlocksRef = useRef<NewCanvasBlock[]>([]);
  const tableSurfacesRef = useRef<V3TableSurfaceRecord[]>([]);
  const canvasListenersCleanupRef = useRef<(() => void) | null>(null);

  const stats = useMemo(() => payload?.ast.stats || null, [payload]);
  const templateTargets = useMemo<V3TemplateTarget[]>(
    () => createV3TemplateTargets(payload?.templates || [], payload?.tables || []),
    [payload],
  );
  const templateParamCount = templateTargets.reduce((sum, target) => sum + target.editableParamCount, 0);

  const syncActiveContext = () => {
    const article = articleRef.current;
    const block = selectedCanvasBlock(article);
    if (!block) {
      setActiveHeadingId(null);
      return;
    }
    if (block.dataset.ve3NodeType === "heading") {
      const record = headingsRef.current.find((item) => item.nodeId === block.dataset.ve3NodeId);
      if (record) {
        setActiveHeadingId(record.nodeId);
        setActiveHeadingLevel(record.level);
        return;
      }
    }
    setActiveHeadingId(null);
  };

  const cleanup = () => {
    canvasListenersCleanupRef.current?.();
    canvasListenersCleanupRef.current = null;
    cleanupV3TableSurfaces(tableSurfacesRef.current);
    tableSurfacesRef.current = [];
    clearV3OperationProviders();

    const article = articleRef.current || document.querySelector<HTMLElement>(".thetreeWikiBaseline");
    if (article) {
      article.removeAttribute("contenteditable");
      article.removeAttribute("spellcheck");
      article.classList.remove("kpoparkiveVe3UnifiedCanvas", "kpoparkiveAstCanvas");
      if (originalHtmlRef.current !== null) article.innerHTML = originalHtmlRef.current;
    }

    articleRef.current = null;
    originalHtmlRef.current = null;
    canvasBlocksRef.current = [];
    headingsRef.current = [];
    newBlocksRef.current = [];
    document.body.classList.remove(EDITING_CLASS);
    setEditing(false);
    setMappedCount(0);
    setProtectedCount(0);
    setActiveHeadingId(null);
    setTemplatePanelOpen(false);
    setSelectedTemplateKey(null);
    setTemplateDrafts({});
  };

  const createNewParagraph = (anchorNodeId: string) => {
    const element = document.createElement("p");
    element.className = "wiki-paragraph kpoparkiveVe3CanvasBlock kpoparkiveVe3NewBlock";
    element.dataset.ve3NewBlockId = `new-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    element.dataset.ve3InsertAnchor = anchorNodeId;
    element.innerHTML = "<br>";
    element.spellcheck = true;
    newBlocksRef.current.push({ id: element.dataset.ve3NewBlockId, anchorNodeId, element });
    return element;
  };

  const splitParagraph = (block: HTMLElement) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || !selection.isCollapsed) return false;
    const range = selection.getRangeAt(0);
    if (!block.contains(range.startContainer)) return false;
    const anchorNodeId = block.dataset.ve3NodeId || block.dataset.ve3InsertAnchor;
    if (!anchorNodeId) return false;

    const tail = document.createRange();
    tail.selectNodeContents(block);
    tail.setStart(range.startContainer, range.startOffset);
    const fragment = tail.extractContents();
    const next = createNewParagraph(anchorNodeId);
    next.innerHTML = "";
    next.appendChild(fragment);
    if (!normalize(next.textContent || "") && !next.querySelector("br")) next.innerHTML = "<br>";
    if (!normalize(block.textContent || "") && !block.querySelector("br")) block.innerHTML = "<br>";
    block.insertAdjacentElement("afterend", next);
    moveCaretToStart(next);
    return true;
  };

  const splitHeading = (block: HTMLElement) => {
    const nodeId = block.dataset.ve3NodeId;
    if (!nodeId) return false;
    const heading = block.closest<HTMLElement>(".wiki-heading");
    if (!heading) return false;
    let content = heading.nextElementSibling;
    while (content && !content.classList.contains("wiki-heading-content")) content = content.nextElementSibling;
    if (!(content instanceof HTMLElement)) return false;
    const paragraph = createNewParagraph(nodeId);
    content.insertBefore(paragraph, content.firstChild);
    moveCaretToStart(paragraph);
    return true;
  };

  const mergeWithPreviousParagraph = (block: HTMLElement) => {
    if (!caretAtStart(block)) return false;
    let previous = block.previousElementSibling as HTMLElement | null;
    while (previous && !previous.matches("[data-ve3-node-id],[data-ve3-new-block-id]")) previous = previous.previousElementSibling as HTMLElement | null;
    if (!previous || !previous.matches("p,div") || !block.matches("p,div")) return false;
    if (previous.dataset.ve3NodeType && previous.dataset.ve3NodeType !== "paragraph") return false;
    if (block.dataset.ve3NodeType && block.dataset.ve3NodeType !== "paragraph") return false;

    while (block.firstChild) previous.appendChild(block.firstChild);
    block.remove();
    moveCaretToEnd(previous);
    return true;
  };

  const installCanvasListeners = (article: HTMLElement) => {
    const click = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (anchor) event.preventDefault();
      syncActiveContext();
    };

    const input = (event: InputEvent) => {
      const target = event.target as Element | null;
      const block = target?.closest?.<HTMLElement>("[data-ve3-node-id],[data-ve3-new-block-id]");
      if (block) block.dataset.ve3Dirty = "1";
      syncActiveContext();
    };

    const beforeInput = (event: InputEvent) => {
      if (event.inputType.startsWith("history")) return;
      const block = selectedCanvasBlock(article);
      if (block) return;
      event.preventDefault();
      setStatus("This complex wiki block is protected. Use its inspector or Source panel.");
    };

    const keydown = (event: KeyboardEvent) => {
      const block = selectedCanvasBlock(article);
      if (!block) return;

      if (event.key === "Enter") {
        if (block.matches("ul,ol") || block.closest("ul,ol")) return;
        event.preventDefault();
        if (event.shiftKey) {
          document.execCommand("insertHTML", false, "<br>");
          return;
        }
        if (block.dataset.ve3NodeType === "heading") {
          splitHeading(block);
          return;
        }
        splitParagraph(block);
        return;
      }

      if (event.key === "Backspace" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (mergeWithPreviousParagraph(block)) event.preventDefault();
      }
    };

    const selection = () => syncActiveContext();
    article.addEventListener("click", click);
    article.addEventListener("input", input as EventListener);
    article.addEventListener("beforeinput", beforeInput as EventListener);
    article.addEventListener("keydown", keydown);
    document.addEventListener("selectionchange", selection);

    return () => {
      article.removeEventListener("click", click);
      article.removeEventListener("input", input as EventListener);
      article.removeEventListener("beforeinput", beforeInput as EventListener);
      article.removeEventListener("keydown", keydown);
      document.removeEventListener("selectionchange", selection);
    };
  };

  const buildCanvas = (data: AstPayload, requestedSection: number | null) => {
    cleanup();
    const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
    if (!article) throw new Error("Rendered wiki article was not found");

    articleRef.current = article;
    originalHtmlRef.current = article.innerHTML;
    document.body.classList.add(EDITING_CLASS);
    article.classList.add("kpoparkiveVe3UnifiedCanvas", "kpoparkiveAstCanvas");
    article.contentEditable = "true";
    article.spellcheck = true;

    const roots = sectionRootsFromPage();
    const grouped = sectionedBlocks(data.ast.blocks);
    const blockRecords: CanvasBlockRecord[] = [];

    for (const [section, blocks] of grouped.entries()) {
      const root = section === 0 ? article : roots.get(section);
      if (!root) continue;
      const used = new Set<HTMLElement>();
      const candidates = candidateElements(root, section === 0);
      for (const block of blocks) {
        if (!directSafe(block)) continue;
        const candidate = bestUniqueCandidate(candidates, block, used);
        if (!candidate) continue;
        used.add(candidate);
        const editor = editorBlockElement(block);
        candidate.replaceWith(editor);
        blockRecords.push({
          nodeId: block.id,
          nodeType: block.type as "paragraph" | "list",
          originalWikitext: block.raw,
          element: editor,
        });
      }
    }

    const headingRecords: CanvasHeadingRecord[] = [];
    const sourceHeadings = data.ast.blocks.filter((block) => block.type === "heading");
    sourceHeadings.forEach((block, index) => {
      const parts = headingParts(block.raw);
      if (!parts || !inlineSafe(block.children)) return;
      const anchor = editAnchorForSection(index + 1);
      const marker = anchor?.closest<HTMLElement>(".wiki-edit-section");
      const host = marker?.parentElement as HTMLElement | null;
      const heading = anchor?.closest<HTMLElement>(".wiki-heading");
      if (!host || !heading) return;

      host.innerHTML = headingEditorHtml(parts.wikitext);
      host.classList.add("kpoparkiveAstHeadingSurface", "kpoparkiveVe3CanvasBlock");
      host.dataset.ve3NodeId = block.id;
      host.dataset.ve3NodeType = "heading";
      host.spellcheck = true;
      const numberAnchor = heading.querySelector<HTMLElement>(":scope > a");
      numberAnchor?.setAttribute("contenteditable", "false");
      headingRecords.push({
        nodeId: block.id,
        originalWikitext: block.raw,
        originalLevel: parts.level,
        level: parts.level,
        element: host,
      });
    });

    const tableResult = buildV3TableSurfaces({
      tables: data.tables || [],
      article,
      sectionRoots: roots,
      onActivate: () => undefined,
      editableFields: false,
    });
    tableSurfacesRef.current = tableResult.records;

    protectComplexWidgets(article);

    const targets = createV3TemplateTargets(data.templates || [], data.tables || []);
    setTemplateDrafts(createV3TemplateDrafts(targets));
    setSelectedTemplateKey(targets.find((target) => target.paramCount > 0)?.key || null);

    canvasBlocksRef.current = blockRecords;
    headingsRef.current = headingRecords;
    canvasListenersCleanupRef.current = installCanvasListeners(article);

    const complexBlocks = data.ast.blocks.filter((block) =>
      block.type === "table" ||
      block.type === "template" ||
      block.type === "styled-block" ||
      block.type === "raw-block" ||
      block.type === "media"
    ).length;
    setProtectedCount(complexBlocks);
    setMappedCount(blockRecords.length + headingRecords.length);
    setEditing(true);

    if (requestedSection && roots.get(requestedSection)) {
      window.setTimeout(() => roots.get(requestedSection)?.scrollIntoView({ block: "start" }), 30);
    }

    setStatus(
      `Whole document canvas active · ${blockRecords.length} text/list + ${headingRecords.length} headings · ${tableResult.mappedTables} atomic tables`,
    );
  };

  const startEditing = async (requestedSection: number | null) => {
    if (editing || loading) return;
    setLoading(true);
    setStatus("Loading document model…");
    try {
      const response = await fetchVisualEditorV3Payload(title);
      const data = await response.json() as AstPayload & { error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not load visual editor");
      setPayload(data);
      buildCanvas(data, requestedSection);
    } catch (error) {
      cleanup();
      const message = error instanceof Error ? error.message : "Could not start visual editor";
      setStatus(message);
      window.alert(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.kpoparkiveVe3Canvas = "1";
    style.textContent = CANVAS_STYLES;
    document.head.appendChild(style);

    const click = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[href*="section="]') as HTMLAnchorElement | null;
      if (!anchor || !/편집|edit/i.test(anchor.textContent || "")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void startEditing(sectionNumberFromEditLink(anchor));
    };
    document.addEventListener("click", click, true);
    return () => {
      document.removeEventListener("click", click, true);
      style.remove();
      cleanup();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  const command = (value: Parameters<typeof applyVisualCommand>[0]) => {
    const article = articleRef.current;
    if (!article) return;
    if (value === "undo" || value === "redo") {
      applyVisualCommand(value, article);
      return;
    }
    const block = selectedCanvasBlock(article);
    if (!block) {
      setStatus("Select editable document text first");
      return;
    }
    if (value === "bulletList" && block.dataset.ve3NodeType === "heading") {
      setStatus("A heading cannot become a list. Press Enter first to create a paragraph.");
      return;
    }
    applyVisualCommand(value, block);
  };

  const unlink = () => {
    const block = selectedCanvasBlock(articleRef.current);
    const anchor = activeAnchor(block);
    if (!block || !anchor) {
      setStatus("Place the caret inside a link first");
      return;
    }
    unwrapAnchor(anchor);
    block.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatRemove" }));
  };

  const changeHeadingLevel = (level: number) => {
    if (!activeHeadingId) return;
    const record = headingsRef.current.find((item) => item.nodeId === activeHeadingId);
    if (!record) return;
    record.level = Math.max(2, Math.min(6, Math.round(level)));
    setActiveHeadingLevel(record.level);
    setStatus(`Heading level set to H${record.level}`);
  };

  const revealTemplateSection = (sectionIndex: number) => {
    const article = articleRef.current;
    if (sectionIndex === 0) {
      article?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    sectionRootsFromPage().get(sectionIndex)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const updateTemplateDraft = (targetKey: string, paramId: string, value: string) => {
    setTemplateDrafts((current) => ({
      ...current,
      [targetKey]: { ...(current[targetKey] || {}), [paramId]: value },
    }));
  };

  const save = async () => {
    if (!payload || saving) return;

    const operations: V3RegisteredOperation[] = [];

    for (const record of canvasBlocksRef.current) {
      if (!record.element.isConnected) {
        operations.push({ op: "delete-node", nodeId: record.nodeId });
        continue;
      }
      const wikitext = serializeBlockElement(record.element);
      if (normalize(wikitext) !== normalize(record.originalWikitext)) {
        operations.push({ op: "replace-node", nodeId: record.nodeId, wikitext });
      }
    }

    for (const record of headingsRef.current) {
      if (!record.element.isConnected) {
        window.alert("Deleting headings by cross-block selection is not supported yet. Undo that heading deletion first.");
        return;
      }
      const parts = headingParts(record.originalWikitext);
      if (!parts) continue;
      const inner = serializeBlockElement(record.element).trim();
      const marks = "=".repeat(record.level);
      const wikitext = `${marks} ${inner} ${marks}${parts.eol}`;
      if (wikitext !== record.originalWikitext) {
        operations.push({ op: "replace-node", nodeId: record.nodeId, wikitext });
      }
    }

    const aliveNewBlocks = newBlocksRef.current
      .filter((record) => record.element.isConnected && normalize(record.element.innerText || record.element.textContent || ""))
      .sort((a, b) => {
        if (a.element === b.element) return 0;
        return a.element.compareDocumentPosition(b.element) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });

    for (const record of aliveNewBlocks) {
      const wikitext = serializeBlockElement(record.element);
      if (!normalize(wikitext)) continue;
      operations.push({
        op: "insert-block",
        anchorNodeId: record.anchorNodeId,
        position: "after",
        wikitext,
      });
    }

    const templateEdits = collectV3TemplateEdits(templateTargets, templateDrafts);
    for (const [nodeId, templateParams] of templateEdits.tableParams.entries()) {
      if (templateParams.length) operations.push({ op: "table-structure", nodeId, templateParams });
    }
    operations.push(...templateEdits.standalone as V3RegisteredOperation[]);

    let prepared: V3RegisteredOperation[];
    try {
      operations.push(...collectV3RegisteredOperations());
      prepared = preflightV3Operations(operations);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not collect document changes";
      setStatus(message);
      window.alert(message);
      return;
    }

    if (!prepared.length) {
      setStatus("No changes were made");
      return;
    }
    if (prepared.length > 500) {
      window.alert("This edit contains more than 500 structural operations. Save a smaller batch first.");
      return;
    }

    setSaving(true);
    setStatus(`Validating ${prepared.length} document change${prepared.length === 1 ? "" : "s"}…`);
    try {
      const response = await fetch("/api/wiki-edit-document-v3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          baseRevisionNo: payload.document.publicRevisionNo,
          baseSourceHash: payload.document.sourceHash,
          operations: prepared,
          summary: "Visual Editor V3 unified document canvas",
        }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; proposalId?: string };
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit visual edit");
      cleanup();
      setStatus(`Edit proposal submitted${result.proposalId ? ` · ${result.proposalId}` : ""}`);
      window.alert("Edit proposal submitted. The original NamuMark remains unchanged until approval.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not save visual edit";
      setStatus(message);
      window.alert(message);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return loading ? <div className="kpoparkiveAstStatus"><b>V3</b> {status}</div> : null;
  }

  return (
    <>
      <div className="kpoparkiveAstToolbar" role="toolbar" aria-label="Kpoparkive unified Visual Editor V3">
        <strong>Visual Editor V3 · Document</strong>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("undo")}>Undo</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("redo")}>Redo</button>
        <select
          aria-label="Heading level"
          disabled={!activeHeadingId}
          value={activeHeadingLevel}
          onChange={(event) => changeHeadingLevel(Number(event.target.value))}
        >
          {[2, 3, 4, 5, 6].map((level) => <option key={level} value={level}>H{level}</option>)}
        </select>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("bold")}><b>B</b></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("italic")}><i>I</i></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("underline")}><u>U</u></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("strike")}><s>S</s></button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("link")}>Link</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={unlink}>Unlink</button>
        <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => command("bulletList")}>List</button>
        <button
          type="button"
          disabled={!templateTargets.some((target) => target.paramCount > 0)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => setTemplatePanelOpen((value) => !value)}
        >Templates</button>
        <button type="button" className="danger" onClick={() => { cleanup(); setStatus("Edit cancelled"); }}>Cancel</button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </div>
      <div className="kpoparkiveAstStatus">
        <b>Whole-page canvas</b>
        <span>{status}</span>
        {stats ? <span>{stats.linkCount} links · {stats.headingCount} headings · {stats.tableCount} tables</span> : null}
        <span>{mappedCount} directly editable blocks · {templateParamCount} template params · {protectedCount} structured/advanced blocks</span>
      </div>
      <VisualEditorV3TemplateInspector
        open={templatePanelOpen}
        targets={templateTargets}
        selectedKey={selectedTemplateKey}
        drafts={templateDrafts}
        onClose={() => setTemplatePanelOpen(false)}
        onSelect={setSelectedTemplateKey}
        onChange={updateTemplateDraft}
        onRevealSection={revealTemplateSection}
      />
    </>
  );
}
