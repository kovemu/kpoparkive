"use client";

import { useEffect, useRef, useState } from "react";
import {
  applyVisualCommand,
  applyVisualTextColor,
  editorElementToWikitext,
  wikiBlockToEditorHtml,
  type VisualEditToolbarCommand,
} from "../../lib/wikiVisualEdit";

type EasyBlock = {
  key: string;
  blockIndex: number;
  plainText: string;
  originalWikitext: string;
  editable: boolean;
  lockedReason: string | null;
};

type EasySection = {
  key: string;
  sectionIndex: number;
  level: number;
  heading: string;
  headingRaw?: string;
  blocks: EasyBlock[];
};

type HeadingModel = {
  key: string;
  sectionIndex: number;
  level: number;
  headingRaw: string;
};

type TableField = {
  key: string;
  row: number;
  column: number;
  label: string;
  valueWikitext: string;
  plainText: string;
};

type TableModel = {
  key: string;
  sectionKey: string;
  sectionHeading: string;
  blockKey: string;
  blockIndex: number;
  editableCount: number;
  lockedCount: number;
  originalWikitext: string;
  fields: TableField[];
};

type TemplateParam = {
  key: string;
  name: string | null;
  value: string;
  positional: boolean;
};

type TemplateModel = {
  key: string;
  name: string;
  originalWikitext: string;
  params: TemplateParam[];
};

type PagePayload = {
  ok: boolean;
  editorVersion: string;
  document: {
    title: string;
    publicRevisionNo: number;
    sourceMode: "captured" | "published";
  };
  sourceWikitext: string;
  headings: HeadingModel[];
  sections: EasySection[];
  tables: TableModel[];
  templates: TemplateModel[];
};

type SurfaceRecord = {
  sectionKey: string;
  block: EasyBlock;
  original: HTMLElement;
  surface: HTMLElement;
};

type DirectSurfaceRecord = {
  sectionKey: string;
  surface: HTMLElement;
  cleanup: () => void;
};

type HeadingSurfaceRecord = {
  sectionKey: string;
  sectionIndex: number;
  originalWikitext: string;
  originalLevel: number;
  level: number;
  host: HTMLElement;
  oldDisplay: string;
  surface: HTMLElement;
};

type Insertion = {
  id: string;
  sectionKey: string;
  label: string;
  wikitext: string;
};

type Panel = "tables" | "templates" | "insert-table" | "insert-template" | "insert-media" | null;

type InsertPosition = { top: number; left: number };

