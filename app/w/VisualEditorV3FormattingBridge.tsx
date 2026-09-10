"use client";

import { useEffect } from "react";
import { applyVisualCommand, applyVisualTextColor } from "../../lib/wikiVisualEdit";

const EDITING_CLASS = "kpoparkiveAstEditing";
const GROUP_ID = "kpoparkive-ve3-formatting-group";

function activeSurface() {
  const selection = window.getSelection();
  const node = selection?.anchorNode || selection?.focusNode || null;
  const element = node instanceof Element ? node : node?.parentElement;
  const selected = element?.closest<HTMLElement>(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface");
  if (selected?.isContentEditable) return selected;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (active?.matches(".kpoparkiveAstSurface,.kpoparkiveAstHeadingSurface,.kpoparkiveAstTableSurface") && active.isContentEditable) return active;
  return null;
}

function command(value: "orderedList" | "alignLeft" | "alignCenter" | "alignRight" | "alignJustify") {
  const surface = activeSurface();
  if (!surface) {
    window.alert("Click editable text or a table field first.");
    return;
  }
  applyVisualCommand(value, surface);
}

export default function VisualEditorV3FormattingBridge() {
  useEffect(() => {
    let editing = false;

    const remove = () => document.getElementById(GROUP_ID)?.remove();
    const ensure = () => {
      editing = document.body.classList.contains(EDITING_CLASS);
      if (!editing) { remove(); return; }
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveAstToolbar");
      if (!toolbar || document.getElementById(GROUP_ID)) return;

      const group = document.createElement("span");
      group.id = GROUP_ID;
      group.style.display = "contents";

      const ordered = document.createElement("button");
      ordered.type = "button"; ordered.textContent = "1. List"; ordered.title = "Numbered list";
      ordered.addEventListener("mousedown", (event) => event.preventDefault());
      ordered.addEventListener("click", () => command("orderedList"));

      const left = document.createElement("button");
      left.type = "button"; left.textContent = "←"; left.title = "Align left";
      left.addEventListener("mousedown", (event) => event.preventDefault()); left.addEventListener("click", () => command("alignLeft"));

      const center = document.createElement("button");
      center.type = "button"; center.textContent = "↔"; center.title = "Align center";
      center.addEventListener("mousedown", (event) => event.preventDefault()); center.addEventListener("click", () => command("alignCenter"));

      const right = document.createElement("button");
      right.type = "button"; right.textContent = "→"; right.title = "Align right";
      right.addEventListener("mousedown", (event) => event.preventDefault()); right.addEventListener("click", () => command("alignRight"));

      const justify = document.createElement("button");
      justify.type = "button"; justify.textContent = "≡"; justify.title = "Justify";
      justify.addEventListener("mousedown", (event) => event.preventDefault()); justify.addEventListener("click", () => command("alignJustify"));

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
      color.addEventListener("mousedown", (event) => event.stopPropagation());
      color.addEventListener("change", () => {
        const surface = activeSurface();
        if (!surface) { window.alert("Select text in an editable block first."); return; }
        applyVisualTextColor(surface, color.value);
      });
      colorLabel.appendChild(color);

      group.append(ordered, left, center, right, justify, colorLabel);
      const list = Array.from(toolbar.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.trim() === "List");
      (list || toolbar.querySelector("strong"))?.insertAdjacentElement("afterend", group);
    };

    ensure();
    const observer = new MutationObserver(ensure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    return () => { observer.disconnect(); remove(); };
  }, []);

  return null;
}
