"use client";

import { useEffect } from "react";

const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|me|co\.kr|or\.kr|ne\.kr|kr)\b/gi;
const EXPLICIT_AD_RE = /(?:파워링크|광고등록|sponsored|advertisement|promoted\s+link|adchoices)/i;

function cleanArtifactAds() {
  const scope = document.querySelector<HTMLElement>("[data-kpop-browser-artifact]");
  if (!scope) return;
  const captureRoot = scope.querySelector<HTMLElement>('[data-kpop-capture-root="true"]');
  const rootHeight = Number(captureRoot?.getAttribute("data-kpop-layout-height") || 0) || captureRoot?.getBoundingClientRect().height || 0;
  if (!rootHeight) return;

  const candidates: Array<{ element: HTMLElement; area: number }> = [];
  for (const element of Array.from(scope.querySelectorAll<HTMLElement>("div,section,aside,table"))) {
    const y = Number(element.getAttribute("data-kpop-layout-y") || NaN);
    const h = Number(element.getAttribute("data-kpop-layout-height") || NaN);
    const rect = element.getBoundingClientRect();
    const height = Number.isFinite(h) && h > 0 ? h : rect.height;
    if (!Number.isFinite(y) || y < rootHeight * 0.68) continue;
    if (rect.width < 260 || height < 35 || height > 520) continue;

    const text = String(element.textContent || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 9000) continue;
    const domains = new Set(
      (text.match(DOMAIN_RE) || [])
        .map((value) => value.toLowerCase().replace(/^www\./, ""))
        .filter((value) => !/(?:^|\.)namu\.wiki$/.test(value) && !/(?:^|\.)youtube\.com$/.test(value)),
    );
    const anchors = element.querySelectorAll("a").length;
    const tables = element.querySelectorAll("table").length;
    const headings = element.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
    const explicit = EXPLICIT_AD_RE.test(text) || EXPLICIT_AD_RE.test(element.getAttribute("aria-label") || "");
    if (!(explicit && anchors >= 2) && !(domains.size >= 2 && anchors >= 6 && tables >= 2 && headings === 0)) continue;

    candidates.push({ element, area: Math.max(rect.width, 1) * Math.max(height, 1) });
  }

  candidates.sort((a, b) => b.area - a.area);
  const removed: HTMLElement[] = [];
  for (const candidate of candidates) {
    if (!candidate.element.isConnected) continue;
    if (removed.some((node) => node.contains(candidate.element))) continue;
    removed.push(candidate.element);
    candidate.element.remove();
  }
}

function thawAncestors(element: HTMLElement, scope: HTMLElement) {
  let current: HTMLElement | null = element;
  for (let depth = 0; current && current !== scope && depth < 80; depth += 1, current = current.parentElement) {
    const position = window.getComputedStyle(current).position;
    if (position !== "absolute" && position !== "fixed") {
      current.style.setProperty("height", "auto", "important");
      current.style.setProperty("min-height", "0", "important");
      current.style.setProperty("max-height", "none", "important");
      current.style.setProperty("overflow-y", "visible", "important");
    }
  }
}

function elementsForClass(scope: HTMLElement, className: string) {
  if (!className) return [] as HTMLElement[];
  try {
    return Array.from(scope.getElementsByClassName(className)).filter((node): node is HTMLElement => node instanceof HTMLElement);
  } catch {
    return [] as HTMLElement[];
  }
}

function setReplayClassVisible(scope: HTMLElement, className: string, visible: boolean) {
  const nodes = elementsForClass(scope, className);
  for (const node of nodes) {
    if (node.matches("a[data-onclick],button[data-onclick]")) continue;
    if (visible) {
      const preferred = node.dataset.kpopReplayDisplay || (node.tagName === "SPAN" ? "inline" : "block");
      node.style.setProperty("display", preferred, "important");
      node.style.setProperty("height", "auto", "important");
      node.style.setProperty("max-height", "none", "important");
      node.style.setProperty("overflow", "visible", "important");
      thawAncestors(node, scope);
    } else {
      if (!node.dataset.kpopReplayDisplay) {
        const inlineDisplay = node.style.display;
        if (inlineDisplay && inlineDisplay !== "none") node.dataset.kpopReplayDisplay = inlineDisplay;
      }
      node.style.setProperty("display", "none", "important");
    }
  }
}

function setReplayButtonActive(scope: HTMLElement, className: string, active: boolean) {
  const buttons = elementsForClass(scope, className).filter((node) => node.matches("a[data-onclick],button[data-onclick]"));
  for (const button of buttons) {
    if (active) {
      const parentBg = button.parentElement ? window.getComputedStyle(button.parentElement).backgroundColor : "";
      button.style.setProperty("background-color", "rgb(255, 255, 255)", "important");
      if (parentBg && parentBg !== "rgba(0, 0, 0, 0)" && parentBg !== "transparent") {
        button.style.setProperty("color", parentBg, "important");
      }
    } else {
      button.style.setProperty("background-color", "rgba(255, 255, 255, 0.2)", "important");
      button.style.setProperty("color", "rgb(255, 255, 255)", "important");
    }
  }
}

