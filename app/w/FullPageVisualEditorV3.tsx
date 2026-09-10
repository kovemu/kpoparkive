"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { applyVisualCommand, editorElementToWikitext, wikiBlockToEditorHtml } from "../../lib/wikiVisualEdit";

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

type AtomicRecord = {
  nodeId: string;
  nodeType: string;
  element: HTMLElement;
};

type AstOperation =
  | { op: "replace-node"; nodeId: string; wikitext: string }
  | { op: "unlink"; nodeId: string }
  | { op: "set-link"; nodeId: string; target: string; label?: string };

const V3_STYLES = `
body.kpoparkiveAstEditing { padding-top: 104px; }
body.kpoparkiveAstEditing .wiki-edit-section { display: none !important; }
body.kpoparkiveAstEditing .wiki-heading-content { display: block !important; height: auto !important; max-height: none !important; visibility: visible !important; }
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
.kpoparkiveAstToolbar select:disabled { opacity: .45; cursor: default; }
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
.kpoparkiveAstAtomic { position: relative; }
.kpoparkiveAstAtomic::after {
  content: attr(data-ve3-label);
  position: absolute;
  z-index: 4;
  top: 2px;
  right: 2px;
  padding: 2px 6px;
  border: 1px solid rgba(107,60,232,.25);
  border-radius: 999px;
  background: rgba(255,255,255,.88);
  color: #6845c5;
  font-size: 9px;
  font-weight: 800;
  pointer-events: none;
  opacity: .62;
}
@media (max-width: 760px) {
  body.kpoparkiveAstEditing { padding-top: 142px; }
  .kpoparkiveAstToolbar { min-height: 94px; flex-wrap: wrap; }
  .kpoparkiveAstStatus { top: 94px; }
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

export default function FullPageVisualEditorV3({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("AST Visual Editor V3 ready");
  const [payload, setPayload] = useState<AstPayload | null>(null);
  const [mappedCount, setMappedCount] = useState(0);
  const [headingCount, setHeadingCount] = useState(0);
  const [protectedCount, setProtectedCount] = useState(0);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const [activeHeadingLevel, setActiveHeadingLevel] = useState(2);
  const surfacesRef = useRef<SurfaceRecord[]>([]);
  const headingsRef = useRef<HeadingRecord[]>([]);
  const atomicsRef = useRef<AtomicRecord[]>([]);
  const activeSurfaceRef = useRef<HTMLElement | null>(null);
  const startedSectionRef = useRef<number | null>(null);

  const stats = useMemo(() => payload?.ast.stats || null, [payload]);

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
    for (const record of atomicsRef.current) {
      record.element.classList.remove("kpoparkiveAstAtomic");
      record.element.removeAttribute("data-ve3-label");
      record.element.removeAttribute("data-ve3-node-id");
    }
    atomicsRef.current = [];
    activeSurfaceRef.current = null;
    setActiveHeadingId(null);
    document.body.classList.remove("kpoparkiveAstEditing");
    document.querySelector(".thetreeWikiBaseline")?.classList.remove("kpoparkiveAstCanvas");
    setEditing(false);
    setMappedCount(0);
    setHeadingCount(0);
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
    const atomics: AtomicRecord[] = [];

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

    const structuredCount = data.ast.blocks.filter((block) => block.type === "table" || block.type === "template" || block.type === "styled-block" || block.type === "raw-block" || block.type === "media").length;
    setProtectedCount(structuredCount);
    surfacesRef.current = created;
    atomicsRef.current = atomics;
    setMappedCount(created.length);
    setEditing(true);

    if (requestedSection && roots.get(requestedSection)) {
      window.setTimeout(() => roots.get(requestedSection)?.scrollIntoView({ block: "start" }), 30);
    }
    setStatus(`${created.length} text/list blocks + ${headingsRef.current.length} headings are AST-backed · ${structuredCount} complex blocks preserved`);
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
    const surface = activeSurfaceRef.current;
    if (!surface) {
      setStatus("Click editable text first");
      return;
    }
    applyVisualCommand(value, surface);
    setStatus(`${value} applied to AST-backed visual block`);
  };

  const unlink = () => {
    const surface = activeSurfaceRef.current;
    const anchor = activeAnchor(surface);
    if (!surface || !anchor) {
      setStatus("Place the caret inside a link first");
      return;
    }
    unwrapAnchor(anchor);
    surface.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "formatRemove" }));
    setStatus("Link removed visually; save will rewrite the exact AST node range");
  };

  const changeHeadingLevel = (level: number) => {
    if (!activeHeadingId) return;
    const record = headingsRef.current.find((item) => item.nodeId === activeHeadingId);
    if (!record) return;
    record.level = Math.max(2, Math.min(6, Math.round(level)));
    setActiveHeadingLevel(record.level);
    setStatus(`Heading level set to H${record.level}`);
  };

  const save = async () => {
    if (!payload || saving) return;
    const operations: AstOperation[] = [];
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
    if (!operations.length) {
      setStatus("No changes were made");
      return;
    }

    setSaving(true);
    setStatus(`Validating ${operations.length} AST range edit${operations.length === 1 ? "" : "s"}…`);
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
        <button type="button" className="danger" onClick={() => { cleanup(); setStatus("Edit cancelled"); }}>Cancel</button>
        <button type="button" className="primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</button>
      </div>
      <div className="kpoparkiveAstStatus">
        <b>Lossless AST</b>
        <span>{status}</span>
        {stats ? <span>{stats.linkCount} links · {stats.headingCount} headings · {stats.tableCount} tables · {stats.templateCount} templates</span> : null}
        <span>{mappedCount} text/list · {headingCount} headings · {protectedCount} protected</span>
      </div>
    </>
  );
}
