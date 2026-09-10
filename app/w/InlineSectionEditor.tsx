"use client";

import { useEffect, useRef } from "react";
import {
  applyVisualCommand,
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
  level: number;
  heading: string;
  editableCount: number;
  lockedCount: number;
  blocks: EasyBlock[];
};

type InfoboxField = {
  key: string;
  label: string;
  valueWikitext: string;
  plainText: string;
  editable: boolean;
  lockedReason: string | null;
};

type InfoboxEditModel = {
  key: string;
  editableCount: number;
  lockedCount: number;
  fields: InfoboxField[];
};

type EasyEditResponse = {
  ok: boolean;
  editorVersion?: string;
  document: {
    title: string;
    publicRevisionNo: number;
    sourceMode: "captured" | "published";
  };
  sections: EasySection[];
  infobox?: InfoboxEditModel | null;
};

type EditorItem = {
  block: EasyBlock;
  node: HTMLElement;
  wrapper: HTMLElement;
  original: HTMLElement | null;
};

type ActiveEdit = {
  sectionKey: string;
  headingContent: HTMLElement;
  shell: HTMLElement;
  originals: HTMLElement[];
  editors: EditorItem[];
  activeNode: HTMLElement | null;
};

type InfoboxEditorItem = {
  field: InfoboxField;
  node: HTMLElement;
};

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
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / Math.max(a.size, b.size);
}

function textScore(expected: string, actual: string) {
  const a = comparable(expected);
  const b = comparable(actual);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return Math.min(a.length, b.length) / Math.max(a.length, b.length);
  const prefix = a.slice(0, Math.min(90, a.length));
  if (prefix.length >= 20 && b.includes(prefix)) return 0.82;
  const reversePrefix = b.slice(0, Math.min(90, b.length));
  if (reversePrefix.length >= 20 && a.includes(reversePrefix)) return 0.78;
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
  const all = Array.from(
    root.querySelectorAll<HTMLElement>(
      ".wiki-paragraph, .wiki-list, ul, ol, blockquote, .wiki-indent, .wiki-quote",
    ),
  );

  return all.filter((node) => {
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
  // Sections such as RESCENE/overview contain media + a greeting table and only one
  // actual prose paragraph. The rendered footnote text can make fuzzy matching weak;
  // when there is only one safe prose candidate, replacing it is deterministic.
  if (available.length === 1) return available[0];
  if (best && bestScore >= 0.34 && comparable(block.plainText).length >= 24) return best;
  return null;
}

function createButton(label: string, className: string, title?: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  if (title) button.title = title;
  return button;
}

function commandButton(label: string, command: VisualEditToolbarCommand, title: string) {
  const button = createButton(label, "kpoparkiveVisualTool", title);
  button.dataset.command = command;
  return button;
}

function preventEditorLinkNavigation(node: HTMLElement) {
  node.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest("a");
    if (link) event.preventDefault();
  });
}

