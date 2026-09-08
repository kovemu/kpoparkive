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

export default function NamuArtifactAdCleaner() {
  useEffect(() => {
    cleanArtifactAds();
    const first = window.setTimeout(cleanArtifactAds, 250);
    const second = window.setTimeout(cleanArtifactAds, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
    };
  }, []);
  return null;
}
