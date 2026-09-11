"use client";

import { useEffect } from "react";

function isVideoUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);
    return /\.(?:mp4|webm|mov)(?:$|[?#])/i.test(url.pathname + url.search);
  } catch {
    return /\.(?:mp4|webm|mov)(?:$|[?#])/i.test(value);
  }
}

function hydrateVideoBackedImage(image: HTMLImageElement) {
  const explicitVideo = image.dataset.videoSrc || "";
  const src = explicitVideo || image.dataset.src || image.getAttribute("src") || "";
  if (!src || !isVideoUrl(src)) return false;

  const wrapper = image.closest<HTMLElement>(".wiki-image-wrapper");
  const sizingPlaceholder = wrapper
    ? Array.from(wrapper.children).find((child) => child instanceof HTMLImageElement && child !== image) as HTMLImageElement | undefined
    : undefined;

  const video = document.createElement("video");
  video.className = image.className.replace(/\bwiki-image-loading\b/g, "").replace(/\s+/g, " ").trim();
  video.style.cssText = image.style.cssText;
  if (image.hasAttribute("width")) video.setAttribute("width", image.getAttribute("width") || "");
  if (image.hasAttribute("height")) video.setAttribute("height", image.getAttribute("height") || "");
  const alt = image.getAttribute("alt") || "";
  if (alt) video.setAttribute("aria-label", alt);
  video.src = src;
  video.autoplay = true;
  video.loop = true;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.setAttribute("disablepictureinpicture", "");

  // The Tree normally emits an in-flow sizing image plus an absolutely
  // positioned real image. For a captured GIF that is stored as MP4 we used
  // to keep a generic 1x1 SVG sizing image, which forced a 100%-wide video
  // into a square box. The Namu source only asks for width=100%; its height
  // is supposed to come from the media's intrinsic aspect ratio. Once video
  // metadata is available, transfer that intrinsic ratio to the wrapper and
  // remove the synthetic sizing placeholder from layout.
  const syncIntrinsicRatio = () => {
    if (!wrapper || !video.videoWidth || !video.videoHeight) return;
    wrapper.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    if (sizingPlaceholder) sizingPlaceholder.style.display = "none";
  };
  video.addEventListener("loadedmetadata", syncIntrinsicRatio, { once: true });

  image.replaceWith(video);
  if (video.readyState >= 1) syncIntrinsicRatio();
  video.play().catch(() => {});
  return true;
}

function prepareCapturedToggleTarget(target: HTMLElement) {
  if (target.dataset.kpoparkiveToggleDisplayPrepared === "1") return;
  target.dataset.kpoparkiveToggleDisplayPrepared = "1";

  if (target.style.display === "none") {
    target.dataset.kpoparkiveToggleHiddenPanel = "1";
    target.dataset.kpoparkiveToggleVisibleDisplay = "block";
  }
}

function capturedCommonAncestor(
  trigger: HTMLElement,
  target: HTMLElement,
  root: HTMLElement,
) {
  let current: HTMLElement | null = target.parentElement;
  while (current && current !== root) {
    if (current.contains(trigger)) return current;
    current = current.parentElement;
  }
  return null;
}

function releaseCapturedToggleFlow(
  trigger: HTMLElement,
  target: HTMLElement,
  root: HTMLElement,
) {
  const common = capturedCommonAncestor(trigger, target, root);
  if (!common) return;

  // Computed-style DOM captures freeze the closed-state height on the widget
  // container. When a hidden tab/panel is later shown, that fixed pixel height
  // makes the content overflow over the following wiki sections instead of
  // participating in normal document flow. Let the dynamic container and the
  // small wrapper chain above it size from content again.
  let current: HTMLElement | null = common;
  let depth = 0;
  while (current && current !== root && depth < 4) {
    if (current.style.height && current.style.height !== "auto") {
      current.style.height = "auto";
    }
    if (current.style.maxHeight && current.style.maxHeight !== "none") {
      current.style.maxHeight = "none";
    }
    if (
      current.style.overflowY === "hidden" ||
      current.style.overflowY === "clip"
    ) {
      current.style.overflowY = "visible";
    }
    current.dataset.kpoparkiveDynamicToggleFlow = "1";
    current = current.parentElement;
    depth += 1;
  }
}

function applyCapturedClassOperation(
  target: HTMLElement,
  operation: string,
  className: string,
) {
  prepareCapturedToggleTarget(target);

  let active = target.classList.contains(className);
  if (operation === "toggle-class") {
    active = !active;
    target.classList.toggle(className, active);
  } else if (operation === "add-class") {
    active = true;
    target.classList.add(className);
  } else if (operation === "remove-class") {
    active = false;
    target.classList.remove(className);
  } else {
    return;
  }

  // Captured DOM fallbacks preserve computed styles inline. That means a
  // class toggle alone cannot override an inline display:none that originally
  // depended on NamuWiki's stylesheet. Re-create that state transition here.
  if (target.dataset.kpoparkiveToggleHiddenPanel === "1") {
    target.style.display = active
      ? (target.dataset.kpoparkiveToggleVisibleDisplay || "block")
      : "none";
    if (active) {
      target.style.height = "auto";
      target.style.maxHeight = "none";
      target.style.visibility = "visible";
    }
  }
}

function hydrateTheTreeRuntime() {
  const roots = Array.from(
    document.querySelectorAll<HTMLElement>(".thetreeWikiBaseline, .namumarkPocDocument.wiki-content"),
  );
  if (!roots.length) return () => {};

  const cleanups: Array<() => void> = [];

    // The pinned frontend renders its external-link marker with an Ionicons
    // private-use glyph. Kpoparkive does not load that old icon font, so the
    // glyph appeared as a green box with an X. Use a tiny self-contained link
    // SVG instead. Namu's image-only links (such as YouTube icon templates)
    // should not receive a second external-link badge.
    const externalLinkStyle = document.createElement("style");
    externalLinkStyle.dataset.kpoparkiveRuntime = "external-link-fidelity";
    externalLinkStyle.textContent = `
      .thetreeWikiBaseline .wiki-link-external::before,
      .namumarkPocDocument.wiki-content .wiki-link-external::before {
        content: "" !important;
        display: inline-block !important;
        box-sizing: border-box !important;
        position: relative !important;
        width: 1em !important;
        height: 1em !important;
        margin: 0 .16em 0 0 !important;
        padding: 0 !important;
        vertical-align: -.12em !important;
        background-color: transparent !important;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='2' fill='%2300903d'/%3E%3Cpath d='M6.55 5.15 7.7 4a2.55 2.55 0 0 1 3.6 3.6L10.15 8.75M9.45 10.85 8.3 12a2.55 2.55 0 0 1-3.6-3.6l1.15-1.15M6.45 9.55l3.1-3.1' fill='none' stroke='white' stroke-width='1.45' stroke-linecap='round'/%3E%3C/svg%3E") !important;
        background-repeat: no-repeat !important;
        background-position: center !important;
        background-size: contain !important;
        color: transparent !important;
        font-family: inherit !important;
      }
      .thetreeWikiBaseline .wiki-link-external.kpoparkiveExternalMediaLink::before,
      .namumarkPocDocument.wiki-content .wiki-link-external.kpoparkiveExternalMediaLink::before {
        display: none !important;
      }
    `;
    document.head.appendChild(externalLinkStyle);
    cleanups.push(() => externalLinkStyle.remove());

    for (const root of roots) {
      // The pinned The Tree frontend intentionally gives table wrappers
      // overflow-x:auto. In Chromium that makes the other axis compute to auto
      // as well; nested 100%-width tables with negative margins can then create
      // a tiny y-overflow and an unwanted vertical scrollbar. Table wrappers
      // are auto-height, so vertical scrolling is never needed here.
      for (const tableWrap of Array.from(root.querySelectorAll<HTMLElement>(".wiki-table-wrap"))) {
        const previousOverflowY = tableWrap.style.overflowY;
        const previousPriority = tableWrap.style.getPropertyPriority("overflow-y");
        tableWrap.style.setProperty("overflow-y", "hidden", "important");
        cleanups.push(() => {
          if (previousOverflowY) tableWrap.style.setProperty("overflow-y", previousOverflowY, previousPriority);
          else tableWrap.style.removeProperty("overflow-y");
        });
      }

      for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>("a.wiki-link-external"))) {
        if (anchor.querySelector(".wiki-image-align, .wiki-image-wrapper, img.wiki-image, video.wiki-image")) {
          anchor.classList.add("kpoparkiveExternalMediaLink");
        }
      }

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

        for (const [, targetClass] of actions) {
          if (!targetClass) continue;
          for (const target of Array.from(root.getElementsByClassName(targetClass))) {
            if (!(target instanceof HTMLElement)) continue;
            prepareCapturedToggleTarget(target);
            if (target.dataset.kpoparkiveToggleHiddenPanel === "1") {
              releaseCapturedToggleFlow(trigger, target, root);
            }
          }
        }

        const handler = (event: Event) => {
          event.preventDefault();
          event.stopPropagation();

          for (const [operation, targetClass, className] of actions) {
            if (!targetClass || !className) continue;
            const targets = Array.from(root.getElementsByClassName(targetClass));
            for (const target of targets) {
              if (!(target instanceof HTMLElement)) continue;
              applyCapturedClassOperation(target, operation, className);
            }
          }
        };

        trigger.addEventListener("click", handler);
        cleanups.push(() => trigger.removeEventListener("click", handler));
      }

      for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img.wiki-image, img[data-src], img[data-video-src]"))) {
        if (hydrateVideoBackedImage(image)) continue;
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
}

export default function TheTreeRuntimeBridge() {
  useEffect(() => {
    let cleanupHydration = hydrateTheTreeRuntime();

    const refresh = () => {
      cleanupHydration();
      cleanupHydration = hydrateTheTreeRuntime();
    };

    window.addEventListener("kpoparkive:thetree-refresh", refresh);
    return () => {
      window.removeEventListener("kpoparkive:thetree-refresh", refresh);
      cleanupHydration();
    };
  }, []);

  return null;
}
