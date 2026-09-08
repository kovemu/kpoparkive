(() => {
  const FILTER_VERSION = "1";
  const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|me|co\.kr|or\.kr|ne\.kr|kr)\b/gi;
  const EXPLICIT_AD_RE = /(?:파워링크|광고등록|sponsored|advertisement|promoted\s+link|adchoices)/i;

  function normalizedText(element) {
    return String(element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function domainTokens(element) {
    const text = normalizedText(element);
    const values = text.match(DOMAIN_RE) || [];
    const unique = new Set();
    for (const raw of values) {
      const value = raw.toLowerCase().replace(/^www\./, "");
      if (!value || /(?:^|\.)namu\.wiki$/.test(value) || /(?:^|\.)youtube\.com$/.test(value)) continue;
      unique.add(value);
    }
    return unique.size;
  }

  function documentHeight() {
    return Math.max(
      document.documentElement?.scrollHeight || 0,
      document.body?.scrollHeight || 0,
      window.innerHeight || 0,
    );
  }

  function looksLikeInjectedAd(element) {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const pageY = rect.top + (window.scrollY || window.pageYOffset || 0);
    const totalHeight = documentHeight();
    if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return false;
    if (rect.width < 260 || rect.height < 35 || rect.height > 520) return false;

    const bottomZone = pageY > totalHeight * 0.68;
    if (!bottomZone) return false;

    const text = normalizedText(element);
    if (!text || text.length > 9000) return false;

    const explicit = EXPLICIT_AD_RE.test(text) || EXPLICIT_AD_RE.test(String(element.getAttribute("aria-label") || ""));
    const domains = domainTokens(element);
    const anchors = element.querySelectorAll("a").length;
    const tables = element.querySelectorAll("table").length;
    const headings = element.querySelectorAll("h1,h2,h3,h4,h5,h6").length;

    if (explicit && anchors >= 2) return true;
    return domains >= 2 && anchors >= 6 && tables >= 2 && headings === 0;
  }

  function markAncestors(element) {
    let current = element?.parentElement || null;
    for (let depth = 0; current && depth < 24; depth += 1, current = current.parentElement) {
      current.setAttribute("data-kpop-ad-filtered", "true");
      current.setAttribute("data-kpop-ad-filter-version", FILTER_VERSION);
      if (current === document.body) break;
    }
  }

  function removeInjectedAds() {
    const candidates = [];
    const selector = "div,section,aside,table";
    for (const element of document.querySelectorAll(selector)) {
      if (!looksLikeInjectedAd(element)) continue;
      const rect = element.getBoundingClientRect();
      candidates.push({ element, area: Math.max(0, rect.width) * Math.max(0, rect.height) });
    }

    candidates.sort((a, b) => b.area - a.area);
    const removed = [];
    for (const entry of candidates) {
      if (!entry.element.isConnected) continue;
      if (removed.some((node) => node.contains(entry.element))) continue;
      markAncestors(entry.element);
      removed.push(entry.element);
      entry.element.remove();
    }

    if (removed.length) {
      document.documentElement.setAttribute("data-kpop-ad-filter-ran", FILTER_VERSION);
      console.debug(`[Kpoparkive] removed ${removed.length} injected ad block(s) before capture.`);
    }
    return removed.length;
  }

  removeInjectedAds();
  setTimeout(removeInjectedAds, 700);
  setTimeout(removeInjectedAds, 1800);
})();
