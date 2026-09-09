"use client";

import { useEffect } from "react";

export default function TheTreeRuntimeBridge() {
  useEffect(() => {
    const roots = Array.from(
      document.querySelectorAll<HTMLElement>(".thetreeWikiBaseline, .namumarkPocDocument.wiki-content"),
    );
    if (!roots.length) return;

    const cleanups: Array<() => void> = [];

    for (const root of roots) {
      for (const heading of Array.from(root.querySelectorAll<HTMLElement>(".wiki-heading"))) {
        const handler = (event: Event) => {
          if ((event.target as HTMLElement | null)?.closest("a")) return;
          const content = heading.nextElementSibling as HTMLElement | null;
          if (!content) return;
          const folded = heading.classList.toggle("wiki-heading-folded");
          content.classList.toggle("wiki-heading-content-folded", folded);
        };
        heading.addEventListener("click", handler);
        cleanups.push(() => heading.removeEventListener("click", handler));
      }

      for (const trigger of Array.from(root.querySelectorAll<HTMLElement>("[data-onclick]"))) {
        const raw = trigger.dataset.onclick || "";
        const actions = raw
          .split(";")
          .map((part) => part.split(",").map((value) => value.trim()))
          .filter((parts) => parts.length >= 3);

        const handler = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();

          for (const [operation, targetClass, className] of actions) {
            if (!targetClass || !className) continue;
            const targets = Array.from(root.getElementsByClassName(targetClass));
            for (const target of targets) {
              if (operation === "toggle-class") target.classList.toggle(className);
              else if (operation === "add-class") target.classList.add(className);
              else if (operation === "remove-class") target.classList.remove(className);
            }
          }
        };

        trigger.addEventListener("click", handler);
        cleanups.push(() => trigger.removeEventListener("click", handler));
      }

      for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img[data-src]"))) {
        const src = image.dataset.src;
        if (!src) continue;
        image.src = src;
        image.classList.remove("wiki-image-loading");
        image.loading = "lazy";
      }
    }

    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, []);

  return null;
}
