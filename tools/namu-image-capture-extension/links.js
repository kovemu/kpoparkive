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

function kpopExtractInternalLinks() {
  const currentTitle = (() => {
    const match = location.pathname.match(/^\/w\/(.+)$/);
    return match ? kpopDecodeLinkTitle(match[1]) : "";
  })();
  const byTitle = new Map();

  for (const anchor of document.querySelectorAll('a[href]')) {
    const raw = String(anchor.getAttribute("href") || "").trim();
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) continue;

    let url;
    try { url = new URL(raw, location.href); } catch { continue; }
    if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) continue;
    if (!url.pathname.startsWith("/w/")) continue;

    const encoded = url.pathname.slice(3);
    const title = kpopDecodeLinkTitle(encoded).normalize("NFKC").trim();
    if (!kpopShouldCloneTitle(title) || title === currentTitle) continue;

    const text = (anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!byTitle.has(title)) {
      byTitle.set(title, {
        title,
        href: `https://namu.wiki/w/${encodeURIComponent(title)}`,
        text,
      });
    }
    if (byTitle.size >= 2000) break;
  }

  return {
    sourceTitle: currentTitle,
    links: [...byTitle.values()],
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
