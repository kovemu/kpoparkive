"use client";

import { useEffect } from "react";

type ElementSnapshot = {
  element: HTMLElement;
  display: string;
  displayPriority: string;
  height: string;
  heightPriority: string;
  maxHeight: string;
  maxHeightPriority: string;
  visibility: string;
  visibilityPriority: string;
  hidden: string | null;
  ariaHidden: string | null;
  ariaExpanded: string | null;
};

const EDITING_CLASS = "kpoparkivePageEditing";
const ARTICLE_SELECTOR = ".thetreeWikiBaseline";
const HEADING_SELECTOR = ".wiki-heading";
const HEADING_CONTENT_SELECTOR = ".wiki-heading-content";
const EDITABLE_SELECTOR = '[contenteditable="true"], [contenteditable="plaintext-only"]';
const UNLINK_BUTTON_ID = "kpoparkive-visual-editor-unlink";
const STYLE_ID = "kpoparkive-visual-editor-interaction-guard-style";

function closestElement(node: Node | null) {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function editableHostForNode(node: Node | null) {
  return closestElement(node)?.closest<HTMLElement>(EDITABLE_SELECTOR) || null;
}

function dispatchEditorInput(host: HTMLElement | null) {
  if (!host) return;
  host.dispatchEvent(new Event("input", { bubbles: true }));
}

function unwrapAnchor(anchor: HTMLAnchorElement) {
  const parent = anchor.parentNode;
  if (!parent) return;
  while (anchor.firstChild) parent.insertBefore(anchor.firstChild, anchor);
  anchor.remove();
}

function unlinkCurrentSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  const article = document.querySelector<HTMLElement>(ARTICLE_SELECTOR);
  if (!article) return false;

  const anchorElement = closestElement(selection.anchorNode);
  const focusElement = closestElement(selection.focusNode);
  const activeHost = editableHostForNode(selection.anchorNode) || editableHostForNode(selection.focusNode);
  if (!activeHost || !article.contains(activeHost)) return false;

  const directAnchor = anchorElement?.closest<HTMLAnchorElement>("a")
    || focusElement?.closest<HTMLAnchorElement>("a")
    || null;

  // With a caret inside one link, unlink the whole link. This is much more
  // predictable than execCommand("unlink") with a collapsed selection.
  if (selection.isCollapsed && directAnchor && activeHost.contains(directAnchor)) {
    unwrapAnchor(directAnchor);
    dispatchEditorInput(activeHost);
    activeHost.focus({ preventScroll: true });
    return true;
  }

  activeHost.focus({ preventScroll: true });
  const changed = document.execCommand("unlink");
  if (changed) {
    dispatchEditorInput(activeHost);
    return true;
  }

  // Browser fallback for an entirely selected link inside the active editor.
  if (directAnchor && activeHost.contains(directAnchor)) {
    unwrapAnchor(directAnchor);
    dispatchEditorInput(activeHost);
    return true;
  }

  return false;
}

function snapshotElement(element: HTMLElement): ElementSnapshot {
  return {
    element,
    display: element.style.getPropertyValue("display"),
    displayPriority: element.style.getPropertyPriority("display"),
    height: element.style.getPropertyValue("height"),
    heightPriority: element.style.getPropertyPriority("height"),
    maxHeight: element.style.getPropertyValue("max-height"),
    maxHeightPriority: element.style.getPropertyPriority("max-height"),
    visibility: element.style.getPropertyValue("visibility"),
    visibilityPriority: element.style.getPropertyPriority("visibility"),
    hidden: element.getAttribute("hidden"),
    ariaHidden: element.getAttribute("aria-hidden"),
    ariaExpanded: element.getAttribute("aria-expanded"),
  };
}

function restoreStyle(element: HTMLElement, name: string, value: string, priority: string) {
  if (value) element.style.setProperty(name, value, priority);
  else element.style.removeProperty(name);
}

function restoreSnapshot(snapshot: ElementSnapshot) {
  const { element } = snapshot;
  if (!element.isConnected) return;
  restoreStyle(element, "display", snapshot.display, snapshot.displayPriority);
  restoreStyle(element, "height", snapshot.height, snapshot.heightPriority);
  restoreStyle(element, "max-height", snapshot.maxHeight, snapshot.maxHeightPriority);
  restoreStyle(element, "visibility", snapshot.visibility, snapshot.visibilityPriority);

  if (snapshot.hidden === null) element.removeAttribute("hidden");
  else element.setAttribute("hidden", snapshot.hidden);
  if (snapshot.ariaHidden === null) element.removeAttribute("aria-hidden");
  else element.setAttribute("aria-hidden", snapshot.ariaHidden);
  if (snapshot.ariaExpanded === null) element.removeAttribute("aria-expanded");
  else element.setAttribute("aria-expanded", snapshot.ariaExpanded);
}

