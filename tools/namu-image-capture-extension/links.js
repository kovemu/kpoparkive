function kpopDecodeLinkTitle(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

const KPOP_SKIP_NAMESPACES = [
  "파일:", "File:", "틀:", "Template:", "분류:", "Category:", "사용자:", "User:",
  "나무위키:", "NamuWiki:", "특수기능:", "Special:", "토론:", "Discussion:", "휴지통:",
];

function kpopShouldCloneTitle(title) {
  const value = String(title || "").normalize("NFKC").trim();
  if (!value) return false;
  if (value.startsWith("#")) return false;
  return !KPOP_SKIP_NAMESPACES.some((prefix) => value.startsWith(prefix));
}

function kpopSectionId(value) {
  const match = String(value || "").trim().match(/^s-(\d+(?:\.\d+)*)$/i);
  return match ? `s-${match[1]}` : "";
}

function kpopBuildTocOrder() {
  const order = new Map();
  let index = 0;
  for (const anchor of document.querySelectorAll('a[href^="#s-"]')) {
    const raw = String(anchor.getAttribute("href") || "").trim().slice(1);
    const sectionId = kpopSectionId(raw);
    if (!sectionId || order.has(sectionId)) continue;
    order.set(sectionId, index++);
  }
  return order;
}

function kpopInternalLinkFromAnchor(anchor, currentTitle) {
  const raw = String(anchor.getAttribute("href") || "").trim();
  if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return null;

  let url;
  try { url = new URL(raw, location.href); } catch { return null; }
  if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) return null;
  if (!url.pathname.startsWith("/w/")) return null;

  const encoded = url.pathname.slice(3);
  const title = kpopDecodeLinkTitle(encoded).normalize("NFKC").trim();
  if (!kpopShouldCloneTitle(title) || title === currentTitle) return null;

  return {
    title,
    href: `https://namu.wiki/w/${encodeURIComponent(title)}`,
    text: (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
  };
}

function kpopExtractInternalLinks() {
  const currentTitle = (() => {
    const match = location.pathname.match(/^\/w\/(.+)$/);
    return match ? kpopDecodeLinkTitle(match[1]) : "";
  })();

  const tocOrder = kpopBuildTocOrder();
  const byTitle = new Map();
  let currentSection = "";
  let domOrder = 0;

  // Walk the live rendered DOM in document order. NamuWiki places stable ids
  // such as s-1, s-2, s-6.3.1 on the actual section headings. Links inside
  // those sections are more valuable to a wiki clone than links in the
  // infobox/preamble/navigation, so rank section links by the page's own TOC.
  for (const element of document.querySelectorAll("*")) {
    const sectionId = kpopSectionId(element.id);
    if (sectionId) currentSection = sectionId;
    if (element.tagName !== "A") continue;

    const link = kpopInternalLinkFromAnchor(element, currentTitle);
    if (!link) continue;

    const sectionRank = currentSection && tocOrder.has(currentSection)
      ? tocOrder.get(currentSection)
      : Number.MAX_SAFE_INTEGER;
    const candidate = {
      ...link,
      section: currentSection || null,
      tocOrder: Number.isFinite(sectionRank) && sectionRank !== Number.MAX_SAFE_INTEGER ? sectionRank : null,
      sourceArea: currentSection ? "section" : "preamble",
      domOrder: domOrder++,
    };

    const existing = byTitle.get(link.title);
    if (!existing) {
      byTitle.set(link.title, candidate);
    } else {
      const existingRank = existing.tocOrder == null ? Number.MAX_SAFE_INTEGER : existing.tocOrder;
      const candidateRank = candidate.tocOrder == null ? Number.MAX_SAFE_INTEGER : candidate.tocOrder;
      // If a title first appeared in the infobox but later appears in a real
      // TOC section, keep the section occurrence so the crawl follows content
      // semantics rather than page chrome.
      if (candidateRank < existingRank) byTitle.set(link.title, candidate);
    }

    if (byTitle.size >= 2000) break;
  }

  const links = [...byTitle.values()].sort((a, b) => {
    const aRank = a.tocOrder == null ? Number.MAX_SAFE_INTEGER : a.tocOrder;
    const bRank = b.tocOrder == null ? Number.MAX_SAFE_INTEGER : b.tocOrder;
    if (aRank !== bRank) return aRank - bRank;
    return a.domOrder - b.domOrder;
  }).map(({ domOrder: _domOrder, ...link }) => link);

  return {
    sourceTitle: currentTitle,
    tocSections: tocOrder.size,
    links,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-links") return;
  try {
    sendResponse({ ok: true, ...kpopExtractInternalLinks() });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
