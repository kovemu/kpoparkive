// Root-selection guard for Browser Artifact capture.
// NamuWiki class names are hashed and change frequently, so this file avoids
// class-name hardcoding. It identifies the article by title/section invariants
// and treats full-width shells containing site navigation/right-rail widgets as
// site chrome rather than document content.

const KPOP_SITE_CHROME_TEXT = [
  "최근 변경",
  "최근 토론",
  "특수 기능",
  "실시간 검색어",
  "실시간검색어",
  "여기에서 검색",
];

function kpopRootGuardVisible(element) {
  if (!(element instanceof Element)) return false;
  try {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  } catch {
    return false;
  }
}

function kpopRootGuardChromeHits(element) {
  if (!(element instanceof Element)) return 0;
  const text = kpopNormalizeText(element.textContent || "");
  let hits = 0;
  for (const marker of KPOP_SITE_CHROME_TEXT) {
    if (text.includes(marker)) hits += 1;
  }

  // Search box is a particularly strong signal for the site shell. This uses
  // semantic attributes instead of NamuWiki's generated class names.
  for (const input of element.querySelectorAll("input,textarea")) {
    const placeholder = kpopNormalizeText(input.getAttribute("placeholder") || "");
    const aria = kpopNormalizeText(input.getAttribute("aria-label") || "");
    if (placeholder.includes("검색") || aria.includes("검색")) {
      hits += 1;
      break;
    }
  }
  return hits;
}

function kpopRootGuardIsDesktopWide(metrics) {
  if (!metrics || window.innerWidth < 900) return false;
  const threshold = Math.max(1180, window.innerWidth * 0.82);
  return Number(metrics.width || 0) >= threshold;
}

function kpopRootGuardIsSiteShell(element, metrics) {
  // A legitimate article may mention one of these phrases in prose, so only
  // reject when the candidate is also nearly viewport-wide. This is what
  // distinguishes the ~982-1032px article body from the ~1732px site shell.
  if (!kpopRootGuardIsDesktopWide(metrics)) return false;
  return kpopRootGuardChromeHits(element) >= 2;
}

function kpopRootGuardCandidateEntry(element, extra = {}) {
  const metrics = kpopElementMetrics(element);
  return {
    element,
    metrics,
    chromeHits: kpopRootGuardChromeHits(element),
    desktopWide: kpopRootGuardIsDesktopWide(metrics),
    ...extra,
  };
}

// Broaden title detection. Some NamuWiki pages render the visible page title in
// a non-heading wrapper, which made v2 fall through to the full-width shell.
function kpopFindTitleElement(sourceTitle) {
  const wanted = kpopNormalizeText(sourceTitle);
  if (!wanted) return null;

  const candidates = [];
  const seen = new Set();
  const selectors = "h1,h2,h3,h4,h5,h6,[role='heading'],strong,b,span,div";
  for (const element of document.querySelectorAll(selectors)) {
    if (!(element instanceof Element) || seen.has(element)) continue;
    seen.add(element);
    if (!kpopRootGuardVisible(element)) continue;
    if (element.closest("header,nav,aside")) continue;

    const text = kpopNormalizeText(element.textContent || "");
    if (!text || text.length > wanted.length + 40) continue;
    const exact = text === wanted;
    const near = !exact && (text.includes(wanted) || wanted.includes(text));
    if (!exact && !near) continue;

    const rect = element.getBoundingClientRect();
    let fontSize = 0;
    let fontWeight = 0;
    try {
      const style = getComputedStyle(element);
      fontSize = parseFloat(style.fontSize) || 0;
      fontWeight = parseInt(style.fontWeight, 10) || 0;
    } catch {}

    // Prefer exact, prominent, compact title elements near the top of the page.
    const score = (exact ? 10000 : 3000)
      + Math.min(fontSize, 48) * 40
      + (fontWeight >= 600 ? 500 : 0)
      - Math.max(0, rect.top) * 0.05
      - Math.max(0, rect.width - 1200) * 0.5
      - element.querySelectorAll("*").length * 3;
    candidates.push({ element, score });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.element || null;
}

function kpopRootGuardVisibleSectionMarkers() {
  return Array.from(document.querySelectorAll("[id]"))
    .filter(kpopIsSectionMarker)
    .filter(kpopRootGuardVisible);
}

function kpopRootGuardPickEnvelope(startElement, sectionMarkers, titleElement = null, strategy = "section-envelope-v3") {
  if (!(startElement instanceof Element) || !sectionMarkers.length) return null;
  const required = Math.max(1, Math.ceil(sectionMarkers.length * 0.8));
  const candidates = [];

  let current = startElement;
  for (let depth = 0; current && depth < 24; depth += 1, current = current.parentElement) {
    if (!(current instanceof Element)) continue;
    if (current === document.body || current === document.documentElement) break;
    if (!["DIV", "SECTION", "ARTICLE", "MAIN"].includes(current.tagName) && current.getAttribute("role") !== "main") continue;

    let containedSections = 0;
    for (const marker of sectionMarkers) if (current.contains(marker)) containedSections += 1;
    if (containedSections < required) continue;

    const entry = kpopRootGuardCandidateEntry(current, {
      containedSections,
      containsTitle: titleElement ? current.contains(titleElement) : false,
    });
    if (!entry.metrics.visible || entry.metrics.textLength < 250) continue;
    if (kpopRootGuardIsSiteShell(current, entry.metrics)) continue;
    candidates.push(entry);
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    if (a.containsTitle !== b.containsTitle) return a.containsTitle ? -1 : 1;
    if (a.desktopWide !== b.desktopWide) return a.desktopWide ? 1 : -1;
    if (a.chromeHits !== b.chromeHits) return a.chromeHits - b.chromeHits;
    if (a.metrics.nodes !== b.metrics.nodes) return a.metrics.nodes - b.metrics.nodes;
    return a.metrics.width - b.metrics.width;
  });

  const best = candidates[0];
  return {
    element: best.element,
    selector: kpopDescribeElement(best.element),
    strategy,
    metrics: best.metrics,
    candidateCount: candidates.length,
    anchorSections: sectionMarkers.length,
    containedSections: best.containedSections,
    chromeHits: best.chromeHits,
  };
}

