"use client";

import { useEffect } from "react";
import { wikiBlockToEditorHtml } from "../../lib/wikiVisualEdit";

const EDITING = "kpoparkiveAstEditing";

function fragmentHtml(wikitext: string) {
  const html = wikiBlockToEditorHtml(wikitext);
  const match = html.match(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/i);
  return match ? match[1] : html.replace(/<\/?p(?:\s[^>]*)?>/gi, "");
}

function hydrate(root: ParentNode = document) {
  for (const span of Array.from(root.querySelectorAll<HTMLElement>(".kpoparkiveVe3SimpleInline:not([data-ve3-simple-hydrated])"))) {
    const source = span.textContent || "";
    span.dataset.ve3SimpleHydrated = "1";
    span.innerHTML = fragmentHtml(source);
  }
}

export default function VisualEditorV3SimpleInlineHydrator() {
  useEffect(() => {
    let observer: MutationObserver | null = null;
    const stop = () => { observer?.disconnect(); observer = null; };
    const start = () => {
      if (observer) return;
      const article = document.querySelector<HTMLElement>(".thetreeWikiBaseline");
      if (!article) return;
      hydrate(article);
      observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.addedNodes)) {
            if (node instanceof HTMLElement) {
              if (node.matches(".kpoparkiveVe3SimpleInline")) hydrate(node.parentNode || article);
              else hydrate(node);
            }
          }
        }
      });
      observer.observe(article, { subtree: true, childList: true });
    };
    const sync = () => document.body.classList.contains(EDITING) ? start() : stop();
    const bodyObserver = new MutationObserver(sync);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    sync();
    return () => { bodyObserver.disconnect(); stop(); };
  }, []);
  return null;
}
