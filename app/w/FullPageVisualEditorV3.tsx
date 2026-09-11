"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyVisualCommand, editorElementToWikitext, wikiBlockToEditorHtml } from "../../lib/wikiVisualEdit";
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
  collectV3TableOperations,
  type V3TableModel,
  type V3TableSurfaceRecord,
} from "./visualEditorV3TableBridge";
import { collectV3RegisteredOperations, type V3RegisteredOperation } from "./visualEditorV3OperationRegistry";

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
  editingMode?: string;
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
  capabilities: {
    direct: string[];
    structuredBridge: string[];
    sourceFallback: string[];
  };
};

type SurfaceRecord = {
  nodeId: string;
  nodeType: "paragraph" | "list";
  originalWikitext: string;
  original: HTMLElement;
  surface: HTMLElement;
  oldDisplay: string;
};

type HeadingRecord = {
  nodeId: string;
  originalWikitext: string;
  originalLevel: number;
  level: number;
  host: HTMLElement;
  oldDisplay: string;
  surface: HTMLElement;
};

type AstOperation =
  | { op: "replace-node"; nodeId: string; wikitext: string }
  | { op: "unlink"; nodeId: string }
  | { op: "set-link"; nodeId: string; target: string; label?: string }
  | {
      op: "table-structure";
      nodeId: string;
      fields?: Array<{ fieldId: string; proposedWikitext: string }>;
      templateParams?: Array<{ callId: string; paramId: string; proposedValue: string }>;
    }
  | { op: "template-fields"; nodeId: string; changes: Array<{ paramId: string; proposedValue: string }> };