export default function VisualEditorInteractionGuard() {
  useEffect(() => {
    const snapshots = new Map<HTMLElement, ElementSnapshot>();
    let guardActive = false;
    let forcingOpen = false;

    const remember = (element: HTMLElement) => {
      if (!snapshots.has(element)) snapshots.set(element, snapshotElement(element));
    };

    const forceSectionsOpen = () => {
      if (!document.body.classList.contains(EDITING_CLASS) || forcingOpen) return;
      forcingOpen = true;
      try {
        const article = document.querySelector<HTMLElement>(ARTICLE_SELECTOR);
        if (!article) return;

        for (const content of Array.from(article.querySelectorAll<HTMLElement>(HEADING_CONTENT_SELECTOR))) {
          remember(content);
          if (content.hasAttribute("hidden")) content.removeAttribute("hidden");
          if (content.getAttribute("aria-hidden") !== "false") content.setAttribute("aria-hidden", "false");
          if (content.style.getPropertyValue("display") !== "block" || content.style.getPropertyPriority("display") !== "important") {
            content.style.setProperty("display", "block", "important");
          }
          if (content.style.getPropertyValue("height") !== "auto" || content.style.getPropertyPriority("height") !== "important") {
            content.style.setProperty("height", "auto", "important");
          }
          if (content.style.getPropertyValue("max-height") !== "none" || content.style.getPropertyPriority("max-height") !== "important") {
            content.style.setProperty("max-height", "none", "important");
          }
          if (content.style.getPropertyValue("visibility") !== "visible" || content.style.getPropertyPriority("visibility") !== "important") {
            content.style.setProperty("visibility", "visible", "important");
          }
        }

        for (const heading of Array.from(article.querySelectorAll<HTMLElement>(HEADING_SELECTOR))) {
          remember(heading);
          if (heading.getAttribute("aria-expanded") !== "true") heading.setAttribute("aria-expanded", "true");
          for (const toggle of Array.from(heading.querySelectorAll<HTMLElement>('[aria-expanded="false"]'))) {
            remember(toggle);
            toggle.setAttribute("aria-expanded", "true");
          }
        }
      } finally {
        forcingOpen = false;
      }
    };

    const ensureStyle = () => {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
body.${EDITING_CLASS} ${ARTICLE_SELECTOR} ${HEADING_CONTENT_SELECTOR} {
  display: block !important;
  height: auto !important;
  max-height: none !important;
  visibility: visible !important;
}
body.${EDITING_CLASS} ${ARTICLE_SELECTOR} a {
  cursor: text !important;
}
body.${EDITING_CLASS} ${ARTICLE_SELECTOR} ${HEADING_SELECTOR} {
  cursor: default !important;
}
body.${EDITING_CLASS} ${ARTICLE_SELECTOR} ${HEADING_SELECTOR} ${EDITABLE_SELECTOR},
body.${EDITING_CLASS} ${ARTICLE_SELECTOR} ${EDITABLE_SELECTOR} a {
  cursor: text !important;
}
#${UNLINK_BUTTON_ID} {
  min-width: 58px;
  font-weight: 750;
}
`;
      document.head.appendChild(style);
    };

    const removeUnlinkButton = () => {
      document.getElementById(UNLINK_BUTTON_ID)?.remove();
    };

    const ensureUnlinkButton = () => {
      if (!document.body.classList.contains(EDITING_CLASS) || document.getElementById(UNLINK_BUTTON_ID)) return;
      const toolbar = document.querySelector<HTMLElement>(".kpoparkiveEditorV2 .kpoparkivePageEditorTools");
      if (!toolbar) return;
      const linkButton = toolbar.querySelector<HTMLButtonElement>('button[title="Link"]');
      if (!linkButton) return;

      const button = document.createElement("button");
      button.id = UNLINK_BUTTON_ID;
      button.type = "button";
      button.textContent = "Unlink";
      button.title = "Remove link from selected text";
      button.setAttribute("aria-label", "Remove link");
      button.addEventListener("mousedown", (event) => {
        // Keep the contenteditable selection alive while operating the toolbar.
        event.preventDefault();
        event.stopPropagation();
        unlinkCurrentSelection();
      });
      linkButton.insertAdjacentElement("afterend", button);
    };

    const enable = () => {
      if (guardActive) {
        forceSectionsOpen();
        ensureUnlinkButton();
        return;
      }
      guardActive = true;
      snapshots.clear();
      forceSectionsOpen();
      ensureUnlinkButton();
    };

    const disable = () => {
      if (!guardActive) return;
      guardActive = false;
      removeUnlinkButton();
      for (const snapshot of Array.from(snapshots.values()).reverse()) restoreSnapshot(snapshot);
      snapshots.clear();
    };

    const sync = () => {
      if (document.body.classList.contains(EDITING_CLASS)) enable();
      else disable();
    };

    const onClickCapture = (event: MouseEvent) => {
      if (!document.body.classList.contains(EDITING_CLASS)) return;
      const target = event.target instanceof Element ? event.target : null;
      const article = document.querySelector<HTMLElement>(ARTICLE_SELECTOR);
      if (!target || !article?.contains(target)) return;

      // Links remain visually editable, but they never navigate while editing.
      if (target.closest("a")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        forceSectionsOpen();
        return;
      }

      // The Tree normally folds a section by clicking its heading. In Visual
      // Editor the heading itself is structure, so folding is disabled.
      if (target.closest(HEADING_SELECTOR) && !target.closest(EDITABLE_SELECTOR)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        forceSectionsOpen();
      }
    };

    const onKeyDownCapture = (event: KeyboardEvent) => {
      if (!document.body.classList.contains(EDITING_CLASS) || event.key !== "Enter") return;
      const target = event.target instanceof Element ? event.target : null;
      const article = document.querySelector<HTMLElement>(ARTICLE_SELECTOR);
      if (target?.closest("a") && article?.contains(target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    ensureStyle();
    document.addEventListener("click", onClickCapture, true);
    document.addEventListener("keydown", onKeyDownCapture, true);

    const observer = new MutationObserver(() => {
      sync();
      if (guardActive) {
        forceSectionsOpen();
        ensureUnlinkButton();
      }
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "style", "hidden", "aria-hidden", "aria-expanded"],
    });

    sync();

    return () => {
      observer.disconnect();
      document.removeEventListener("click", onClickCapture, true);
      document.removeEventListener("keydown", onKeyDownCapture, true);
      disable();
      document.getElementById(STYLE_ID)?.remove();
    };
  }, []);

  return null;
}
