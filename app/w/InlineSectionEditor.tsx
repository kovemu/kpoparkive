"use client";

import { useEffect, useRef } from "react";

type EasyBlock = {
  key: string;
  blockIndex: number;
  plainText: string;
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

type EasyEditResponse = {
  ok: boolean;
  document: {
    title: string;
    publicRevisionNo: number;
    sourceMode: "captured" | "published";
  };
  sections: EasySection[];
};

type ActiveEdit = {
  sectionKey: string;
  headingContent: HTMLElement;
  toolbar: HTMLElement;
  originals: HTMLElement[];
  editors: Array<{ block: EasyBlock; node: HTMLElement; original: HTMLElement | null }>;
};

function normalized(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function comparable(value: string) {
  return normalized(value)
    .replace(/^[•*\-]\s*/gm, "")
    .replace(/\(Note:[\s\S]*?\)/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
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
  return 0;
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
  let best: HTMLElement | null = null;
  let bestScore = 0;
  for (const candidate of candidateElements(root)) {
    if (used.has(candidate)) continue;
    if (Array.from(used).some((node) => node.contains(candidate) || candidate.contains(node))) continue;
    const score = textScore(block.plainText, candidate.innerText || candidate.textContent || "");
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore >= 0.62 ? best : null;
}

function serializeEditable(node: HTMLElement, originalPlainText: string) {
  const items = Array.from(node.querySelectorAll<HTMLElement>("li"));
  if (items.length) {
    const lines = items
      .map((item) => normalized(item.innerText || item.textContent || ""))
      .filter(Boolean)
      .map((item) => `• ${item}`);
    if (lines.length) return lines.join("\n");
  }

  const text = normalized(node.innerText || node.textContent || "");
  if (/^•\s/m.test(originalPlainText) && text && !/^•\s/m.test(text)) {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => `• ${line.replace(/^[-*•]\s*/, "")}`)
      .join("\n");
  }
  return text;
}

function createButton(label: string, className: string) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  return button;
}

export default function InlineSectionEditor({ title }: { title: string }) {
  const cacheRef = useRef<Promise<EasyEditResponse> | null>(null);
  const activeRef = useRef<ActiveEdit | null>(null);

  useEffect(() => {
    let disposed = false;

    const loadData = () => {
      if (!cacheRef.current) {
        cacheRef.current = fetch(`/api/wiki-edit?title=${encodeURIComponent(title)}`, {
          cache: "no-store",
        }).then(async (response) => {
          const data = (await response.json()) as EasyEditResponse & { error?: string };
          if (!response.ok || !data.ok) throw new Error(data.error || "Could not load this section for editing.");
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
      for (const editor of active.editors) editor.node.remove();
      active.toolbar.remove();
      active.headingContent.classList.remove("kpoparkiveSectionEditing");
      activeRef.current = null;
    };

    const openEditor = async (anchor: HTMLAnchorElement) => {
      const sectionIndex = sectionNumberFromEditLink(anchor);
      const headingContent = findHeadingContent(anchor);
      if (sectionIndex === null || !headingContent) return;

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

      const editableBlocks = section.blocks.filter((block) => block.editable);
      if (!editableBlocks.length) {
        window.alert("This section currently contains only protected tables, templates, media, or other structured blocks. Structured visual editing will be added separately.");
        return;
      }

      const toolbar = document.createElement("div");
      toolbar.className = "kpoparkiveInlineEditToolbar";
      toolbar.innerHTML = `
        <div class="kpoparkiveInlineEditTitle">
          <strong>Editing: ${section.heading.replace(/[<&]/g, "")}</strong>
          <span>Edit the page directly. Tables, templates, media, links and references are preserved unless they are inside an editable text block.</span>
        </div>
      `;

      const actions = document.createElement("div");
      actions.className = "kpoparkiveInlineEditActions";
      const cancelButton = createButton("Cancel", "kpoparkiveInlineCancel");
      const submitButton = createButton("Submit", "kpoparkiveInlineSubmit");
      actions.append(cancelButton, submitButton);
      toolbar.append(actions);

      const summary = document.createElement("input");
      summary.type = "text";
      summary.maxLength = 500;
      summary.placeholder = "Describe what you changed (optional)";
      summary.className = "kpoparkiveInlineSummary";
      toolbar.append(summary);

      headingContent.parentElement?.insertBefore(toolbar, headingContent);
      headingContent.classList.add("kpoparkiveSectionEditing");

      const used = new Set<HTMLElement>();
      const originals: HTMLElement[] = [];
      const editors: ActiveEdit["editors"] = [];

      for (const block of editableBlocks) {
        const original = findBestCandidate(headingContent, block, used);
        let editorNode: HTMLElement;

        if (original) {
          used.add(original);
          original.dataset.kpoparkiveInlineHidden = "1";
          original.style.display = "none";
          originals.push(original);
          editorNode = original.cloneNode(true) as HTMLElement;
          editorNode.style.removeProperty("display");
          editorNode.removeAttribute("data-kpoparkive-inline-hidden");
          editorNode.removeAttribute("id");
          original.insertAdjacentElement("afterend", editorNode);
        } else {
          editorNode = document.createElement("div");
          editorNode.textContent = block.plainText;
          headingContent.prepend(editorNode);
        }

        editorNode.classList.add("kpoparkiveInlineEditableBlock");
        editorNode.contentEditable = "true";
        editorNode.spellcheck = true;
        editorNode.dataset.blockKey = block.key;
        editorNode.setAttribute("role", "textbox");
        editorNode.setAttribute("aria-label", `Edit ${section.heading}`);
        editorNode.querySelectorAll("a").forEach((link) => {
          link.addEventListener("click", (event) => event.preventDefault());
        });
        editors.push({ block, node: editorNode, original });
      }

      const active: ActiveEdit = {
        sectionKey,
        headingContent,
        toolbar,
        originals,
        editors,
      };
      activeRef.current = active;

      cancelButton.addEventListener("click", closeEditor);
      submitButton.addEventListener("click", async () => {
        const changes = editors
          .map(({ block, node }) => ({
            block,
            proposedText: serializeEditable(node, block.plainText),
          }))
          .filter(({ block, proposedText }) => normalized(proposedText) !== normalized(block.plainText));

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
                title,
                blockKey: change.block.key,
                proposedText: change.proposedText,
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
    };
  }, [title]);

  return null;
}