function kpopFindAnchoredDocumentRoot() {
  const titleElement = kpopFindTitleElement(kpopSourceTitleFromLocation());
  if (!titleElement) return null;
  const sectionMarkers = kpopRootGuardVisibleSectionMarkers();
  if (!sectionMarkers.length) return null;
  return kpopRootGuardPickEnvelope(
    titleElement.parentElement || titleElement,
    sectionMarkers,
    titleElement,
    "document-title-sections-v3",
  );
}

function kpopRootGuardFindSectionEnvelope() {
  const sectionMarkers = kpopRootGuardVisibleSectionMarkers();
  if (!sectionMarkers.length) return null;
  const titleElement = kpopFindTitleElement(kpopSourceTitleFromLocation());
  return kpopRootGuardPickEnvelope(
    sectionMarkers[0].parentElement || sectionMarkers[0],
    sectionMarkers,
    titleElement,
    "section-envelope-v3",
  );
}

function kpopFindPresentationRoot() {
  // 1) Strongest invariant: page title + section markers.
  const anchored = kpopFindAnchoredDocumentRoot();
  if (anchored) return anchored;

  // 2) Even if NamuWiki changes the title wrapper, the common envelope of the
  //    s-N section anchors still identifies the document body without the
  //    global header, search box, recent changes, or right rail.
  const sectionEnvelope = kpopRootGuardFindSectionEnvelope();
  if (sectionEnvelope) return sectionEnvelope;

  // 3) Semantic main candidates, but never accept a desktop-wide site shell.
  const semantic = Array.from(document.querySelectorAll("article,main,[role='main']"))
    .map((element) => kpopRootGuardCandidateEntry(element))
    .filter((entry) => entry.metrics.visible && entry.metrics.score > 1200)
    .filter((entry) => !kpopRootGuardIsSiteShell(entry.element, entry.metrics))
    .sort((a, b) => {
      if (a.desktopWide !== b.desktopWide) return a.desktopWide ? 1 : -1;
      if (a.chromeHits !== b.chromeHits) return a.chromeHits - b.chromeHits;
      return b.metrics.score - a.metrics.score;
    });
  if (semantic.length) {
    const best = semantic[0];
    return {
      element: best.element,
      selector: kpopDescribeElement(best.element),
      strategy: "semantic-main-v3",
      metrics: best.metrics,
      candidateCount: semantic.length,
      chromeHits: best.chromeHits,
    };
  }

  // 4) Content envelope fallback, with the same site-shell rejection rule.
  const candidates = kpopCollectRootCandidates()
    .filter((element) => element !== document.body && element !== document.documentElement)
    .map((element) => kpopRootGuardCandidateEntry(element))
    .filter((entry) => entry.metrics.visible && (entry.metrics.tables >= 1 || entry.metrics.contentImages >= 2) && entry.metrics.textLength >= 300)
    .filter((entry) => !kpopRootGuardIsSiteShell(entry.element, entry.metrics));

  if (candidates.length) {
    const maxTables = Math.max(...candidates.map((entry) => entry.metrics.tables));
    const maxContentImages = Math.max(...candidates.map((entry) => entry.metrics.contentImages));
    const maxText = Math.max(...candidates.map((entry) => entry.metrics.textLength));
    const strong = candidates.filter((entry) => {
      const tableCoverage = maxTables > 0 ? entry.metrics.tables / maxTables : 1;
      const imageCoverage = maxContentImages > 0 ? entry.metrics.contentImages / maxContentImages : 1;
      const textCoverage = maxText > 0 ? entry.metrics.textLength / maxText : 1;
      return (maxTables < 3 || tableCoverage >= 0.72)
        && (maxContentImages < 4 || imageCoverage >= 0.65)
        && (maxText < 1500 || textCoverage >= 0.40);
    });
    const pool = strong.length ? strong : candidates;
    pool.sort((a, b) => {
      if (a.desktopWide !== b.desktopWide) return a.desktopWide ? 1 : -1;
      if (a.chromeHits !== b.chromeHits) return a.chromeHits - b.chromeHits;
      if (a.metrics.nodes !== b.metrics.nodes) return a.metrics.nodes - b.metrics.nodes;
      return a.metrics.width - b.metrics.width;
    });
    const best = pool[0];
    return {
      element: best.element,
      selector: kpopDescribeElement(best.element),
      strategy: strong.length ? "content-envelope-v3" : "content-score-fallback-v3",
      metrics: best.metrics,
      candidateCount: candidates.length,
      chromeHits: best.chromeHits,
      maxima: { tables: maxTables, contentImages: maxContentImages, textLength: maxText },
    };
  }

  // On desktop, refusing a capture is safer than persisting the whole NamuWiki
  // shell. Mobile capture may legitimately be viewport-wide, so retain body as
  // a last resort only there.
  if (window.innerWidth < 900 && document.body) {
    const metrics = kpopElementMetrics(document.body);
    if (metrics.score > 1200) {
      return {
        element: document.body,
        selector: "body",
        strategy: "mobile-body-last-resort-v3",
        metrics,
        candidateCount: 0,
      };
    }
  }
  return null;
}
