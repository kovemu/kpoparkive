"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyVisualCommand,
  applyVisualTextColor,
  editorElementToWikitext,
  visualEditorPlainText,
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
  blocks: EasyBlock[];
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

type Insertion = {
  id: string;
  sectionKey: string;
  label: string;
  wikitext: string;
};

type Panel = "tables" | "templates" | "insert-table" | "insert-template" | "insert-media" | null;

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
    .replace(/\s*\(Note:[\s\S]*$/g, "")
    .replace(/\[\s*\d+(?:\s*[-–]\s*\d+)?\s*\]/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

function tokenOverlapScore(expected: string, actual: string) {
  const tokens = (value: string) => normalized(value)
    .replace(/\s*\(Note:[\s\S]*$/g, "")
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
  const prefix = a.slice(0, Math.min(100, a.length));
  if (prefix.length >= 20 && b.includes(prefix)) return 0.82;
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
    if (score > bestScore) { best = candidate; bestScore = score; }
  }
  if (bestScore >= 0.52) return best;
  if (available.length === 1) return available[0];
  if (best && bestScore >= 0.34 && comparable(block.plainText).length >= 24) return best;
  return null;
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

export default function FullPageVisualEditor({ title }: { title: string }) {
  const [editing, setEditing] = useState(false);
  const [payload, setPayload] = useState<PagePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [summary, setSummary] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [insertOpen, setInsertOpen] = useState(false);
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

  const surfacesRef = useRef<SurfaceRecord[]>([]);
  const activeEditorRef = useRef<HTMLElement | null>(null);
  const activeSectionRef = useRef<string>("section:1");
  const editLinkHandlersRef = useRef<Array<{ anchor: HTMLAnchorElement; handler: (event: Event) => void }>>([]);

  const loadPayload = async () => {
    const response = await fetch(`/api/wiki-edit-document?title=${encodeURIComponent(title)}`, { cache: "no-store" });
    const data = await response.json() as PagePayload & { error?: string };
    if (!response.ok || !data.ok) throw new Error(data.error || "Could not load the page editor.");
    return data;
  };

  const restoreSurfaces = () => {
    for (const item of surfacesRef.current) {
      item.surface.remove();
      item.original.style.removeProperty("display");
      item.original.removeAttribute("data-kpoparkive-page-edit-hidden");
    }
    surfacesRef.current = [];
    activeEditorRef.current = null;
    document.body.classList.remove("kpoparkivePageEditing");
  };

  const buildSurfaces = (data: PagePayload) => {
    restoreSurfaces();
    const sectionRoots = new Map<number, HTMLElement>();
    for (const anchor of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="section="]'))) {
      const sectionNumber = sectionNumberFromEditLink(anchor);
      if (sectionNumber === null || sectionRoots.has(sectionNumber)) continue;
      const root = findHeadingContent(anchor);
      if (root) sectionRoots.set(sectionNumber, root);
    }

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
        surface.innerHTML = wikiBlockToEditorHtml(block.originalWikitext);
        surface.addEventListener("focus", () => {
          activeEditorRef.current = surface;
          activeSectionRef.current = section.key;
        });
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
    document.body.classList.add("kpoparkivePageEditing");
    surfacesRef.current[0]?.surface.focus();
  };

  const startEditing = async () => {
    if (editing || loading) return;
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
      setEditing(true);
      requestAnimationFrame(() => buildSurfaces(data));
    } catch (error) {
      window.alert(error instanceof Error ? error.message : "Could not start Visual Editor.");
    } finally {
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
          void startEditing();
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
  }, [title, editing, loading]);

  const runCommand = (command: VisualEditToolbarCommand) => {
    applyVisualCommand(command, activeEditorRef.current);
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

  const saveAll = async () => {
    if (!payload || saving) return;
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

    if (!blockChanges.length && !tableChanges.length && !templateChanges.length && !insertions.length) {
      window.alert("No changes were made.");
      return;
    }

    setSaving(true);
    try {
      const response = await fetch("/api/wiki-edit-document", {
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
          insertions: insertions.map(({ sectionKey, wikitext }) => ({ sectionKey, wikitext })),
        }),
      });
      const result = await response.json() as { ok?: boolean; error?: string; changes?: string[] };
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit this page edit.");
      restoreSurfaces();
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
    if (insertions.length || surfacesRef.current.some((item) => normalized(editorElementToWikitext(item.surface)) !== normalized(item.block.originalWikitext))) {
      if (!window.confirm("Discard your page edits?")) return;
    }
    restoreSurfaces();
    setEditing(false);
    setPanel(null);
    setInsertOpen(false);
  };

  const tableCount = payload?.tables.length || 0;
  const templateCount = payload?.templates.length || 0;
  const queuedCount = insertions.length;
  const currentSectionName = useMemo(() => payload?.sections.find((section) => section.key === activeSectionRef.current)?.heading || "current section", [payload, editing]);

  if (!editing) return loading ? <div className="kpoparkivePageEditorLoading">Opening Visual Editor…</div> : null;

  return (
    <>
      <div className="kpoparkivePageEditorToolbar" role="toolbar" aria-label="Full page visual editor">
        <div className="kpoparkivePageEditorTitle"><span>EDIT PAGE</span><strong>{title}</strong></div>
        <div className="kpoparkivePageEditorTools">
          <button type="button" onClick={() => runCommand("undo")} title="Undo">↶</button>
          <button type="button" onClick={() => runCommand("redo")} title="Redo">↷</button>
          <span className="kpoparkiveToolDivider" />
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
          <span className="kpoparkiveToolDivider" />
          <button type="button" onClick={() => runCommand("link")} title="Link">🔗</button>
          <button type="button" onClick={() => runCommand("citation")} title="Citation">Cite</button>
          <button type="button" className="kpoparkiveStructureButton" onClick={() => setPanel(panel === "tables" ? null : "tables")}>Tables <small>{tableCount}</small></button>
          <button type="button" className="kpoparkiveStructureButton" onClick={() => setPanel(panel === "templates" ? null : "templates")}>Templates <small>{templateCount}</small></button>
          <div className="kpoparkiveInsertMenuWrap">
            <button type="button" className="kpoparkiveInsertButton" onClick={() => setInsertOpen((value) => !value)}>Insert ▾</button>
            {insertOpen ? (
              <div className="kpoparkiveInsertMenu">
                <button type="button" onClick={() => addInsertion("Paragraph", "New paragraph")}>Paragraph</button>
                <button type="button" onClick={() => {
                  const heading = window.prompt("Section heading");
                  if (heading?.trim()) addInsertion("Heading", `== ${heading.trim()} ==`);
                }}>Heading</button>
                <button type="button" onClick={() => { setPanel("insert-table"); setInsertOpen(false); }}>Table</button>
                <button type="button" onClick={() => { setPanel("insert-template"); setInsertOpen(false); }}>Template</button>
                <button type="button" onClick={() => { setMediaType("image"); setPanel("insert-media"); setInsertOpen(false); }}>Image</button>
                <button type="button" onClick={() => { setMediaType("youtube"); setPanel("insert-media"); setInsertOpen(false); }}>YouTube</button>
                <button type="button" onClick={() => addInsertion("Divider", "----")}>Divider</button>
              </div>
            ) : null}
          </div>
        </div>
        <div className="kpoparkivePageEditorActions">
          <button type="button" className="is-cancel" onClick={cancelAll} disabled={saving}>Cancel</button>
          <button type="button" className="is-save" onClick={() => void saveAll()} disabled={saving}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>

      <div className="kpoparkivePageEditorStatus">
        <input value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={500} placeholder="Describe what you changed (optional)" />
        <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} placeholder="Display name (optional)" />
        <span>Editing whole page · Insert location: {currentSectionName}{queuedCount ? ` · ${queuedCount} new block${queuedCount === 1 ? "" : "s"} queued` : ""}</span>
      </div>

      {queuedCount ? (
        <div className="kpoparkiveQueuedInsertions">
          {insertions.map((item) => <span key={item.id}>{item.label}<button type="button" onClick={() => setInsertions((current) => current.filter((entry) => entry.id !== item.id))}>×</button></span>)}
        </div>
      ) : null}

      {panel === "tables" && payload ? (
        <aside className="kpoparkiveGenericInspector">
          <header><div><strong>Tables</strong><span>Generic table editor. Cell content changes without rewriting table layout, colors, spans or options.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="kpoparkiveInspectorBody">
            {payload.tables.map((table, index) => (
              <section key={table.key} className="kpoparkiveInspectorGroup">
                <h3>{table.sectionHeading === "Document lead" ? `Lead table ${index + 1}` : table.sectionHeading}</h3>
                <p>{table.editableCount} editable cells · {table.lockedCount} protected structural cells</p>
                <div className="kpoparkiveTableGrid">
                  {table.fields.map((field) => (
                    <label key={field.key}><span>R{field.row} C{field.column}</span><input value={tableDrafts[table.key]?.[field.key] ?? field.valueWikitext} onChange={(event) => setTableDrafts((current) => ({ ...current, [table.key]: { ...(current[table.key] || {}), [field.key]: event.target.value } }))} /></label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </aside>
      ) : null}

      {panel === "templates" && payload ? (
        <aside className="kpoparkiveGenericInspector">
          <header><div><strong>Templates</strong><span>Every include() call uses the same generic parameter form. No page-specific template logic.</span></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
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