export default function InlineSectionEditor({ title }: { title: string }) {
  const cacheRef = useRef<Promise<EasyEditResponse> | null>(null);
  const activeRef = useRef<ActiveEdit | null>(null);

  useEffect(() => {
    let disposed = false;
    let infoboxPanel: HTMLElement | null = null;
    let infoboxEditButton: HTMLButtonElement | null = null;
    let infoboxHost: HTMLElement | null = null;

    const loadData = () => {
      if (!cacheRef.current) {
        cacheRef.current = fetch(`/api/wiki-edit?title=${encodeURIComponent(title)}`, {
          cache: "no-store",
        }).then(async (response) => {
          const data = (await response.json()) as EasyEditResponse & { error?: string };
          if (!response.ok || !data.ok) throw new Error(data.error || "Could not load this page for editing.");
          return data;
        });
      }
      return cacheRef.current;
    };

    const closeEditor = () => {
      const active = activeRef.current;
      if (!active) return;
      for (const original of active.originals) {
        original.style.removeProperty("display");
        original.removeAttribute("data-kpoparkive-inline-hidden");
      }
      for (const editor of active.editors) editor.wrapper.remove();
      active.shell.remove();
      active.headingContent.classList.remove("kpoparkiveSectionEditing");
      activeRef.current = null;
    };

    const closeInfoboxEditor = () => {
      infoboxPanel?.remove();
      infoboxPanel = null;
      infoboxHost?.classList.remove("is-infobox-editing");
    };

    const openInfoboxEditor = async () => {
      closeEditor();
      closeInfoboxEditor();

      let data: EasyEditResponse;
      try {
        data = await loadData();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Could not open infobox editor.");
        return;
      }
      if (disposed) return;

      const model = data.infobox;
      if (!model || !model.editableCount) {
        window.alert("This page does not currently have safe infobox fields that can be visually edited.");
        return;
      }

      const panel = document.createElement("aside");
      panel.className = "kpoparkiveInfoboxEditorPanel";
      panel.setAttribute("aria-label", "Edit infobox");

      const header = document.createElement("div");
      header.className = "kpoparkiveInfoboxEditorHeader";
      const heading = document.createElement("div");
      heading.innerHTML = `<strong>Edit infobox</strong><span>Simple fields are editable. Complex template, media and multi-row fields stay protected.</span>`;
      const closeButton = createButton("×", "kpoparkiveInfoboxClose", "Close infobox editor");
      header.append(heading, closeButton);

      const miniToolbar = document.createElement("div");
      miniToolbar.className = "kpoparkiveInfoboxToolbar";
      const infoboxCommandSpecs: Array<[string, VisualEditToolbarCommand, string]> = [
        ["B", "bold", "Bold"],
        ["I", "italic", "Italic"],
        ["Link", "link", "Add wiki or web link"],
      ];
      let activeFieldNode: HTMLElement | null = null;
      for (const [label, command, tooltip] of infoboxCommandSpecs) {
        const button = commandButton(label, command, tooltip);
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", () => applyVisualCommand(command, activeFieldNode));
        miniToolbar.append(button);
      }

      const body = document.createElement("div");
      body.className = "kpoparkiveInfoboxEditorBody";
      const editorItems: InfoboxEditorItem[] = [];

      for (const field of model.fields) {
        const row = document.createElement("div");
        row.className = field.editable ? "kpoparkiveInfoboxField" : "kpoparkiveInfoboxField is-locked";
        const label = document.createElement("label");
        label.textContent = field.label;
        row.append(label);

        if (field.editable) {
          const surface = document.createElement("div");
          surface.className = "kpoparkiveInfoboxFieldSurface";
          surface.contentEditable = "true";
          surface.spellcheck = true;
          surface.setAttribute("role", "textbox");
          surface.setAttribute("aria-label", `Edit infobox field ${field.label}`);
          surface.innerHTML = wikiBlockToEditorHtml(field.valueWikitext);
          surface.addEventListener("focus", () => { activeFieldNode = surface; });
          surface.addEventListener("keydown", (event) => {
            if (event.key === "Enter") event.preventDefault();
          });
          preventEditorLinkNavigation(surface);
          row.append(surface);
          editorItems.push({ field, node: surface });
        } else {
          const locked = document.createElement("div");
          locked.className = "kpoparkiveInfoboxLockedValue";
          locked.textContent = field.plainText || field.lockedReason || "Protected field";
          locked.title = field.lockedReason || "This complex field is preserved exactly.";
          row.append(locked);
        }
        body.append(row);
      }

      if (model.lockedCount) {
        const note = document.createElement("p");
        note.className = "kpoparkiveInfoboxProtectedNote";
        note.textContent = `${model.lockedCount} complex field${model.lockedCount === 1 ? " is" : "s are"} preserved exactly and cannot be changed in this first infobox editor.`;
        body.append(note);
      }

      const footer = document.createElement("div");
      footer.className = "kpoparkiveInfoboxEditorFooter";
      const summary = document.createElement("input");
      summary.type = "text";
      summary.maxLength = 500;
      summary.placeholder = "Describe what you changed (optional)";
      summary.className = "kpoparkiveInfoboxSummary";
      const cancel = createButton("Cancel", "kpoparkiveVisualCancel");
      const submit = createButton("Submit", "kpoparkiveVisualSubmit");
      const footerActions = document.createElement("div");
      footerActions.className = "kpoparkiveInfoboxFooterActions";
      footerActions.append(cancel, submit);
      footer.append(summary, footerActions);

      panel.append(header, miniToolbar, body, footer);
      document.body.append(panel);
      infoboxPanel = panel;
      infoboxHost?.classList.add("is-infobox-editing");
      closeButton.addEventListener("click", closeInfoboxEditor);
      cancel.addEventListener("click", closeInfoboxEditor);

      submit.addEventListener("click", async () => {
        const changes = editorItems
          .map(({ field, node }) => ({
            key: field.key,
            proposedWikitext: editorElementToWikitext(node),
          }))
          .filter(({ key, proposedWikitext }) => {
            const field = editorItems.find((item) => item.field.key === key)?.field;
            return field && normalized(proposedWikitext) !== normalized(field.valueWikitext);
          });

        if (!changes.length) {
          window.alert("No changes were made.");
          return;
        }

        submit.disabled = true;
        cancel.disabled = true;
        closeButton.disabled = true;
        submit.textContent = "Submitting…";

        try {
          const response = await fetch("/api/wiki-edit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              kind: "infobox",
              title,
              infoboxChanges: changes,
              summary: summary.value,
              baseRevisionNo: data.document.publicRevisionNo,
              website: "",
            }),
          });
          const result = (await response.json()) as { ok?: boolean; error?: string; changedFields?: string[] };
          if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit this infobox edit.");
          closeInfoboxEditor();
          window.alert(`Infobox edit submitted for review${result.changedFields?.length ? ` (${result.changedFields.join(", ")})` : ""}.`);
        } catch (error) {
          submit.disabled = false;
          cancel.disabled = false;
          closeButton.disabled = false;
          submit.textContent = "Submit";
          window.alert(error instanceof Error ? error.message : "Could not submit this infobox edit.");
        }
      });

      editorItems[0]?.node.focus();
    };

    const openEditor = async (anchor: HTMLAnchorElement) => {
      const sectionIndex = sectionNumberFromEditLink(anchor);
      const headingContent = findHeadingContent(anchor);
      if (sectionIndex === null || !headingContent) return;

      closeInfoboxEditor();
      if (activeRef.current) closeEditor();

      let data: EasyEditResponse;
      try {
        data = await loadData();
      } catch (error) {
        window.alert(error instanceof Error ? error.message : "Could not open editor.");
        return;
      }
      if (disposed) return;

      const sectionKey = `section:${sectionIndex}`;
      const section = data.sections.find((item) => item.key === sectionKey);
      if (!section) {
        window.alert("This section could not be mapped to the editable source.");
        return;
      }

      const editableBlocks = section.blocks.filter((block) => block.editable && block.originalWikitext);
      if (!editableBlocks.length) {
        window.alert("This section is currently a protected table, template, media block, or other structured wiki element. Visual editors for those blocks will be added separately.");
        return;
      }

      const shell = document.createElement("div");
      shell.className = "kpoparkiveVisualEditorShell";

      const toolbar = document.createElement("div");
      toolbar.className = "kpoparkiveVisualToolbar";

      const commandGroups: Array<Array<[string, VisualEditToolbarCommand, string]>> = [
        [["↶", "undo", "Undo"], ["↷", "redo", "Redo"]],
        [["B", "bold", "Bold"], ["I", "italic", "Italic"], ["S", "strike", "Strikethrough"]],
        [["• List", "bulletList", "Bulleted list"], ["Link", "link", "Add wiki or web link"], ["Cite", "citation", "Add citation / footnote"]],
      ];

      for (const groupSpec of commandGroups) {
        const group = document.createElement("div");
        group.className = "kpoparkiveVisualToolGroup";
        for (const [label, command, tooltip] of groupSpec) {
          const button = commandButton(label, command, tooltip);
          button.addEventListener("mousedown", (event) => event.preventDefault());
          button.addEventListener("click", () => {
            const active = activeRef.current;
            if (!active) return;
            applyVisualCommand(command, active.activeNode || active.editors[0]?.node || null);
          });
          group.append(button);
        }
        toolbar.append(group);
      }

      const spacer = document.createElement("div");
      spacer.className = "kpoparkiveVisualToolbarSpacer";
      toolbar.append(spacer);

      const mode = document.createElement("span");
      mode.className = "kpoparkiveVisualMode";
      mode.textContent = "VISUAL EDITOR";
      toolbar.append(mode);

      const actions = document.createElement("div");
      actions.className = "kpoparkiveVisualActions";
      const cancelButton = createButton("Cancel", "kpoparkiveVisualCancel");
      const submitButton = createButton("Submit", "kpoparkiveVisualSubmit");
      actions.append(cancelButton, submitButton);

      const meta = document.createElement("div");
      meta.className = "kpoparkiveVisualMeta";
      const metaTitle = document.createElement("strong");
      metaTitle.textContent = `Editing ${section.heading}`;
      const summary = document.createElement("input");
      summary.type = "text";
      summary.maxLength = 500;
      summary.placeholder = "Describe what you changed (optional)";
      summary.className = "kpoparkiveVisualSummary";
      meta.append(metaTitle, summary, actions);

      shell.append(toolbar, meta);
      headingContent.parentElement?.insertBefore(shell, headingContent);
      headingContent.classList.add("kpoparkiveSectionEditing");

      const used = new Set<HTMLElement>();
      const originals: HTMLElement[] = [];
      const editors: EditorItem[] = [];

      for (const block of editableBlocks) {
        const original = findBestCandidate(headingContent, block, used);
        if (original) {
          used.add(original);
          original.dataset.kpoparkiveInlineHidden = "1";
          original.style.display = "none";
          originals.push(original);
        }

        const wrapper = document.createElement("div");
        wrapper.className = "kpoparkiveVisualBlock";
        wrapper.dataset.blockKey = block.key;

        const editorNode = document.createElement("div");
        editorNode.className = "kpoparkiveVisualSurface";
        editorNode.contentEditable = "true";
        editorNode.spellcheck = true;
        editorNode.setAttribute("role", "textbox");
        editorNode.setAttribute("aria-label", `Edit ${section.heading}`);
        editorNode.innerHTML = wikiBlockToEditorHtml(block.originalWikitext);

        editorNode.addEventListener("focus", () => {
          if (activeRef.current) activeRef.current.activeNode = editorNode;
          wrapper.classList.add("is-active");
        });
        editorNode.addEventListener("blur", () => wrapper.classList.remove("is-active"));
        editorNode.addEventListener("click", () => {
          if (activeRef.current) activeRef.current.activeNode = editorNode;
        });
        preventEditorLinkNavigation(editorNode);

        wrapper.append(editorNode);
        if (original) original.insertAdjacentElement("afterend", wrapper);
        else headingContent.append(wrapper);
        editors.push({ block, node: editorNode, wrapper, original });
      }

      const active: ActiveEdit = {
        sectionKey,
        headingContent,
        shell,
        originals,
        editors,
        activeNode: editors[0]?.node || null,
      };
      activeRef.current = active;

      cancelButton.addEventListener("click", closeEditor);
      submitButton.addEventListener("click", async () => {
        const changes = editors
          .map(({ block, node }) => ({
            block,
            proposedWikitext: editorElementToWikitext(node),
            proposedText: visualEditorPlainText(node),
          }))
          .filter(({ block, proposedWikitext }) => normalized(proposedWikitext) !== normalized(block.originalWikitext));

        if (!changes.length) {
          window.alert("No changes were made.");
          return;
        }

        submitButton.disabled = true;
        cancelButton.disabled = true;
        submitButton.textContent = "Submitting…";

        try {
          for (const change of changes) {
            const response = await fetch("/api/wiki-edit", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                kind: "block",
                title,
                blockKey: change.block.key,
                proposedText: change.proposedText,
                proposedWikitext: change.proposedWikitext,
                summary: summary.value,
                baseRevisionNo: data.document.publicRevisionNo,
                website: "",
              }),
            });
            const result = (await response.json()) as { ok?: boolean; error?: string };
            if (!response.ok || !result.ok) throw new Error(result.error || "Could not submit this edit.");
          }

          closeEditor();
          window.alert(changes.length === 1 ? "Your edit was submitted for review." : `${changes.length} edits were submitted for review.`);
        } catch (error) {
          submitButton.disabled = false;
          cancelButton.disabled = false;
          submitButton.textContent = "Submit";
          window.alert(error instanceof Error ? error.message : "Could not submit this edit.");
        }
      });

      editors[0]?.node.focus();
    };

    const infobox = document.querySelector<HTMLElement>(".thetreeWikiBaseline .wiki-table-wrap.table-right");
    if (infobox) {
      infoboxHost = infobox;
      infobox.classList.add("kpoparkiveInfoboxEditableHost");
      infoboxEditButton = createButton("Edit", "kpoparkiveInfoboxEditButton", "Edit infobox");
      infoboxEditButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void openInfoboxEditor();
      });
      infobox.append(infoboxEditButton);
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest<HTMLAnchorElement>(".wiki-edit-section > a");
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      void openEditor(anchor);
    };

    document.addEventListener("click", onClick, true);
    return () => {
      disposed = true;
      document.removeEventListener("click", onClick, true);
      closeEditor();
      closeInfoboxEditor();
      infoboxEditButton?.remove();
      infoboxHost?.classList.remove("kpoparkiveInfoboxEditableHost", "is-infobox-editing");
    };
  }, [title]);

  return null;
}