function parseReplayCommands(raw: string) {
  return raw.split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const [command = "", className = "", scopeClass = ""] = part.split(",").map((value) => value.trim());
    return { command, className, scopeClass };
  }).filter((item) => item.command && item.className);
}

function bindArtifactInteractions() {
  const scope = document.querySelector<HTMLElement>("[data-kpop-browser-artifact]");
  if (!scope) return () => {};

  const onClick = (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-onclick]") : null;
    if (!target || !scope.contains(target)) return;
    const raw = target.getAttribute("data-onclick") || "";
    if (!raw) return;

    const commands = parseReplayCommands(raw);
    if (!commands.length) return;
    if (target instanceof HTMLAnchorElement && target.getAttribute("href") === "#") event.preventDefault();

    const removeClasses = commands.filter((item) => item.command === "remove-class").map((item) => item.className);
    const addClasses = commands.filter((item) => item.command === "add-class").map((item) => item.className);
    const toggleClasses = commands.filter((item) => item.command === "toggle-class").map((item) => item.className);

    for (const className of removeClasses) {
      setReplayClassVisible(scope, className, false);
      setReplayButtonActive(scope, className, false);
    }
    for (const className of addClasses) {
      setReplayClassVisible(scope, className, true);
      if (removeClasses.length) setReplayButtonActive(scope, className, true);
    }
    for (const className of toggleClasses) {
      const panels = elementsForClass(scope, className).filter((node) => !node.matches("a[data-onclick],button[data-onclick]"));
      const shouldShow = removeClasses.length > 0 || panels.some((node) => window.getComputedStyle(node).display === "none");
      setReplayClassVisible(scope, className, shouldShow);
      if (removeClasses.length) setReplayButtonActive(scope, className, shouldShow);
    }

    window.requestAnimationFrame(() => enhanceArtifactLayout());
  };

  scope.addEventListener("click", onClick);
  return () => scope.removeEventListener("click", onClick);
}

function enhanceArtifactLayout() {
  const scope = document.querySelector<HTMLElement>("[data-kpop-browser-artifact]");
  if (!scope) return;
  const captureRoot = scope.querySelector<HTMLElement>('[data-kpop-capture-root="true"]');
  if (!captureRoot) return;

  scope.style.setProperty("width", "100%", "important");
  scope.style.setProperty("max-width", "100%", "important");
  scope.style.setProperty("margin-left", "auto", "important");
  scope.style.setProperty("margin-right", "auto", "important");
  scope.style.setProperty("overflow", "visible", "important");

  captureRoot.style.setProperty("width", "100%", "important");
  captureRoot.style.setProperty("max-width", "100%", "important");
  captureRoot.style.setProperty("min-width", "0", "important");
  captureRoot.style.setProperty("margin-left", "auto", "important");
  captureRoot.style.setProperty("margin-right", "auto", "important");
  captureRoot.style.setProperty("left", "auto", "important");
  captureRoot.style.setProperty("right", "auto", "important");
  captureRoot.style.setProperty("transform", "none", "important");
  captureRoot.style.setProperty("overflow", "visible", "important");

  const mobile = window.matchMedia("(max-width: 768px)").matches;
  if (!mobile) return;
  const available = Math.max(scope.clientWidth || window.innerWidth, 280);

  for (const element of Array.from(scope.querySelectorAll<HTMLElement>("[data-kpop-layout-width]"))) {
    const layoutWidth = Number(element.getAttribute("data-kpop-layout-width") || 0);
    if (!Number.isFinite(layoutWidth) || layoutWidth <= available * 1.04) continue;
    const position = window.getComputedStyle(element).position;
    if (position === "absolute" || position === "fixed") continue;
    const tag = element.tagName.toLowerCase();
    if (["div", "section", "article", "main", "header", "footer", "nav", "aside", "p", "blockquote", "pre", "ul", "ol", "li", "dl", "table"].includes(tag)) {
      element.style.setProperty("max-width", "100%", "important");
      element.style.setProperty("min-width", "0", "important");
      if (tag !== "table") element.style.setProperty("width", "auto", "important");
      element.style.setProperty("margin-left", "0", "important");
      element.style.setProperty("margin-right", "0", "important");
      element.style.setProperty("left", "auto", "important");
      element.style.setProperty("right", "auto", "important");
      element.style.setProperty("transform", "none", "important");
    }
  }

  for (const media of Array.from(scope.querySelectorAll<HTMLElement>("img,video,iframe"))) {
    media.style.setProperty("max-width", "100%", "important");
    media.style.setProperty("height", "auto", "important");
  }
}

export default function NamuArtifactAdCleaner() {
  useEffect(() => {
    cleanArtifactAds();
    enhanceArtifactLayout();
    const unbind = bindArtifactInteractions();
    const first = window.setTimeout(() => { cleanArtifactAds(); enhanceArtifactLayout(); }, 250);
    const second = window.setTimeout(() => { cleanArtifactAds(); enhanceArtifactLayout(); }, 1000);
    window.addEventListener("resize", enhanceArtifactLayout);
    return () => {
      unbind();
      window.clearTimeout(first);
      window.clearTimeout(second);
      window.removeEventListener("resize", enhanceArtifactLayout);
    };
  }, []);
  return null;
}
