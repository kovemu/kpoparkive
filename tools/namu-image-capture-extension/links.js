function kpopDecodeLinkTitle(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

const KPOP_SKIP_NAMESPACES = [
  "파일:", "File:", "틀:", "Template:", "분류:", "Category:", "사용자:", "User:",
  "나무위키:", "NamuWiki:", "특수기능:", "Special:", "토론:", "Discussion:", "휴지통:",
];

const KPOP_LOW_VALUE_EXACT_TITLES = new Set([
  "대한민국", "한국", "일본", "미국", "중국", "대만",
  "K-POP", "KPOP", "R&B", "발라드", "댄스",
  "YouTube", "유튜브", "Instagram", "인스타그램", "TikTok", "틱톡", "Facebook", "페이스북",
]);

const KPOP_HIGH_VALUE_SECTION_RE = /(멤버|음반|앨범|디스코그래피|활동|콘텐츠|공연|행사|음악\s*방송|직캠|수상|팬덤|응원법|굿즈|프로필|유튜브\s*라이브|youtube\s*live)/i;
const KPOP_MEDIUM_VALUE_SECTION_RE = /(개요|특징|로고|그룹명|콘셉트|컨셉|여담)/i;
const KPOP_LOW_VALUE_SECTION_RE = /(둘러보기|각주|외부\s*링크|관련\s*문서)/i;

function kpopIsCalendarNoiseTitle(title) {
  const value = String(title || "").normalize("NFKC").trim();
  if (!value) return true;

  // NamuWiki turns dates/years into links very aggressively. These pages are
  // almost never useful to a K-pop entity cluster and can explode recursive
  // crawling (e.g. "3월 26일", "2025년", "2024년 8월 16일").
  return /^(?:18|19|20|21)\d{2}년$/u.test(value)
    || /^(?:18|19|20|21)\d{2}$/u.test(value)
    || /^(?:18|19|20|21)\d{2}년\s*(?:1[0-2]|[1-9])월(?:\s*(?:3[01]|[12]\d|[1-9])일)?$/u.test(value)
    || /^(?:1[0-2]|[1-9])월(?:\s*(?:3[01]|[12]\d|[1-9])일)?$/u.test(value)
    || /^(?:3[01]|[12]\d|[1-9])일$/u.test(value);
}

function kpopShouldCloneTitle(title) {
  const value = String(title || "").normalize("NFKC").trim();
  if (!value) return false;
  if (value.startsWith("#")) return false;
  if (KPOP_SKIP_NAMESPACES.some((prefix) => value.startsWith(prefix))) return false;
  if (kpopIsCalendarNoiseTitle(value)) return false;
  if (KPOP_LOW_VALUE_EXACT_TITLES.has(value)) return false;
  return true;
}

function kpopSectionId(value) {
  const match = String(value || "").trim().match(/^s-(\d+(?:\.\d+)*)$/i);
  return match ? `s-${match[1]}` : "";
}

function kpopBuildTocMeta() {
  const meta = new Map();
  let index = 0;
  for (const anchor of document.querySelectorAll('a[href^="#s-"]')) {
    const raw = String(anchor.getAttribute("href") || "").trim().slice(1);
    const sectionId = kpopSectionId(raw);
    if (!sectionId || meta.has(sectionId)) continue;
    const text = String(anchor.textContent || "").replace(/\s+/g, " ").trim();
    meta.set(sectionId, { order: index++, title: text });
  }
  return meta;
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

function kpopLinkPriority({ title, sectionTitle, sourceArea }) {
  const normalizedTitle = String(title || "").normalize("NFKC");
  const section = String(sectionTitle || "");

  // Subdocuments and disambiguated artist/member pages are extremely likely
  // to belong to the same wiki cluster.
  if (/\//u.test(normalizedTitle) || /\([^)]{2,}\)$/u.test(normalizedTitle)) return 100;
  if (KPOP_HIGH_VALUE_SECTION_RE.test(section)) return 90;
  if (KPOP_MEDIUM_VALUE_SECTION_RE.test(section)) return 60;
  if (KPOP_LOW_VALUE_SECTION_RE.test(section)) return 10;
  if (sourceArea === "section") return 45;
  return 25;
}

function kpopExtractInternalLinks() {
  const currentTitle = (() => {
    const match = location.pathname.match(/^\/w\/(.+)$/);
    return match ? kpopDecodeLinkTitle(match[1]) : "";
  })();

  const tocMeta = kpopBuildTocMeta();
  const byTitle = new Map();
  let currentSection = "";
  let domOrder = 0;

  for (const element of document.querySelectorAll("*")) {
    const sectionId = kpopSectionId(element.id);
    if (sectionId) currentSection = sectionId;
    if (element.tagName !== "A") continue;

    const link = kpopInternalLinkFromAnchor(element, currentTitle);
    if (!link) continue;

    const sectionMeta = currentSection ? tocMeta.get(currentSection) : null;
    const candidate = {
      ...link,
      section: currentSection || null,
      sectionTitle: sectionMeta?.title || null,
      tocOrder: sectionMeta?.order ?? null,
      sourceArea: currentSection ? "section" : "preamble",
      priority: kpopLinkPriority({
        title: link.title,
        sectionTitle: sectionMeta?.title || "",
        sourceArea: currentSection ? "section" : "preamble",
      }),
      domOrder: domOrder++,
    };

    const existing = byTitle.get(link.title);
    if (!existing) {
      byTitle.set(link.title, candidate);
    } else if (
      candidate.priority > existing.priority
      || (candidate.priority === existing.priority && (candidate.tocOrder ?? Number.MAX_SAFE_INTEGER) < (existing.tocOrder ?? Number.MAX_SAFE_INTEGER))
    ) {
      byTitle.set(link.title, candidate);
    }

    if (byTitle.size >= 2000) break;
  }

  // Crawl only meaningful K-pop cluster candidates. Low-priority links remain
  // visible in the captured HTML and therefore still work as hyperlinks; they
  // simply do not consume recursive clone budget.
  const links = [...byTitle.values()]
    .filter((link) => link.priority >= 45)
    .sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      const aRank = a.tocOrder == null ? Number.MAX_SAFE_INTEGER : a.tocOrder;
      const bRank = b.tocOrder == null ? Number.MAX_SAFE_INTEGER : b.tocOrder;
      if (aRank !== bRank) return aRank - bRank;
      return a.domOrder - b.domOrder;
    })
    .map(({ domOrder: _domOrder, ...link }) => link);

  return {
    sourceTitle: currentTitle,
    tocSections: tocMeta.size,
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