const V3_STYLES = `
body.kpoparkiveAstEditing { padding-top: 104px; }
body.kpoparkiveAstEditing .wiki-edit-section { display: none !important; }
body.kpoparkiveAstEditing .wiki-heading-content {
  display: block !important;
  height: auto !important;
  max-height: none !important;
  visibility: visible !important;
}
body.kpoparkiveAstEditing .thetreeWikiBaseline a { cursor: text !important; }
.kpoparkiveAstToolbar {
  position: fixed;
  z-index: 12000;
  inset: 0 0 auto 0;
  min-height: 58px;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border-bottom: 3px solid #6b3ce8;
  background: rgba(255,255,255,.97);
  box-shadow: 0 8px 28px rgba(39,28,70,.16);
  backdrop-filter: blur(10px);
  overflow-x: auto;
}
.kpoparkiveAstToolbar strong { white-space: nowrap; margin-right: 7px; color: #5630c4; }
.kpoparkiveAstToolbar button,
.kpoparkiveAstToolbar select {
  height: 36px;
  min-width: 36px;
  padding: 0 10px;
  border: 1px solid #d9d3e7;
  border-radius: 7px;
  background: #fff;
  color: #322b3c;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.kpoparkiveAstToolbar button { cursor: pointer; }
.kpoparkiveAstToolbar button:hover,
.kpoparkiveAstToolbar select:hover { border-color: #9274df; background: #f4f0ff; color: #5630c4; }
.kpoparkiveAstToolbar .primary { border-color: #6b3ce8; background: #6b3ce8; color: #fff; }
.kpoparkiveAstToolbar .danger { color: #a22a3c; }
.kpoparkiveAstToolbar select:disabled,
.kpoparkiveAstToolbar button:disabled { opacity: .45; cursor: default; }
.kpoparkiveAstStatus {
  position: fixed;
  z-index: 11990;
  inset: 58px 0 auto 0;
  min-height: 43px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 16px;
  border-bottom: 1px solid #ded8ea;
  background: #fbfaff;
  color: #51485e;
  font-size: 12px;
  overflow-x: auto;
  white-space: nowrap;
}
.kpoparkiveAstStatus b { color: #5b34c7; }
.thetreeWikiBaseline.kpoparkiveAstCanvas { outline: 2px solid rgba(107,60,232,.30); outline-offset: 10px; }
.kpoparkiveAstSurface {
  min-height: 1.45em;
  outline: 1px dashed rgba(107,60,232,.42);
  outline-offset: 3px;
  border-radius: 3px;
  caret-color: #6b3ce8;
}
.kpoparkiveAstSurface:hover { background: rgba(107,60,232,.035); }
.kpoparkiveAstSurface:focus { outline: 2px solid rgba(107,60,232,.62); background: #fff; }
.kpoparkiveAstSurface a { cursor: text !important; }
.kpoparkiveAstHeadingSurface {
  display: inline;
  min-width: 2ch;
  outline: 1px dashed rgba(107,60,232,.45);
  outline-offset: 3px;
  border-radius: 3px;
  caret-color: #6b3ce8;
}
.kpoparkiveAstHeadingSurface:focus { outline: 2px solid rgba(107,60,232,.65); background: rgba(255,255,255,.85); }
.kpoparkiveAstTableMapped { outline: 1px solid rgba(107,60,232,.16); outline-offset: 2px; }
.kpoparkiveAstTableSurface {
  min-height: 1.3em;
  min-width: 1.5ch;
  outline: 1px dashed rgba(107,60,232,.42);
  outline-offset: 2px;
  border-radius: 3px;
  caret-color: #6b3ce8;
}
.kpoparkiveAstTableSurface:hover { background: rgba(107,60,232,.045); }
.kpoparkiveAstTableSurface:focus { outline: 2px solid rgba(107,60,232,.68); background: rgba(255,255,255,.94); }
.kpoparkiveAstTableSurface a { cursor: text !important; }
.kpoparkiveAstTemplatePanel {
  position: fixed;
  z-index: 12100;
  top: 112px;
  right: 14px;
  width: min(420px, calc(100vw - 28px));
  max-height: calc(100vh - 128px);
  overflow: auto;
  border: 1px solid #d8d0eb;
  border-radius: 12px;
  background: rgba(255,255,255,.98);
  box-shadow: 0 18px 55px rgba(39,28,70,.22);
  color: #342c40;
}
.kpoparkiveAstTemplatePanelHeader {
  position: sticky;
  z-index: 2;
  top: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 13px 14px;
  border-bottom: 1px solid #e6e0ef;
  background: #fbf9ff;
}
.kpoparkiveAstTemplatePanelHeader > div { display: grid; gap: 2px; }
.kpoparkiveAstTemplatePanelHeader strong { color: #5832c6; }
.kpoparkiveAstTemplatePanelHeader span { font-size: 11px; color: #82768e; }
.kpoparkiveAstTemplatePanelHeader button {
  width: 32px;
  height: 32px;
  border: 1px solid #ded6eb;
  border-radius: 8px;
  background: #fff;
  font-size: 20px;
  cursor: pointer;
}
.kpoparkiveAstTemplatePicker { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; padding: 12px 14px; }
.kpoparkiveAstTemplatePicker select,
.kpoparkiveAstTemplatePicker button,
.kpoparkiveAstTemplateFields input {
  min-width: 0;
  border: 1px solid #dcd5e8;
  border-radius: 7px;
  background: #fff;
  color: #352e40;
  font: inherit;
}
.kpoparkiveAstTemplatePicker select { height: 36px; padding: 0 8px; }
.kpoparkiveAstTemplatePicker button { padding: 0 10px; cursor: pointer; }
.kpoparkiveAstTemplateMeta { display: grid; gap: 3px; padding: 0 14px 10px; }
.kpoparkiveAstTemplateMeta b { font-size: 14px; }
.kpoparkiveAstTemplateMeta span { font-size: 11px; color: #83788d; }
.kpoparkiveAstTemplateFields { display: grid; gap: 10px; padding: 0 14px 14px; }
.kpoparkiveAstTemplateFields label { display: grid; gap: 5px; }
.kpoparkiveAstTemplateFieldName { display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 800; }
.kpoparkiveAstTemplateFieldName small { color: #8c8196; font-weight: 600; }
.kpoparkiveAstTemplateFields input { height: 36px; padding: 0 9px; }
.kpoparkiveAstTemplateFields label.locked input { background: #f4f2f6; color: #928b99; }
.kpoparkiveAstTemplateLock { color: #9a6b36; font-size: 10px; }
.kpoparkiveAstTemplateNote { margin: 0; padding: 11px 14px 14px; border-top: 1px solid #eee9f4; color: #776e80; font-size: 11px; line-height: 1.5; }
.kpoparkiveAstTemplateEmpty { padding: 18px 14px; color: #776e80; font-size: 12px; }
@media (max-width: 760px) {
  body.kpoparkiveAstEditing { padding-top: 142px; }
  .kpoparkiveAstToolbar { min-height: 94px; flex-wrap: wrap; }
  .kpoparkiveAstStatus { top: 94px; }
  .kpoparkiveAstTemplatePanel { top: 150px; max-height: calc(100vh - 164px); }
}
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

function candidateElements(root: HTMLElement, leadOnly = false) {
  return Array.from(root.querySelectorAll<HTMLElement>(".wiki-paragraph, .wiki-list, ul, ol, blockquote, .wiki-indent, .wiki-quote"))
    .filter((node) => {
      if (!normalize(node.innerText || node.textContent || "")) return false;
      if (leadOnly && (node.closest(".wiki-heading-content") || node.closest(".wiki-heading"))) return false;
      if (node.closest(".wiki-table")) return false;
      if (node.closest("table")) return false;
      if (node.closest(".wiki-folding")) return false;
      if (node.querySelector("iframe, video, table")) return false;
      return true;
    });
}

function bestUniqueCandidate(root: HTMLElement, block: AstBlock, used: Set<HTMLElement>, leadOnly = false) {
  const expected = renderedPlainText(block.raw);
  if (!expected) return null;
  const scored = candidateElements(root, leadOnly)
    .filter((candidate) => !used.has(candidate) && !Array.from(used).some((other) => other.contains(candidate) || candidate.contains(other)))
    .map((candidate) => ({ candidate, score: textScore(expected, candidate.innerText || candidate.textContent || "") }))
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

function unwrapAnchor(anchor: HTMLAnchorElement) {
  const parent = anchor.parentNode;
  if (!parent) return;
  while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
  anchor.remove();
}

function activeAnchor(surface: HTMLElement | null) {
  if (!surface) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const node = selection.anchorNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const anchor = element?.closest("a") as HTMLAnchorElement | null;
  return anchor && surface.contains(anchor) ? anchor : null;
}

const EDITABLE_SURFACE_SELECTOR = ".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface,.kpoparkiveVe3AtomicSurface";

function currentEditableSurface(fallback: HTMLElement | null) {
  const selection = window.getSelection();
  const selectedNode = selection?.anchorNode || selection?.focusNode || null;
  const selectedElement = selectedNode instanceof Element ? selectedNode : selectedNode?.parentElement;
  const selectedSurface = selectedElement?.closest<HTMLElement>(EDITABLE_SURFACE_SELECTOR) || null;
  if (selectedSurface?.isContentEditable) return selectedSurface;

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const activeSurface = active?.matches(EDITABLE_SURFACE_SELECTOR)
    ? active
    : active?.closest<HTMLElement>(EDITABLE_SURFACE_SELECTOR) || null;
  if (activeSurface?.isContentEditable) return activeSurface;

  return fallback?.isConnected && fallback.isContentEditable ? fallback : null;
}

export default function FullPageVisualEditorV3({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("AST Visual Editor V3 ready");
  const [payload, setPayload] = useState<AstPayload | null>(null);
  const [mappedCount, setMappedCount] = useState(0);
  const [headingCount, setHeadingCount] = useState(0);
  const [tableFieldCount, setTableFieldCount] = useState(0);
  const [mappedTableCount, setMappedTableCount] = useState(0);
  const [protectedCount, setProtectedCount] = useState(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeHeadingLevel, setActiveHeadingLevel] = useState(2);
  const [templatePanelOpen, setTemplatePanelOpen] = useState(false);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState<string | null>(null);
  const [templateDrafts, setTemplateDrafts] = useState<V3TemplateDrafts>({});
  const surfacesRef = useRef<SurfaceRecord[]>([]);
  const headingsRef = useRef<HeadingRecord[]>([]);
  const tableSurfacesRef = useRef<V3TableSurfaceRecord[]>([]);
  const activeSurfaceRef = useRef<HTMLElement | null>(null);
  const startedSectionRef = useRef<number | null>(null);

  const stats = useMemo(() => payload?.ast.stats || null, [payload]);
  const templateTargets = useMemo<V3TemplateTarget[]>(
    () => createV3TemplateTargets(payload?.templates || [], payload?.tables || []),
    [payload],
  );
  const templateParamCount = templateTargets.reduce((sum, target) => sum + target.editableParamCount, 0);

  const activateSurface = (surface: HTMLElement, heading?: HeadingRecord) => {
    activeSurfaceRef.current = surface;
    if (heading) {
      setActiveHeadingId(heading.nodeId);
      setActiveHeadingLevel(heading.level);
    } else {
      setActiveHeadingId(null);
    }
  };

  const cleanup = () => {
    cleanupV3TableSurfaces(tableSurfacesRef.current);
    tableSurfacesRef.current = [];
    for (const record of surfacesRef.current) {
      record.surface.remove();
      record.original.style.display = record.oldDisplay;
      record.original.removeAttribute("data-ve3-original");
    }
    surfacesRef.current = [];
    for (const record of headingsRef.current) {
      record.surface.remove();
      record.host.style.display = record.oldDisplay;
    }
    headingsRef.current = [];
    activeSurfaceRef.current = null;
    setActiveHeadingId(null);
    setTemplatePanelOpen(false);
    setSelectedTemplateKey(null);
    setTemplateDrafts({});
    document.body.classList.remove("kpoparkiveAstEditing");
    document.querySelector(".thetreeWikiBaseline")?.classList.remove("kpoparkiveAstCanvas");
    setEditing(false);
    setMappedCount(0);
    setHeadingCount(0);
    setTableFieldCount(0);
    setMappedTableCount(0);
    setProtectedCount(0);
  };

  const buildHeadingSurfaces = (data: AstPayload) => {
    const records: HeadingRecord[] = [];
    const sourceHeadings = data.ast.blocks.filter((block) => block.type === "heading");
    sourceHeadings.forEach((block, index) => {
      const sectionIndex = index + 1;
      const editAnchor = editAnchorForSection(sectionIndex);
      const heading = editAnchor?.closest<HTMLElement>(".wiki-heading");
      const marker = editAnchor?.closest<HTMLElement>(".wiki-edit-section");
      const host = marker?.parentElement as HTMLElement | null;
      const parts = headingParts(block.raw);
      if (!heading || !host || !parts) return;

      const oldDisplay = host.style.display;
      host.style.display = "none";
      const surface = document.createElement("span");
      surface.className = "kpoparkiveAstHeadingSurface";
      surface.contentEditable = "true";
      surface.spellcheck = true;
      surface.dataset.ve3NodeId = block.id;
      surface.dataset.ve3NodeType = "heading";
      surface.innerHTML = headingEditorHtml(parts.wikitext);
      const record: HeadingRecord = {
        nodeId: block.id,
        originalWikitext: block.raw,
        originalLevel: parts.level,
        level: parts.level,
        host,
        oldDisplay,
        surface,
      };
      surface.addEventListener("focusin", () => activateSurface(surface, record));
      surface.addEventListener("mousedown", () => activateSurface(surface, record));
      surface.addEventListener("click", (event) => {
        const anchor = (event.target as Element | null)?.closest?.("a");
        if (anchor) event.preventDefault();
      });
      heading.appendChild(surface);
      records.push(record);
    });
    headingsRef.current = records;
    setHeadingCount(records.length);
  };

  const buildSurfaces = (data: AstPayload, requestedSection: number | null) => {
    cleanup();
    const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
    if (!article) throw new Error("Rendered wiki article was not found");
    document.body.classList.add("kpoparkiveAstEditing");
    article.classList.add("kpoparkiveAstCanvas");

    const roots = sectionRootsFromPage();
    const grouped = sectionedBlocks(data.ast.blocks);
    const created: SurfaceRecord[] = [];

    buildHeadingSurfaces(data);

    for (const [section, blocks] of grouped.entries()) {
      const root = section === 0 ? article : roots.get(section);
      if (!root) continue;
      const used = new Set<HTMLElement>();

      for (const block of blocks) {
        if (!directSafe(block)) continue;
        const candidate = bestUniqueCandidate(root, block, used, section === 0);
        if (!candidate) continue;
        used.add(candidate);

        const surface = document.createElement("div");
        surface.className = "kpoparkiveAstSurface";
        surface.contentEditable = "true";
        surface.spellcheck = true;
        surface.dataset.ve3NodeId = block.id;
        surface.dataset.ve3NodeType = block.type;
        surface.innerHTML = wikiBlockToEditorHtml(block.raw);
        surface.addEventListener("focusin", () => activateSurface(surface));
        surface.addEventListener("mousedown", () => activateSurface(surface));
        surface.addEventListener("click", (event) => {
          const anchor = (event.target as Element | null)?.closest?.("a");
          if (anchor) event.preventDefault();
        });

        const oldDisplay = candidate.style.display;
        candidate.style.display = "none";
        candidate.dataset.ve3Original = "1";
        candidate.parentNode?.insertBefore(surface, candidate);
        created.push({
          nodeId: block.id,
          nodeType: block.type as "paragraph" | "list",
          originalWikitext: block.raw,
          original: candidate,
          surface,
          oldDisplay,
        });
      }
    }

    const tableResult = buildV3TableSurfaces({
      tables: data.tables || [],
      article,
      sectionRoots: roots,
      onActivate: (surface) => activateSurface(surface),
    });
    tableSurfacesRef.current = tableResult.records;
    setTableFieldCount(tableResult.records.length);
    setMappedTableCount(tableResult.mappedTables);

    const targets = createV3TemplateTargets(data.templates || [], data.tables || []);
    setTemplateDrafts(createV3TemplateDrafts(targets));
    setSelectedTemplateKey(targets.find((target) => target.paramCount > 0)?.key || null);

    const complexBlocks = data.ast.blocks.filter((block) => block.type === "table" || block.type === "template" || block.type === "styled-block" || block.type === "raw-block" || block.type === "media").length;
    const structuredTemplates = (data.templates || []).filter((template) => template.editableParamCount > 0).length;
    const protectedComplex = Math.max(0, complexBlocks - tableResult.mappedTables - structuredTemplates);
    setProtectedCount(protectedComplex);
    surfacesRef.current = created;
    setMappedCount(created.length);
    setEditing(true);

    if (requestedSection && roots.get(requestedSection)) {
      window.setTimeout(() => roots.get(requestedSection)?.scrollIntoView({ block: "start" }), 30);
    }
    setStatus(
      `${created.length} text/list + ${headingsRef.current.length} headings + ${tableResult.records.length} table fields + ` +
      `${targets.reduce((sum, target) => sum + target.editableParamCount, 0)} template parameters are AST-backed`,
    );
  };

  const startEditing = async (requestedSection: number | null) => {
    if (editing || loading) return;
    setLoading(true);
    setStatus("Loading lossless NamuMark AST…");
    try {
      const response = await fetch(`/api/wiki-edit-document-v3?title=${encodeURIComponent(title)}`, { cache: "no-store" });
      const data = await response.json() as AstPayload & { error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error || "Could not load AST editor");
      setPayload(data);
      startedSectionRef.current = requestedSection;
      buildSurfaces(data, requestedSection);
    } catch (error) {
      cleanup();
      setStatus(error instanceof Error ? error.message : "Could not start AST editor");
      window.alert(error instanceof Error ? error.message : "Could not start AST editor");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    const style = document.createElement("style");
    style.dataset.kpoparkiveVe3 = "1";
    style.textContent = V3_STYLES;
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

  useEffect(() => {
    if (!editing) return;
    const guard = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.(".thetreeWikiBaseline a") as HTMLAnchorElement | null;
      if (!anchor) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", guard, true);
    return () => document.removeEventListener("click", guard, true);
  }, [editing]);

  const command = (value: Parameters<typeof applyVisualCommand>[0]) => {
    const surface = currentEditableSurface(activeSurfaceRef.current);
    if (!surface) {
      setStatus("Click editable text or a table field first");
      return;
    }
    activeSurfaceRef.current = surface;
    applyVisualCommand(value, surface);
    setStatus(`${value} applied to AST-backed visual content`);
  };

  const unlink = () => {
    const surface = currentEditableSurface(activeSurfaceRef.current);
    if (surface) activeSurfaceRef.current = surface;
    const anchor = activeAnchor(surface);
    if (!surface || !anchor) {
      setStatus("Place the caret inside a link first");
      return;
    }
    unwrapAnchor(anchor);
    surface.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatRemove" }));
    setStatus("Link removed; save will patch the exact AST-backed source range");
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
    const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
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
    const operations: Array<AstOperation | V3RegisteredOperation> = [];

    for (const record of surfacesRef.current) {
      const wikitext = editorElementToWikitext(record.surface);
      const before = normalize(record.originalWikitext);
      const after = normalize(wikitext);
      if (before === after) continue;
      operations.push({ op: "replace-node", nodeId: record.nodeId, wikitext });
    }

    for (const record of headingsRef.current) {
      const parts = headingParts(record.originalWikitext);
      if (!parts) continue;
      const inner = editorElementToWikitext(record.surface).trim();
      const marks = "=".repeat(record.level);
      const wikitext = `${marks} ${inner} ${marks}${parts.eol}`;
      if (wikitext === record.originalWikitext) continue;
      operations.push({ op: "replace-node", nodeId: record.nodeId, wikitext });
    }

    const tableFieldOps = collectV3TableOperations(tableSurfacesRef.current);
    const templateEdits = collectV3TemplateEdits(templateTargets, templateDrafts);
    const fieldByTable = new Map(tableFieldOps.map((operation) => [operation.nodeId, operation.changes]));
    const tableNodeIds = new Set([...fieldByTable.keys(), ...templateEdits.tableParams.keys()]);
    for (const nodeId of tableNodeIds) {
      const fields = fieldByTable.get(nodeId) || [];
      const templateParams = templateEdits.tableParams.get(nodeId) || [];
      operations.push({
        op: "table-structure",
        nodeId,
        fields: fields.length ? fields : undefined,
        templateParams: templateParams.length ? templateParams : undefined,
      });
    }
    operations.push(...templateEdits.standalone);
    try {
      operations.push(...collectV3RegisteredOperations());
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not collect visual editor changes";
      setStatus(message);
      window.alert(message);
      return;
    }

    if (!operations.length) {
      setStatus("No changes were made");
      return;
    }
    if (operations.length > 500) {
      const message = "This edit contains more than 500 structural operations. Save a smaller batch first.";
      setStatus(message);
      window.alert(message);
      return;
    }

    setSaving(true);
    setStatus(`Validating ${operations.length} exact AST edit${operations.length === 1 ? "" : "s"}…`);
    try {
      const response = await fetch("/api/wiki-edit-document-v3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          baseRevisionNo: payload.document.publicRevisionNo,
          baseSourceHash: payload.document.sourceHash,
          operations,
          summary: "Visual Editor V3 AST edit",
        }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; proposalId?: string; changes?: string[] };
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit AST edit");
      cleanup();
      setStatus(`Edit proposal submitted${result.proposalId ? ` · ${result.proposalId}` : ""}`);
      window.alert("Edit proposal submitted. The original NamuMark remains unchanged until approval.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save AST edit");
      window.alert(error instanceof Error ? error.message : "Could not save AST edit");
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return loading ? <div className="kpoparkiveAstStatus"><b>V3</b> {status}</div> : null;
  }

  return (
    <>
      <div className="kpoparkiveAstToolbar" role="toolbar" aria-label="Kpoparkive AST Visual Editor V3">
        <strong>Visual Editor V3 · AST</strong>
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
        <b>Lossless AST</b>
        <span>{status}</span>
        {stats ? <span>{stats.linkCount} links · {stats.headingCount} headings · {stats.tableCount} tables · {stats.templateCount} standalone templates</span> : null}
        <span>{mappedCount} text/list · {headingCount} headings · {tableFieldCount} table fields · {templateParamCount} template params · {protectedCount} protected</span>
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
