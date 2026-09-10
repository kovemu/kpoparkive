"use client";

import { useEffect } from "react";

const EDITING = "kpoparkiveAstEditing";
const STYLE_ID = "kpoparkive-ve3-interaction-guard-style";

type Snapshot = {
  element: HTMLElement;
  hidden: boolean;
  ariaHidden: string | null;
  ariaExpanded: string | null;
  style: string | null;
};

function headingContents() {
  return Array.from(document.querySelectorAll<HTMLElement>(".thetreeWikiBaseline .wiki-heading-content"));
}

function setAttrIfDifferent(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function setImportantIfDifferent(element: HTMLElement, property: string, value: string) {
  if (element.style.getPropertyValue(property) !== value || element.style.getPropertyPriority(property) !== "important") {
    element.style.setProperty(property, value, "important");
  }
}

function forceExpanded(element: HTMLElement) {
  if (element.hidden) element.hidden = false;
  setAttrIfDifferent(element, "aria-hidden", "false");
  setImportantIfDifferent(element, "display", "block");
  setImportantIfDifferent(element, "height", "auto");
  setImportantIfDifferent(element, "max-height", "none");
  setImportantIfDifferent(element, "visibility", "visible");
  setImportantIfDifferent(element, "overflow", "visible");

  const heading = element.previousElementSibling?.classList.contains("wiki-heading")
    ? element.previousElementSibling as HTMLElement
    : null;
  if (heading) setAttrIfDifferent(heading, "aria-expanded", "true");
  for (const toggle of Array.from((heading || element).querySelectorAll<HTMLElement>('[aria-expanded="false"]'))) {
    setAttrIfDifferent(toggle, "aria-expanded", "true");
  }
}

export default function VisualEditorV3InteractionGuard() {
  useEffect(() => {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
body.${EDITING} .thetreeWikiBaseline .wiki-heading-content{display:block!important;height:auto!important;max-height:none!important;visibility:visible!important;overflow:visible!important}
body.${EDITING} .thetreeWikiBaseline a{cursor:text!important}
body.${EDITING} .thetreeWikiBaseline .wiki-heading{cursor:default!important}
`;
    document.head.appendChild(style);

    let snapshots: Snapshot[] = [];
    let runtimeObserver: MutationObserver | null = null;
    let queued = false;

    const apply = () => {
      queued = false;
      if (!document.body.classList.contains(EDITING)) return;
      for (const element of headingContents()) forceExpanded(element);
    };

    const queueApply = () => {
      if (queued) return;
      queued = true;
      queueMicrotask(apply);
    };

    const start = () => {
      if (runtimeObserver) return;
      snapshots = headingContents().map((element) => ({
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute("aria-hidden"),
        ariaExpanded: element.previousElementSibling?.getAttribute("aria-expanded") || null,
        style: element.getAttribute("style"),
      }));
      apply();
      const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
      if (!article) return;
      runtimeObserver = new MutationObserver(queueApply);
      runtimeObserver.observe(article, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["hidden", "style", "class", "aria-hidden", "aria-expanded"],
      });
    };

    const stop = () => {
      queued = false;
      runtimeObserver?.disconnect();
      runtimeObserver = null;
      for (const snapshot of snapshots) {
        if (!snapshot.element.isConnected) continue;
        snapshot.element.hidden = snapshot.hidden;
        if (snapshot.ariaHidden === null) snapshot.element.removeAttribute("aria-hidden");
        else snapshot.element.setAttribute("aria-hidden", snapshot.ariaHidden);
        if (snapshot.style === null) snapshot.element.removeAttribute("style");
        else snapshot.element.setAttribute("style", snapshot.style);
        const heading = snapshot.element.previousElementSibling?.classList.contains("wiki-heading")
          ? snapshot.element.previousElementSibling as HTMLElement
          : null;
        if (heading) {
          if (snapshot.ariaExpanded === null) heading.removeAttribute("aria-expanded");
          else heading.setAttribute("aria-expanded", snapshot.ariaExpanded);
        }
      }
      snapshots = [];
    };

    const sync = () => document.body.classList.contains(EDITING) ? start() : stop();
    const bodyObserver = new MutationObserver(sync);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();

    const blockNavigation = (event: Event) => {
      if (!document.body.classList.contains(EDITING)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".thetreeWikiBaseline")) return;
      if (target.closest("a")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
      const heading = target.closest(".wiki-heading");
      if (heading && !target.closest('[contenteditable="true"],input,textarea,select')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        queueApply();
      }
    };

    const blockAnchorKey = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !document.body.classList.contains(EDITING)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".thetreeWikiBaseline a")) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    document.addEventListener("click", blockNavigation, true);
    document.addEventListener("keydown", blockAnchorKey, true);
    return () => {
      bodyObserver.disconnect();
      stop();
      document.removeEventListener("click", blockNavigation, true);
      document.removeEventListener("keydown", blockAnchorKey, true);
      style.remove();
    };
  }, []);

  return null;
}
