function kpopDecodeLinkTitle(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

const KPOP_CRAWL_POLICY_VERSION = 2;

const KPOP_SKIP_NAMESPACES = [
  "파일:", "File:", "틀:", "Template:", "분류:", "Category:", "사용자:", "User:",
  "나무위키:", "NamuWiki:", "특수기능:", "Special:", "토론:", "Discussion:", "휴지통:",
];

const KPOP_SKIP_EXACT_TITLES = new Set([
  "대한민국", "한국", "조선민주주의인민공화국", "북한", "일본", "중국", "중화인민공화국", "대만",
  "미국", "영국", "프랑스", "독일", "캐나다", "호주", "러시아", "태국", "필리핀", "베트남",
  "인도네시아", "말레이시아", "싱가포르", "홍콩", "마카오",
  "K-POP", "KPOP", "J-POP", "C-POP", "R&B", "발라드", "댄스", "힙합", "랩", "보컬",
  "아이돌", "가수", "음악", "노래", "앨범", "싱글",
  "YouTube", "유튜브", "Instagram", "인스타그램", "TikTok", "틱톡", "Facebook", "페이스북",
  "Spotify", "스포티파이", "X", "Twitter", "트위터", "Weverse", "위버스", "네이버", "Naver",
]);

const KPOP_MEMBER_SECTION_RE = /(멤버|프로필)/i;
const KPOP_EXPAND_SECTION_RE = /(음반|앨범|디스코그래피|활동|콘텐츠|공연|콘서트|팬미팅|투어|행사|음악\s*방송|직캠|수상|팬덤|응원법|굿즈|유튜브\s*라이브|youtube\s*live|멤버\s*간\s*케미)/i;
const KPOP_LEAF_RELATION_RE = /(소속사|레이블|기획사|대표(?:이사)?|ceo|프로듀서|작곡|작사|편곡|안무|감독|제작사|유통사|방송사|방송국|시상식|공연장|협업|피처링|feat\.?|featuring)/i;
const KPOP_SKIP_CONTEXT_RE = /(출생지|출신지|고향|국적|본관|신체|혈액형|별자리|학력|학교|대학교|고등학교|중학교|초등학교|언어)/i;
const KPOP_LOW_VALUE_SECTION_RE = /(둘러보기|각주|외부\s*링크)/i;

function kpopIsCalendarNoiseTitle(title) {
  const value = String(title || "").normalize("NFKC").trim();
  if (!value) return true;
  return /^(?:18|19|20|21)\d{2}년$/u.test(value)
    || /^(?:18|19|20|21)\d{2}$/u.test(value)
    || /^(?:18|19|20|21)\d{2}년\s*(?:1[0-2]|[1-9])월(?:\s*(?:3[01]|[12]\d|[1-9])일)?$/u.test(value)
    || /^(?:1[0-2]|[1-9])월(?:\s*(?:3[01]|[12]\d|[1-9])일)?$/u.test(value)
    || /^(?:3[01]|[12]\d|[1-9])일$/u.test(value)
    || /^(?:18|19|20|21)\d{2}[.-](?:1[0-2]|0?[1-9])[.-](?:3[01]|[12]\d|0?[1-9])$/u.test(value);
}

function kpopIsNamespaceOrSelf(title, currentTitle) {
  const value = String(title || "").normalize("NFKC").trim();
  if (!value || value === currentTitle || value.startsWith("#")) return true;
  return KPOP_SKIP_NAMESPACES.some((prefix) => value.startsWith(prefix));
}

function kpopSectionId(value) {
  const match = String(value || "").trim().match(/^s-(\d+(?:\.\d+)*)$/i);
  return match ? `s-${match[1]}` : "";
}

function kpopPresentationRootForLinks() {
  try {
    const result = typeof kpopFindPresentationRoot === "function" ? kpopFindPresentationRoot() : null;
    if (result?.element instanceof Element) return result.element;
  } catch {}
  return null;
}

function kpopBuildTocMeta(root) {
  const meta = new Map();
  let index = 0;
  for (const anchor of root.querySelectorAll('a[href^="#s-"]')) {
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
  if (kpopIsNamespaceOrSelf(title, currentTitle)) return null;

  return {
    title,
    href: `https://namu.wiki/w/${encodeURIComponent(title)}`,
    text: (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240),
  };
}

function kpopAnchorContext(anchor) {
  const parts = [];
  let current = anchor;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    if (!(current instanceof Element)) continue;
    if (current.matches("tr,li,p,dd,dt,blockquote,div")) {
      const text = String(current.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 600) parts.push(text);
    }
  }
  return [...new Set(parts)].join(" | ").slice(0, 900);
}

function kpopRelationFromContext(context, sectionTitle) {
  const value = `${sectionTitle || ""} ${context || ""}`;
  if (/(소속사|기획사|레이블)/i.test(value)) return "agency";
  if (/(대표(?:이사)?|ceo)/i.test(value)) return "agency_representative";
  if (/(프로듀서|작곡|작사|편곡|안무|감독)/i.test(value)) return "creative_credit";
  if (/(방송사|방송국|시상식|공연장)/i.test(value)) return "industry_entity";
  if (/(협업|피처링|feat\.?|featuring)/i.test(value)) return "collaboration";
  if (KPOP_MEMBER_SECTION_RE.test(value)) return "member";
  if (KPOP_EXPAND_SECTION_RE.test(sectionTitle || "")) return "core_kpop_document";
  return "related";
}

function kpopClassifyLink({ title, currentTitle, sectionTitle, context }) {
  const normalizedTitle = String(title || "").normalize("NFKC").trim();
  const section = String(sectionTitle || "");
  const contextText = String(context || "");

  if (kpopIsCalendarNoiseTitle(normalizedTitle)) return { crawlMode: "skip", relation: "calendar" };
  if (KPOP_SKIP_EXACT_TITLES.has(normalizedTitle)) return { crawlMode: "skip", relation: "generic_concept" };
  if (KPOP_SKIP_CONTEXT_RE.test(`${section} ${contextText}`)) return { crawlMode: "skip", relation: "profile_attribute" };

  // A document nested under the current page is almost always a first-class wiki subdocument.
  if (normalizedTitle.startsWith(`${currentTitle}/`)) return { crawlMode: "expand", relation: "subdocument" };

  // Agency/credit/industry people are useful as documents, but must not fan out recursively.
  if (KPOP_LEAF_RELATION_RE.test(`${section} ${contextText}`)) {
    return { crawlMode: "leaf", relation: kpopRelationFromContext(contextText, section) };
  }

  if (KPOP_MEMBER_SECTION_RE.test(section)) return { crawlMode: "expand", relation: "member" };
  if (KPOP_EXPAND_SECTION_RE.test(section)) return { crawlMode: "expand", relation: "core_kpop_document" };

  // Related documents are retained, but unknown relations terminate after one capture.
  return { crawlMode: "leaf", relation: kpopRelationFromContext(contextText, section) };
}

function kpopModeRank(mode) {
  return mode === "expand" ? 3 : mode === "leaf" ? 2 : 1;
}

function kpopImportanceTier({ crawlMode, relation, sectionTitle }) {
  if (crawlMode === "skip") return 99;
  if (relation === "subdocument") return 10;
  if (relation === "member") return 20;
  if (relation === "core_kpop_document") return 30;
  if (crawlMode === "expand") return 35;
  if (KPOP_LOW_VALUE_SECTION_RE.test(String(sectionTitle || ""))) return 80;
  if (crawlMode === "leaf") return 50;
  return 70;
}

function kpopLinkPriority({ crawlMode, sectionTitle, sourceArea }) {
  if (crawlMode === "skip") return 0;
  const section = String(sectionTitle || "");
  if (KPOP_MEMBER_SECTION_RE.test(section)) return 140;
  if (crawlMode === "expand" && KPOP_EXPAND_SECTION_RE.test(section)) return 120;
  if (crawlMode === "expand") return 110;
  if (crawlMode === "leaf") return 60;
  if (KPOP_LOW_VALUE_SECTION_RE.test(section)) return 5;
  return sourceArea === "section" ? 30 : 20;
}

function kpopExtractInternalLinks() {
  const currentTitle = (() => {
    const match = location.pathname.match(/^\/w\/(.+)$/);
    return match ? kpopDecodeLinkTitle(match[1]).normalize("NFKC").trim() : "";
  })();

  const root = kpopPresentationRootForLinks();
  if (!root) {
    return {
      sourceTitle: currentTitle,
      crawlPolicyVersion: KPOP_CRAWL_POLICY_VERSION,
      tocSections: 0,
      crawlableCount: 0,
      links: [],
    };
  }

  const tocMeta = kpopBuildTocMeta(root);
  const byTitle = new Map();
  let currentSection = "";
  let domOrder = 0;

  for (const element of root.querySelectorAll("*")) {
    const sectionId = kpopSectionId(element.id);
    if (sectionId) currentSection = sectionId;
    if (element.tagName !== "A") continue;

    const link = kpopInternalLinkFromAnchor(element, currentTitle);
    if (!link) continue;

    const sectionMeta = currentSection ? tocMeta.get(currentSection) : null;
    const context = kpopAnchorContext(element);
    const classification = kpopClassifyLink({
      title: link.title,
      currentTitle,
      sectionTitle: sectionMeta?.title || "",
      context,
    });
    const candidate = {
      ...link,
      crawlMode: classification.crawlMode,
      relation: classification.relation,
      crawlPolicyVersion: KPOP_CRAWL_POLICY_VERSION,
      context,
      section: currentSection || null,
      sectionTitle: sectionMeta?.title || null,
      tocOrder: sectionMeta?.order ?? null,
      sourceArea: currentSection ? "section" : "preamble",
      priority: kpopLinkPriority({
        crawlMode: classification.crawlMode,
        sectionTitle: sectionMeta?.title || "",
        sourceArea: currentSection ? "section" : "preamble",
      }),
      importanceTier: kpopImportanceTier({
        crawlMode: classification.crawlMode,
        relation: classification.relation,
        sectionTitle: sectionMeta?.title || "",
      }),
      domOrder: domOrder++,
    };

    const existing = byTitle.get(link.title);
    if (!existing) {
      byTitle.set(link.title, candidate);
    } else if (
      Number(candidate.importanceTier ?? 99) < Number(existing.importanceTier ?? 99)
      || (
        Number(candidate.importanceTier ?? 99) === Number(existing.importanceTier ?? 99)
        && (candidate.tocOrder ?? Number.MAX_SAFE_INTEGER) < (existing.tocOrder ?? Number.MAX_SAFE_INTEGER)
      )
      || (
        Number(candidate.importanceTier ?? 99) === Number(existing.importanceTier ?? 99)
        && (candidate.tocOrder ?? Number.MAX_SAFE_INTEGER) === (existing.tocOrder ?? Number.MAX_SAFE_INTEGER)
        && candidate.priority > existing.priority
      )
      || (
        Number(candidate.importanceTier ?? 99) === Number(existing.importanceTier ?? 99)
        && (candidate.tocOrder ?? Number.MAX_SAFE_INTEGER) === (existing.tocOrder ?? Number.MAX_SAFE_INTEGER)
        && candidate.priority === existing.priority
        && kpopModeRank(candidate.crawlMode) > kpopModeRank(existing.crawlMode)
      )
    ) {
      byTitle.set(link.title, candidate);
    }

    if (byTitle.size >= 2000) break;
  }

  const links = [...byTitle.values()]
    .sort((a, b) => {
      const tierDiff = Number(a.importanceTier ?? 99) - Number(b.importanceTier ?? 99);
      if (tierDiff) return tierDiff;
      const aRank = a.tocOrder == null ? Number.MAX_SAFE_INTEGER : a.tocOrder;
      const bRank = b.tocOrder == null ? Number.MAX_SAFE_INTEGER : b.tocOrder;
      if (aRank !== bRank) return aRank - bRank;
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.domOrder - b.domOrder;
    })
    .map(({ domOrder: _domOrder, ...link }) => link);

  return {
    sourceTitle: currentTitle,
    crawlPolicyVersion: KPOP_CRAWL_POLICY_VERSION,
    tocSections: tocMeta.size,
    crawlableCount: links.filter((link) => link.crawlMode !== "skip").length,
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