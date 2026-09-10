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

export default function TheTreeRuntimeBridge() {
  useEffect(() => {
    const roots = Array.from(
      document.querySelectorAll<HTMLElement>(".thetreeWikiBaseline, .namumarkPocDocument.wiki-content"),
    );
    if (!roots.length) return;

    const cleanups: Array<() => void> = [];

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
  }, []);

  return null;
}
