"use client";

import { useEffect } from "react";
import { applyVisualCommand, applyVisualTextColor } from "../../lib/wikiVisualEdit";

const EDITING_CLASS = "kpoparkiveAstEditing";
const GROUP_ID = "kpoparkive-ve3-formatting-group";

function activeSurface() {
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const selected = element?.closest<HTMLElement>(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface,.kpoparkiveVe3AtomicSurface");
  if (selected?.isContentEditable) return selected;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active?.matches(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface,.kpoparkiveVe3AtomicSurface") && active.isContentEditable) return active;
  return null;
}

function command(value: "orderedList") {
  const surface = activeSurface();
  if (!surface) {
    window.alert("Click editable paragraph or list text first.");
    return;
  }
  if (surface.matches(".kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface")) {
    window.alert("Numbered lists are only available in paragraph/list content.");
    return;
  }
  applyVisualCommand(value, surface);
  surface.dispatchEvent(new Event("input", { bubbles: true }));
}

function selectionInside(surface: HTMLElement | null) {
  if (!surface) return null;
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const element = common instanceof Element ? common : common.parentElement;
  return element && surface.contains(element) ? range.cloneRange() : null;
}

function restoreRange(surface: HTMLElement, range: Range | null) {
  surface.focus();
  if (!range) return false;
  if (!range.startContainer.isConnected || !range.endContainer.isConnected) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export default function VisualEditorV3FormattingBridge() {
  useEffect(() => {
    let savedRange: Range | null = null;
    let savedSurface: HTMLElement | null = null;

    const remember = () => {
      const surface = activeSurface();
      const range = selectionInside(surface);
      if (!surface || !range) return;
      savedSurface = surface;
      savedRange = range;
    };

    const remove = () => document.getElementById(GROUP_ID)?.remove();
    const ensure = () => {
      const editing = document.body.classList.contains(EDITING_CLASS);
      if (!editing) { remove(); savedRange = null; savedSurface = null; return; }
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar || document.getElementById(GROUP_ID)) return;

      const group = document.createElement("span");
      group.id = GROUP_ID;
      group.style.display = "contents";

      const ordered = document.createElement("button");
      ordered.type = "button"; ordered.textContent = "1. List"; ordered.title = "Numbered list";
      ordered.addEventListener("mousedown", (event) => event.preventDefault());
      ordered.addEventListener("click", () => command("orderedList"));

      const colorLabel = document.createElement("label");
      colorLabel.title = "Text color";
      colorLabel.style.display = "inline-flex";
      colorLabel.style.alignItems = "center";
      colorLabel.style.gap = "4px";
      colorLabel.style.height = "36px";
      colorLabel.style.padding = "0 7px";
      colorLabel.style.border = "1px solid #d9d3e7";
      colorLabel.style.borderRadius = "7px";
      colorLabel.style.background = "#fff";
      colorLabel.style.fontSize = "11px";
      colorLabel.style.fontWeight = "700";
      colorLabel.textContent = "Color";
      const color = document.createElement("input");
      color.type = "color"; color.value = "#6b3ce8"; color.setAttribute("aria-label", "Text color");
      color.style.width = "23px"; color.style.height = "23px"; color.style.padding = "0"; color.style.border = "0"; color.style.background = "transparent";
      color.addEventListener("pointerdown", remember, true);
      color.addEventListener("mousedown", () => remember(), true);
      color.addEventListener("change", () => {
        const surface = savedSurface && savedSurface.isConnected ? savedSurface : activeSurface();
        if (!surface) { window.alert("Select text in an editable block first."); return; }
        if (surface.matches(".kpoparkiveAstTableSurface")) {
          window.alert("Use Cell style for table colors.");
          return;
        }
        if (!restoreRange(surface, savedRange)) {
          window.alert("Text selection was lost. Select the text again, then choose a color.");
          return;
        }
        applyVisualTextColor(surface, color.value);
        surface.dispatchEvent(new Event("input", { bubbles: true }));
      });
      colorLabel.appendChild(color);

      group.append(ordered, colorLabel);
      const list = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "List");
      (list || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", group);
    };

    document.addEventListener("selectionchange", remember);
    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => {
      document.removeEventListener("selectionchange", remember);
      observer.disconnect();
      remove();
    };
  }, []);

  return null;
}