const V2_STYLES = `
body.kpoparkivePageEditing { padding-top: 112px; }
body.kpoparkivePageEditing .wiki-edit-section { display: none !important; }

.kpoparkivePageEditorToolbar.kpoparkiveEditorV2 {
  min-height: 66px;
  padding: 9px 14px;
  border-bottom: 3px solid #6b3ce8;
  background: linear-gradient(180deg, #ffffff 0%, #f8f6ff 100%);
  box-shadow: 0 8px 28px rgba(51, 34, 92, .16);
  overflow: visible;
}
.kpoparkiveEditorV2 .kpoparkivePageEditorTitle {
  border-right: 1px solid #ddd7ec;
  padding-right: 16px;
}
.kpoparkiveEditorV2 .kpoparkivePageEditorTitle span { color: #6b3ce8; }
.kpoparkiveEditorV2 .kpoparkivePageEditorTitle strong { font-size: 17px; }
.kpoparkiveEditorV2 .kpoparkivePageEditorTools {
  overflow-x: auto;
  overflow-y: hidden;
  padding: 3px 2px;
}
.kpoparkiveEditorV2 .kpoparkivePageEditorTools > button,
.kpoparkiveEditorV2 .kpoparkiveColorTool,
.kpoparkiveEditorV2 .kpoparkiveHeadingLevelSelect {
  height: 38px;
  border: 1px solid #ddd9e7;
  border-radius: 7px;
  background: #fff;
  box-shadow: 0 1px 2px rgba(30, 22, 50, .04);
}
.kpoparkiveEditorV2 .kpoparkivePageEditorTools > button:hover,
.kpoparkiveEditorV2 .kpoparkiveColorTool:hover {
  border-color: #b8a8e7;
  background: #f2edff;
  color: #5b31ca;
}
.kpoparkiveEditorV2 .kpoparkiveInsertButton {
  border-color: #6b3ce8 !important;
  background: #6b3ce8 !important;
  color: #fff !important;
  font-weight: 850;
  padding-inline: 13px !important;
}
.kpoparkiveEditorV2 .kpoparkiveInsertButton:hover { background: #5b31ce !important; }
.kpoparkiveEditorV2 .kpoparkiveStructureButton { font-weight: 750; }
.kpoparkiveHeadingLevelSelect {
  min-width: 106px;
  padding: 0 8px;
  color: #40384e;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
  outline: none;
}
.kpoparkiveHeadingLevelSelect:disabled { opacity: .48; }
.kpoparkiveHeadingEditSurface {
  display: inline-block;
  min-width: 90px;
  margin-left: .2em;
  padding: 1px 6px 2px;
  border: 1px dashed #8a65e8;
  border-radius: 5px;
  outline: 0;
  background: rgba(107, 60, 232, .035);
  color: inherit;
  line-height: inherit;
  vertical-align: baseline;
  cursor: text;
}
.kpoparkiveHeadingEditSurface:hover,
.kpoparkiveHeadingEditSurface:focus {
  border-style: solid;
  border-color: #6b3ce8;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(107, 60, 232, .10);
}
.kpoparkiveHeadingEditSurface a { color: inherit; text-decoration: underline dotted; cursor: text; }
.kpoparkivePageEditorStatus.kpoparkiveEditorV2Status {
  top: 66px;
  min-height: 46px;
  border-bottom: 1px solid #d8d2e7;
  background: #fbfaff;
  box-shadow: 0 4px 12px rgba(42, 30, 72, .05);
}
.kpoparkiveInsertMenu.kpoparkiveInsertMenuFloating {
  position: fixed;
  z-index: 11050;
  top: auto;
  left: auto;
  width: 220px;
  padding: 7px;
  border: 1px solid #cfc7df;
  border-radius: 10px;
  background: #fff;
  box-shadow: 0 18px 46px rgba(31, 22, 55, .24);
  overflow: visible;
}
.kpoparkiveInsertMenuFloating::before {
  content: "INSERT";
  display: block;
  padding: 6px 10px 5px;
  color: #795bd0;
  font-size: 10px;
  font-weight: 900;
  letter-spacing: .08em;
}
.kpoparkiveInsertMenuFloating button {
  display: flex;
  width: 100%;
  align-items: center;
  padding: 10px 11px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #2f2938;
  text-align: left;
  font: inherit;
  cursor: pointer;
}
.kpoparkiveInsertMenuFloating button:hover { background: #f1edfb; color: #5730c0; }
.kpoparkivePageEditSurface,
.kpoparkiveTableInlineSurface,
.kpoparkiveTemplateInlineSurface { caret-color: #6b3ce8; }
.kpoparkiveTableInlineSurface,
.kpoparkiveTemplateInlineSurface {
  min-width: 1.2em;
  outline: 0;
  border: 1px dashed transparent;
  border-radius: 3px;
}
.kpoparkiveTableInlineSurface:hover,
.kpoparkiveTemplateInlineSurface:hover,
.kpoparkiveTableInlineSurface:focus,
.kpoparkiveTemplateInlineSurface:focus {
  border-color: #9b7ae8;
  background: rgba(107, 60, 232, .04);
}
@media (max-width: 900px) {
  body.kpoparkivePageEditing { padding-top: 158px; }
  .kpoparkivePageEditorToolbar.kpoparkiveEditorV2 { min-height: 104px; }
  .kpoparkivePageEditorStatus.kpoparkiveEditorV2Status { top: 104px; }
}
`;

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function comparable(value: string) {
  return normalized(value)
    .replace(/^[•*\-]\s*/gm, "")
    .replace(/\[\s*\d+(?:\s*[-–]\s*\d+)?\s*\]/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function tokenOverlapScore(expected: string, actual: string) {
  const tokens = (value: string) => normalized(value)
    .replace(/\[\s*\d+(?:\s*[-–]\s*\d+)?\s*\]/g, "")
    .split(/[\s,./()]+/)
    .map((token) => token.replace(/[\p{P}\p{S}]/gu, "").toLowerCase())
    .filter((token) => token.length >= 2);
  const a = new Set(tokens(expected));
  const b = new Set(tokens(actual));
  if (!a.size || !b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  return hit / Math.max(a.size, b.size);
}

function textScore(expected: string, actual: string) {
  const a = comparable(expected);
  const b = comparable(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const prefix = a.slice(0, Math.min(120, a.length));
  if (prefix.length >= 20 && b.includes(prefix)) return 0.86;
  return tokenOverlapScore(expected, actual) * 0.9;
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
    const sectionNumber = sectionNumberFromEditLink(anchor);
    if (sectionNumber === null || roots.has(sectionNumber)) continue;
    const root = findHeadingContent(anchor);
    if (root) roots.set(sectionNumber, root);
  }
  return roots;
}

function candidateElements(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLElement>(".wiki-paragraph, .wiki-list, ul, ol, blockquote, .wiki-indent, .wiki-quote"))
    .filter((node) => {
      if (!normalized(node.innerText || node.textContent || "")) return false;
      if (node.closest(".wiki-table")) return false;
      if (node.closest(".wiki-folding")) return false;
      if (node.querySelector("iframe, video, table")) return false;
      return true;
    });
}

function findBestCandidate(root: HTMLElement, block: EasyBlock, used: Set<HTMLElement>) {
  const available = candidateElements(root).filter((candidate) => {
    if (used.has(candidate)) return false;
    if (Array.from(used).some((node) => node.contains(candidate) || candidate.contains(node))) return false;
    return true;
  });
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const candidate of available) {
    const score = textScore(block.plainText, candidate.innerText || candidate.textContent || "");
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  if (bestScore >= 0.52) return best;
  if (available.length === 1) return available[0];
  if (best && bestScore >= 0.34 && comparable(block.plainText).length >= 24) return best;
  return null;
}

function tableTextCandidates(root: HTMLElement) {
  const selector = [
    ".wiki-table td", ".wiki-table th", ".wiki-table a", ".wiki-table span", ".wiki-table p", ".wiki-table div",
    "table td", "table th", "table a", "table span", "table p", "table div",
  ].join(",");
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).filter((node) => {
    if (node.closest(".kpoparkivePageEditorToolbar, .kpoparkivePageEditorStatus, .kpoparkiveGenericInspector")) return false;
    if (node.closest(".kpoparkiveTableInlineSurface")) return false;
    if (!normalized(node.innerText || node.textContent || "")) return false;
    if (!node.matches("td,th") && node.querySelector("table")) return false;
    if (node.matches("td,th") && node.querySelector("table")) return false;
    return true;
  });
}

function findBestTableTextCandidate(root: HTMLElement, field: TableField, claimed: Set<HTMLElement>) {
  const expected = comparable(field.plainText);
  if (!expected) return null;
  let best: HTMLElement | null = null;
  let bestRank = -Infinity;
  for (const candidate of tableTextCandidates(root)) {
    if (claimed.has(candidate)) continue;
    if (Array.from(claimed).some((node) => node.contains(candidate) || candidate.contains(node))) continue;
    const actualText = candidate.innerText || candidate.textContent || "";
    const actual = comparable(actualText);
    if (!actual) continue;
    const score = textScore(field.plainText, actualText);
    const exact = expected === actual;
    if (!exact && score < (expected.length < 16 ? 0.78 : 0.48)) continue;
    const lengthPenalty = Math.abs(expected.length - actual.length) / Math.max(expected.length, actual.length, 1);
    const tagBonus = candidate.matches("a,span,p,.wiki-paragraph") ? 8 : candidate.matches("td,th") ? 2 : 0;
    const rank = score * 100 + (exact ? 35 : 0) + tagBonus - lengthPenalty * 22;
    if (rank > bestRank) {
      bestRank = rank;
      best = candidate;
    }
  }
  return best;
}

function simpleTemplateParam(value: string) {
  const text = normalized(value);
  if (text.length < 2 || text.length > 160) return false;
  if (/^https?:\/\//i.test(text)) return false;
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return false;
  if (/^[\d.\-:]+$/.test(text)) return false;
  if (/\[|\]|\{|\}|\|/.test(text)) return false;
  return true;
}

function headingEditorHtml(wikitext: string) {
  const html = wikiBlockToEditorHtml(wikitext);
  const match = html.match(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/i);
  return match ? match[1] : html.replace(/<\/?p(?:\s[^>]*)?>/gi, "");
}

function createDirectSurface(
  candidate: HTMLElement,
  wikitext: string,
  className: string,
  onInput: (surface: HTMLElement) => void,
) {
  const multiline = wikitext.includes("\n") || candidate.matches("div,p,td,th");
  const surface = document.createElement(multiline ? "div" : "span");
  surface.className = className;
  surface.contentEditable = "true";
  surface.spellcheck = true;
  surface.innerHTML = wikiBlockToEditorHtml(wikitext);
  surface.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest("a");
    if (link) event.preventDefault();
  });
  surface.addEventListener("input", () => onInput(surface));

  if (candidate.matches("td,th")) {
    const holder = document.createElement("span");
    holder.className = "kpoparkiveDirectOriginalHolder";
    while (candidate.firstChild) holder.appendChild(candidate.firstChild);
    holder.style.display = "none";
    candidate.append(holder, surface);
    return {
      surface,
      cleanup: () => {
        if (!holder.isConnected) return;
        surface.remove();
        while (holder.firstChild) candidate.insertBefore(holder.firstChild, holder);
        holder.remove();
      },
    };
  }

  const oldDisplay = candidate.style.display;
  candidate.style.display = "none";
  candidate.setAttribute("data-kpoparkive-direct-hidden", "1");
  candidate.parentNode?.insertBefore(surface, candidate);
  return {
    surface,
    cleanup: () => {
      surface.remove();
      candidate.style.display = oldDisplay;
      candidate.removeAttribute("data-kpoparkive-direct-hidden");
    },
  };
}

function buildTableWikitext(rows: number, columns: number) {
  const safeRows = Math.max(1, Math.min(30, rows));
  const safeColumns = Math.max(1, Math.min(12, columns));
  return Array.from({ length: safeRows }, (_, row) => {
    const cells = Array.from({ length: safeColumns }, (_, column) => row === 0 ? `Column ${column + 1}` : "");
    return `|| ${cells.join(" || ")} ||`;
  }).join("\n");
}

function buildTemplateWikitext(name: string, params: Array<{ name: string; value: string }>) {
  const clean = name.trim();
  if (!clean) return "";
  const rendered = params
    .filter((param) => param.name.trim() || param.value.trim())
    .map((param) => param.name.trim() ? `${param.name.trim()}=${param.value.trim()}` : param.value.trim());
  return `[include(${clean}${rendered.length ? `, ${rendered.join(", ")}` : ""})]`;
}

export default function FullPageVisualEditorV2({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [summary, setSummary] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [insertOpen, setInsertOpen] = useState(false);
  const [insertPosition, setInsertPosition] = useState<InsertPosition>({ top: 72, left: 500 });
  const [tableDrafts, setTableDrafts] = useState<Record<string, Record<string, string>>>({});
  const [templateDrafts, setTemplateDrafts] = useState<Record<string, { name: string; params: Array<{ name: string; value: string }> }>>({});
  const [insertions, setInsertions] = useState<Insertion[]>([]);
  const [newTableRows, setNewTableRows] = useState(3);
  const [newTableColumns, setNewTableColumns] = useState(3);
  const [newTemplateName, setNewTemplateName] = useState("틀:");
  const [newTemplateParams, setNewTemplateParams] = useState<Array<{ name: string; value: string }>>([{ name: "", value: "" }]);
  const [mediaType, setMediaType] = useState<"image" | "youtube">("image");
  const [mediaValue, setMediaValue] = useState("");
  const [mediaWidth, setMediaWidth] = useState("500");
  const [activeSectionKey, setActiveSectionKey] = useState("section:1");
  const [activeHeadingKey, setActiveHeadingKey] = useState<string | null>(null);
  const [activeHeadingLevel, setActiveHeadingLevel] = useState(2);

  const surfacesRef = useRef<SurfaceRecord[]>([]);
  const directSurfacesRef = useRef<DirectSurfaceRecord[]>([]);
  const headingSurfacesRef = useRef<HeadingSurfaceRecord[]>([]);
  const activeEditorRef = useRef<HTMLElement | null>(null);
  const activeSectionRef = useRef<string>("section:1");
  const editLinkHandlersRef = useRef<Array<{ anchor: HTMLAnchorElement; handler: (event: Event) => void }>>([]);
  const editingRef = useRef(false);
  const loadingRef = useRef(false);
  const insertButtonRef = useRef<HTMLButtonElement | null>(null);
  const insertMenuRef = useRef<HTMLDivElement | null>(null);

  editingRef.current = editing;
  loadingRef.current = loading;

  const activateSection = (sectionKey: string, editor?: HTMLElement | null, heading?: HeadingSurfaceRecord | null) => {
    activeSectionRef.current = sectionKey;
    setActiveSectionKey(sectionKey);
    if (editor !== undefined) activeEditorRef.current = editor;
    if (heading) {
      setActiveHeadingKey(heading.sectionKey);
      setActiveHeadingLevel(heading.level);
    } else {
      setActiveHeadingKey(null);
    }
  };

  const loadPayload = async () => {
    const response = await fetch(`/api/wiki-edit-document-v2?title=${encodeURIComponent(title)}`, { cache: "no-store" });
    const data = await response.json() as PagePayload & { error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error || "Could not load the page editor.");
    return data;
  };

  const restoreSurfaces = () => {
    for (const item of directSurfacesRef.current.slice().reverse()) item.cleanup();
    directSurfacesRef.current = [];
    for (const item of surfacesRef.current) {
      item.surface.remove();
      item.original.style.removeProperty("display");
      item.original.removeAttribute("data-kpoparkive-page-edit-hidden");
    }
    surfacesRef.current = [];
    for (const item of headingSurfacesRef.current) {
      item.surface.remove();
      item.host.style.display = item.oldDisplay;
    }
    headingSurfacesRef.current = [];
    activeEditorRef.current = null;
    setActiveHeadingKey(null);
    document.body.classList.remove("kpoparkivePageEditing");
  };

  const buildHeadingSurfaces = (data: PagePayload) => {
    for (const model of data.headings || []) {
      const editAnchor = editAnchorForSection(model.sectionIndex);
      const heading = editAnchor?.closest<HTMLElement>(".wiki-heading");
      const marker = editAnchor?.closest<HTMLElement>(".wiki-edit-section");
      const host = marker?.parentElement as HTMLElement | null;
      if (!heading || !host) continue;

      const oldDisplay = host.style.display;
      host.style.display = "none";
      const surface = document.createElement("span");
      surface.className = "kpoparkiveHeadingEditSurface";
      surface.contentEditable = "true";
      surface.spellcheck = true;
      surface.dataset.sectionKey = model.key;
      surface.dataset.editorKind = "heading";
      surface.innerHTML = headingEditorHtml(model.headingRaw);
      const record: HeadingSurfaceRecord = {
        sectionKey: model.key,
        sectionIndex: model.sectionIndex,
        originalWikitext: model.headingRaw,
        originalLevel: model.level,
        level: model.level,
        host,
        oldDisplay,
        surface,
      };
      surface.addEventListener("focus", () => activateSection(model.key, surface, record));
      surface.addEventListener("click", (event) => {
        const link = (event.target as Element | null)?.closest("a");
        if (link) event.preventDefault();
      });
      heading.appendChild(surface);
      headingSurfacesRef.current.push(record);
    }
  };

  const buildSurfaces = (data: PagePayload, preferredSectionIndex: number | null) => {
    restoreSurfaces();
    const sectionRoots = sectionRootsFromPage();
    const sectionByKey = new Map(data.sections.map((section) => [section.key, section]));

    buildHeadingSurfaces(data);

    for (const section of data.sections) {
      if (section.sectionIndex === 0) continue;
      const root = sectionRoots.get(section.sectionIndex);
      if (!root) continue;
      const used = new Set<HTMLElement>();
      for (const block of section.blocks.filter((item) => item.editable)) {
        const original = findBestCandidate(root, block, used);
        if (!original) continue;
        used.add(original);
        const surface = document.createElement("div");
        surface.className = "kpoparkivePageEditSurface";
        surface.contentEditable = "true";
        surface.spellcheck = true;
        surface.dataset.blockKey = block.key;
        surface.dataset.sectionKey = section.key;
        surface.dataset.editorKind = "text";
        surface.innerHTML = wikiBlockToEditorHtml(block.originalWikitext);
        surface.addEventListener("focus", () => activateSection(section.key, surface, null));
        surface.addEventListener("click", (event) => {
          const link = (event.target as Element | null)?.closest("a");
          if (link) event.preventDefault();
        });
        original.style.display = "none";
        original.setAttribute("data-kpoparkive-page-edit-hidden", "1");
        original.parentNode?.insertBefore(surface, original);
        surfacesRef.current.push({ sectionKey: section.key, block, original, surface });
      }
    }

    for (const table of data.tables) {
      const section = sectionByKey.get(table.sectionKey);
      if (!section || section.sectionIndex === 0) continue;
      const root = sectionRoots.get(section.sectionIndex);
      if (!root) continue;
      const claimed = new Set<HTMLElement>();
      const fields = [...table.fields].sort((a, b) => comparable(b.plainText).length - comparable(a.plainText).length);
      for (const field of fields) {
        const candidate = findBestTableTextCandidate(root, field, claimed);
        if (!candidate) continue;
        claimed.add(candidate);
        const created = createDirectSurface(candidate, field.valueWikitext, "kpoparkiveTableInlineSurface", (surface) => {
          const proposed = editorElementToWikitext(surface);
          setTableDrafts((current) => ({
            ...current,
            [table.key]: { ...(current[table.key] || {}), [field.key]: proposed },
          }));
        });
        created.surface.dataset.tableKey = table.key;
        created.surface.dataset.fieldKey = field.key;
        created.surface.dataset.editorKind = "table";
        created.surface.addEventListener("focus", () => activateSection(table.sectionKey, created.surface, null));
        directSurfacesRef.current.push({ sectionKey: table.sectionKey, ...created });
      }
    }

    const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
    if (article) {
      const valueCounts = new Map<string, number>();
      for (const template of data.templates) {
        for (const param of template.params) {
          if (!simpleTemplateParam(param.value)) continue;
          const key = normalized(param.value);
          valueCounts.set(key, (valueCounts.get(key) || 0) + 1);
        }
      }
      for (const template of data.templates) {
        template.params.forEach((param, paramIndex) => {
          if (!simpleTemplateParam(param.value) || valueCounts.get(normalized(param.value)) !== 1) return;
          const candidates = Array.from(article.querySelectorAll<HTMLElement>("a, span, .wiki-paragraph, p"))
            .filter((node) => !node.closest("table") && !node.closest(".wiki-heading") && !node.closest(".kpoparkivePageEditSurface") && normalized(node.innerText || node.textContent || "") === normalized(param.value));
          if (candidates.length !== 1) return;
          const candidate = candidates[0];
          const created = createDirectSurface(candidate, param.value, "kpoparkiveTemplateInlineSurface", (surface) => {
            const proposed = editorElementToWikitext(surface);
            setTemplateDrafts((current) => {
              const currentDraft = current[template.key] || {
                name: template.name,
                params: template.params.map((item) => ({ name: item.name || "", value: item.value })),
              };
              return {
                ...current,
                [template.key]: {
                  ...currentDraft,
                  params: currentDraft.params.map((item, index) => index === paramIndex ? { ...item, value: proposed } : item),
                },
              };
            });
          });
          created.surface.dataset.templateKey = template.key;
          created.surface.dataset.editorKind = "template";
          created.surface.addEventListener("focus", () => {
            activeEditorRef.current = created.surface;
            setActiveHeadingKey(null);
          });
          directSurfacesRef.current.push({ sectionKey: activeSectionRef.current, ...created });
        });
      }
    }

    document.body.classList.add("kpoparkivePageEditing");
    const preferredKey = preferredSectionIndex === null ? null : `section:${preferredSectionIndex}`;
    if (preferredKey) {
      activeSectionRef.current = preferredKey;
      setActiveSectionKey(preferredKey);
    }
    const preferredHeading = preferredKey ? headingSurfacesRef.current.find((item) => item.sectionKey === preferredKey) : null;
    const preferredBody = preferredKey
      ? [...surfacesRef.current.map((item) => ({ sectionKey: item.sectionKey, surface: item.surface })), ...directSurfacesRef.current]
        .find((item) => item.sectionKey === preferredKey)?.surface
      : null;
    (preferredBody || preferredHeading?.surface)?.focus({ preventScroll: true });
  };

  const startEditing = async (preferredSectionIndex: number | null, anchor?: HTMLAnchorElement) => {
    if (editingRef.current || loadingRef.current) return;
    const heading = anchor?.closest<HTMLElement>(".wiki-heading") || null;
    const viewportTop = heading?.getBoundingClientRect().top ?? null;
    loadingRef.current = true;
    setLoading(true);
    try {
      const data = await loadPayload();
      setPayload(data);
      setTableDrafts(Object.fromEntries(data.tables.map((table) => [table.key, Object.fromEntries(table.fields.map((field) => [field.key, field.valueWikitext]))])));
      setTemplateDrafts(Object.fromEntries(data.templates.map((template) => [template.key, {
        name: template.name,
        params: template.params.map((param) => ({ name: param.name || "", value: param.value })),
      }])));
      setInsertions([]);
      setSummary("");
      setInsertOpen(false);
      editingRef.current = true;
      setEditing(true);
      requestAnimationFrame(() => {
        buildSurfaces(data, preferredSectionIndex);
        requestAnimationFrame(() => {
          if (heading && viewportTop !== null) {
            const moved = heading.getBoundingClientRect().top - viewportTop;
            if (Math.abs(moved) > 0.5) window.scrollBy({ top: moved, left: 0, behavior: "auto" });
          }
        });
      });
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not start Visual Editor.");
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  };

  useEffect(() => {
    const wireLinks = () => {
      for (const { anchor, handler } of editLinkHandlersRef.current) anchor.removeEventListener("click", handler);
      editLinkHandlersRef.current = [];
      for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="section="]'))) {
        const handler = (event: Event) => {
          if (!/편집|edit/i.test(anchor.textContent || "")) return;
          event.preventDefault();
          event.stopPropagation();
          const sectionNumber = sectionNumberFromEditLink(anchor);
          void startEditing(sectionNumber, anchor);
        };
        anchor.addEventListener("click", handler);
        editLinkHandlersRef.current.push({ anchor, handler });
      }
    };
    const timer = window.setTimeout(wireLinks, 0);
    return () => {
      window.clearTimeout(timer);
      for (const { anchor, handler } of editLinkHandlersRef.current) anchor.removeEventListener("click", handler);
      editLinkHandlersRef.current = [];
      restoreSurfaces();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title]);

  useEffect(() => {
    if (!insertOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (insertMenuRef.current?.contains(target) || insertButtonRef.current?.contains(target))) return;
      setInsertOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInsertOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [insertOpen]);

  const runCommand = (command: VisualEditToolbarCommand) => {
    if (activeEditorRef.current?.dataset.editorKind === "heading" && ["bulletList", "orderedList", "alignLeft", "alignCenter", "alignRight", "alignJustify"].includes(command)) return;
    applyVisualCommand(command, activeEditorRef.current);
  };

  const changeHeadingLevel = (level: number) => {
    if (!activeHeadingKey) return;
    const record = headingSurfacesRef.current.find((item) => item.sectionKey === activeHeadingKey);
    if (!record) return;
    const safe = Math.max(2, Math.min(6, level));
    record.level = safe;
    setActiveHeadingLevel(safe);
  };

  const toggleInsertMenu = () => {
    if (insertOpen) {
      setInsertOpen(false);
      return;
    }
    const rect = insertButtonRef.current?.getBoundingClientRect();
    const width = 220;
    const left = Math.max(10, Math.min(rect?.left ?? 10, window.innerWidth - width - 10));
    const top = Math.min((rect?.bottom ?? 64) + 8, window.innerHeight - 80);
    setInsertPosition({ top, left });
    setInsertOpen(true);
  };

  const addInsertion = (label: string, wikitext: string) => {
    const clean = wikitext.trim();
    if (!clean) return;
    setInsertions((current) => [...current, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      sectionKey: activeSectionRef.current || "section:1",
      label,
      wikitext: clean,
    }]);
    setPanel(null);
    setInsertOpen(false);
  };

  const headingChanges = () => headingSurfacesRef.current
    .map((item) => ({
      sectionKey: item.sectionKey,
      proposedWikitext: editorElementToWikitext(item.surface),
      level: item.level,
      originalWikitext: item.originalWikitext,
      originalLevel: item.originalLevel,
    }))
    .filter((item) => normalized(item.proposedWikitext) !== normalized(item.originalWikitext) || item.level !== item.originalLevel);

  const templateHasChanges = () => Boolean(payload?.templates.some((template) => {
    const draft = templateDrafts[template.key];
    if (!draft) return false;
    const original = `${template.name}|${template.params.map((param) => `${param.name || ""}=${param.value}`).join("|")}`;
    const next = `${draft.name}|${draft.params.map((param) => `${param.name || ""}=${param.value}`).join("|")}`;
    return original !== next;
  }));

  const saveAll = async () => {
    if (!payload || saving) return;
    const headings = headingChanges();
    if (headings.some((item) => !normalized(item.proposedWikitext) || item.proposedWikitext.includes("\n"))) {
      window.alert("Section titles must contain one non-empty line.");
      return;
    }

    const blockChanges = surfacesRef.current
      .map(({ block, surface }) => ({ blockKey: block.key, proposedWikitext: editorElementToWikitext(surface) }))
      .filter((change) => {
        const original = surfacesRef.current.find((item) => item.block.key === change.blockKey)?.block.originalWikitext || "";
        return normalized(change.proposedWikitext) !== normalized(original);
      });

    const tableChanges = payload.tables.map((table) => ({
      blockKey: table.blockKey,
      changes: table.fields
        .map((field) => ({ key: field.key, proposedWikitext: tableDrafts[table.key]?.[field.key] ?? field.valueWikitext }))
        .filter((change) => {
          const field = table.fields.find((item) => item.key === change.key);
          return field && normalized(change.proposedWikitext) !== normalized(field.valueWikitext);
        }),
    })).filter((table) => table.changes.length);

    const templateChanges = payload.templates.map((template) => {
      const draft = templateDrafts[template.key];
      return {
        templateKey: template.key,
        name: draft?.name ?? template.name,
        params: draft?.params ?? template.params.map((param) => ({ name: param.name || "", value: param.value })),
      };
    }).filter((change) => {
      const template = payload.templates.find((item) => item.key === change.templateKey);
      if (!template) return false;
      const original = `${template.name}|${template.params.map((param) => `${param.name || ""}=${param.value}`).join("|")}`;
      const next = `${change.name}|${change.params.map((param) => `${param.name || ""}=${param.value}`).join("|")}`;
      return original !== next;
    });

    if (!blockChanges.length && !tableChanges.length && !templateChanges.length && !headings.length && !insertions.length) {
      window.alert("No changes were made.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/wiki-edit-document-v2", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: payload.document.title,
          baseRevisionNo: payload.document.publicRevisionNo,
          summary,
          displayName,
          website: "",
          blockChanges,
          tableChanges,
          templateChanges,
          headingChanges: headings.map(({ sectionKey, proposedWikitext, level }) => ({ sectionKey, proposedWikitext, level })),
          insertions: insertions.map(({ sectionKey, wikitext }) => ({ sectionKey, wikitext })),
        }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; changes?: string[] };
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit this page edit.");
      restoreSurfaces();
      editingRef.current = false;
      setEditing(false);
      setPanel(null);
      setInsertOpen(false);
      window.alert(`Page edit submitted for review${result.changes?.length ? ` (${result.changes.length} changes)` : ""}.`);
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not submit this page edit.");
    } finally {
      setSaving(false);
    }
  };

  const cancelAll = () => {
    const textChanged = surfacesRef.current.some((item) => normalized(editorElementToWikitext(item.surface)) !== normalized(item.block.originalWikitext));
    const tableChanged = payload?.tables.some((table) => table.fields.some((field) => normalized(tableDrafts[table.key]?.[field.key] ?? field.valueWikitext) !== normalized(field.valueWikitext))) || false;
    const changed = insertions.length || textChanged || tableChanged || headingChanges().length || templateHasChanges();
    if (changed && !window.confirm("Discard your page edits?")) return;
    restoreSurfaces();
    editingRef.current = false;
    setEditing(false);
    setPanel(null);
    setInsertOpen(false);
  };

  const tableCount = payload?.tables.length || 0;
  const templateCount = payload?.templates.length || 0;
  const queuedCount = insertions.length;
  const currentSectionName = payload?.sections.find((section) => section.key === activeSectionKey)?.heading
    || payload?.headings.find((heading) => heading.key === activeSectionKey)?.headingRaw
    || "current section";

  if (!editing) return loading ? <div className="kpoparkivePageEditorLoading">Opening Visual Editor…</div> : null;

  return (
    <>
      <style>{V2_STYLES}</style>
      <div className="kpoparkivePageEditorToolbar kpoparkiveEditorV2" role="toolbar" aria-label="Full page visual editor">
        <div className="kpoparkivePageEditorTitle"><span>VISUAL EDITOR</span><strong>{title}</strong></div>
        <div className="kpoparkivePageEditorTools">
          <button type="button" onClick={() => runCommand("undo")} title="Undo">↶</button>
          <button type="button" onClick={() => runCommand("redo")} title="Redo">↷</button>
          <span className="kpoparkiveToolDivider" />
          <select className="kpoparkiveHeadingLevelSelect" value={activeHeadingLevel} disabled={!activeHeadingKey} onChange={(event) => changeHeadingLevel(Number(event.target.value))} title="Section level">
            <option value={2}>Heading 1</option>
            <option value={3}>Heading 2</option>
            <option value={4}>Heading 3</option>
            <option value={5}>Heading 4</option>
            <option value={6}>Heading 5</option>
          </select>
          <button type="button" onClick={() => runCommand("bold")} title="Bold"><b>B</b></button>
          <button type="button" onClick={() => runCommand("italic")} title="Italic"><i>I</i></button>
          <button type="button" onClick={() => runCommand("underline")} title="Underline"><u>U</u></button>
          <button type="button" onClick={() => runCommand("strike")} title="Strikethrough"><s>S</s></button>
          <label className="kpoparkiveColorTool" title="Text color">A<input type="color" defaultValue="#6d3ce8" onChange={(event) => applyVisualTextColor(activeEditorRef.current, event.target.value)} /></label>
          <span className="kpoparkiveToolDivider" />
          <button type="button" onClick={() => runCommand("bulletList")} title="Bulleted list">• List</button>
          <button type="button" onClick={() => runCommand("orderedList")} title="Numbered list">1. List</button>
          <button type="button" onClick={() => runCommand("alignLeft")} title="Align left">≡</button>
          <button type="button" onClick={() => runCommand("alignCenter")} title="Align center">≣</button>
          <button type="button" onClick={() => runCommand("alignRight")} title="Align right">≡›</button>
          <button type="button" onClick={() => runCommand("alignJustify")} title="Justify">☰</button>
          <span className="kpoparkiveToolDivider" />
          <button type="button" onClick={() => runCommand("link")} title="Link">Link</button>
          <button type="button" onClick={() => runCommand("citation")} title="Citation">Cite</button>
          <button type="button" className="kpoparkiveStructureButton" onClick={() => setPanel(panel === "tables" ? null : "tables")}>Tables <small>{tableCount}</small></button>
          <button type="button" className="kpoparkiveStructureButton" onClick={() => setPanel(panel === "templates" ? null : "templates")}>Templates <small>{templateCount}</small></button>
          <button ref={insertButtonRef} type="button" className="kpoparkiveInsertButton" onClick={toggleInsertMenu} aria-expanded={insertOpen}>Insert ▾</button>
        </div>
        <div className="kpoparkivePageEditorActions">
          <button type="button" className="is-cancel" onClick={cancelAll} disabled={saving}>Cancel</button>
          <button type="button" className="is-save" onClick={() => void saveAll()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      <div className="kpoparkivePageEditorStatus kpoparkiveEditorV2Status">
        <input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={500} placeholder="Describe what you changed (optional)" />
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} placeholder="Display name (optional)" />
        <span>Whole page editing · headings, text, tables and templates · Insert location: {currentSectionName}{queuedCount ? ` · ${queuedCount} new block${queuedCount === 1 ? "" : "s"} queued` : ""}</span>
      </div>

      {insertOpen ? (
        <div ref={insertMenuRef} className="kpoparkiveInsertMenu kpoparkiveInsertMenuFloating" style={{ top: insertPosition.top, left: insertPosition.left }}>
          <button type="button" onClick={() => addInsertion("Paragraph", "New paragraph")}>Paragraph</button>
          <button type="button" onClick={() => {
            const heading = window.prompt("Section heading");
            if (heading?.trim()) addInsertion("Heading", `== ${heading.trim()} ==`);
          }}>Heading</button>
          <button type="button" onClick={() => {
            const heading = window.prompt("Subheading");
            if (heading?.trim()) addInsertion("Subheading", `=== ${heading.trim()} ===`);
          }}>Subheading</button>
          <button type="button" onClick={() => { setPanel("insert-table"); setInsertOpen(false); }}>Table</button>
          <button type="button" onClick={() => { setPanel("insert-template"); setInsertOpen(false); }}>Template</button>
          <button type="button" onClick={() => { setMediaType("image"); setPanel("insert-media"); setInsertOpen(false); }}>Image</button>
          <button type="button" onClick={() => { setMediaType("youtube"); setPanel("insert-media"); setInsertOpen(false); }}>YouTube</button>
          <button type="button" onClick={() => addInsertion("Divider", "----")}>Divider</button>
        </div>
      ) : null}

      {queuedCount ? (
        <div className="kpoparkiveQueuedInsertions">
          {insertions.map((item) => <span key={item.id}>{item.label}<button type="button" onClick={() => setInsertions((current) => current.filter((entry) => entry.id !== item.id))}>×</button></span>)}
        </div>
      ) : null}

      {panel === "tables" && payload ? (
        <aside className="kpoparkiveGenericInspector">
          <header><div><strong>Tables</strong><span>Visible table text is editable directly on the page. Use this panel for structural text that cannot be safely mapped in place.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="kpoparkiveInspectorBody">
            {payload.tables.map((table, index) => (
              <section key={table.key} className="kpoparkiveInspectorGroup">
                <h3>{table.sectionHeading === "Document lead" ? `Lead table ${index + 1}` : table.sectionHeading}</h3>
                <p>{table.editableCount} editable text fields · {table.lockedCount} protected structural cells</p>
                <div className="kpoparkiveTableGrid">
                  {table.fields.map((field) => (
                    <label key={field.key}><span>R{field.row} C{field.column}</span><textarea rows={field.valueWikitext.includes("\n") ? 4 : 1} value={tableDrafts[table.key]?.[field.key] ?? field.valueWikitext} onChange={(event) => setTableDrafts((current) => ({ ...current, [table.key]: { ...(current[table.key] || {}), [field.key]: event.target.value } }))} /></label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </aside>
      ) : null}

      {panel === "templates" && payload ? (
        <aside className="kpoparkiveGenericInspector">
          <header><div><strong>Templates</strong><span>Visible parameter text can be edited in place. All parsed parameters remain available here.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="kpoparkiveInspectorBody">
            {payload.templates.map((template, index) => {
              const draft = templateDrafts[template.key] || { name: template.name, params: template.params.map((param) => ({ name: param.name || "", value: param.value })) };
              return (
                <section key={template.key} className="kpoparkiveInspectorGroup">
                  <h3>Template {index + 1}</h3>
                  <label className="kpoparkiveInspectorField"><span>Name</span><input value={draft.name} onChange={(event) => setTemplateDrafts((current) => ({ ...current, [template.key]: { ...draft, name: event.target.value } }))} /></label>
                  {draft.params.map((param, paramIndex) => (
                    <div className="kpoparkiveTemplateParamRow" key={`${template.key}:${paramIndex}`}>
                      <input placeholder="Parameter" value={param.name} onChange={(event) => setTemplateDrafts((current) => ({ ...current, [template.key]: { ...draft, params: draft.params.map((item, i) => i === paramIndex ? { ...item, name: event.target.value } : item) } }))} />
                      <input placeholder="Value" value={param.value} onChange={(event) => setTemplateDrafts((current) => ({ ...current, [template.key]: { ...draft, params: draft.params.map((item, i) => i === paramIndex ? { ...item, value: event.target.value } : item) } }))} />
                      <button type="button" onClick={() => setTemplateDrafts((current) => ({ ...current, [template.key]: { ...draft, params: draft.params.filter((_, i) => i !== paramIndex) } }))}>×</button>
                    </div>
                  ))}
                  <button type="button" className="kpoparkiveAddParam" onClick={() => setTemplateDrafts((current) => ({ ...current, [template.key]: { ...draft, params: [...draft.params, { name: "", value: "" }] } }))}>+ Parameter</button>
                </section>
              );
            })}
          </div>
        </aside>
      ) : null}

      {panel === "insert-table" ? (
        <aside className="kpoparkiveGenericInspector is-small">
          <header><div><strong>Insert table</strong><span>Create a generic NamuMark table in {currentSectionName}.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="kpoparkiveInspectorBody">
            <label className="kpoparkiveInspectorField"><span>Rows</span><input type="number" min={1} max={30} value={newTableRows} onChange={(event) => setNewTableRows(Number(event.target.value))} /></label>
            <label className="kpoparkiveInspectorField"><span>Columns</span><input type="number" min={1} max={12} value={newTableColumns} onChange={(event) => setNewTableColumns(Number(event.target.value))} /></label>
            <div className="kpoparkiveInsertPreview">{buildTableWikitext(newTableRows, newTableColumns).split("\n").map((line, index) => <div key={index}>{line}</div>)}</div>
            <button type="button" className="kpoparkivePrimaryPanelAction" onClick={() => addInsertion("Table", buildTableWikitext(newTableRows, newTableColumns))}>Insert table</button>
          </div>
        </aside>
      ) : null}

      {panel === "insert-template" ? (
        <aside className="kpoparkiveGenericInspector is-small">
          <header><div><strong>Insert template</strong><span>Create any include() call with a generic parameter form.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="kpoparkiveInspectorBody">
            <label className="kpoparkiveInspectorField"><span>Template name</span><input value={newTemplateName} onChange={(event) => setNewTemplateName(event.target.value)} placeholder="틀:템플릿명" /></label>
            {newTemplateParams.map((param, index) => (
              <div className="kpoparkiveTemplateParamRow" key={index}>
                <input placeholder="Parameter" value={param.name} onChange={(event) => setNewTemplateParams((current) => current.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />
                <input placeholder="Value" value={param.value} onChange={(event) => setNewTemplateParams((current) => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))} />
                <button type="button" onClick={() => setNewTemplateParams((current) => current.filter((_, i) => i !== index))}>×</button>
              </div>
            ))}
            <button type="button" className="kpoparkiveAddParam" onClick={() => setNewTemplateParams((current) => [...current, { name: "", value: "" }])}>+ Parameter</button>
            <button type="button" className="kpoparkivePrimaryPanelAction" onClick={() => addInsertion("Template", buildTemplateWikitext(newTemplateName, newTemplateParams))}>Insert template</button>
          </div>
        </aside>
      ) : null}

      {panel === "insert-media" ? (
        <aside className="kpoparkiveGenericInspector is-small">
          <header><div><strong>Insert {mediaType === "image" ? "image" : "YouTube"}</strong><span>Add media to {currentSectionName}.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="kpoparkiveInspectorBody">
            <label className="kpoparkiveInspectorField"><span>{mediaType === "image" ? "File name" : "YouTube video ID"}</span><input value={mediaValue} onChange={(event) => setMediaValue(event.target.value)} placeholder={mediaType === "image" ? "example.jpg" : "dQw4w9WgXcQ"} /></label>
            {mediaType === "image" ? <label className="kpoparkiveInspectorField"><span>Width</span><input value={mediaWidth} onChange={(event) => setMediaWidth(event.target.value)} /></label> : null}
            <button type="button" className="kpoparkivePrimaryPanelAction" onClick={() => {
              const value = mediaValue.trim();
              if (!value) return;
              addInsertion(mediaType === "image" ? "Image" : "YouTube", mediaType === "image" ? `[[파일:${value}|width=${mediaWidth.trim() || "500"}]]` : `[youtube(${value})]`);
              setMediaValue("");
            }}>Insert</button>
          </div>
        </aside>
      ) : null}
    </>
  );
}
