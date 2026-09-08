function decodeWikiTitleFromHref(href) {
  try {
    const url = new URL(href, location.href);
    const match = url.pathname.match(/^\/w\/(.+)$/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]); } catch { return match[1]; }
  } catch {
    return "";
  }
}

function normalizeFileName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/\s+/g, " ");
}

function looksLikeFileName(value) {
  return /\.(?:jpe?g|png|gif|webp|avif|svg)(?:\?.*)?$/i.test(String(value || "").trim());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceTitleFromLocation() {
  const match = location.pathname.match(/^\/w\/(.+)$/);
  if (!match) return document.title.replace(/\s*-\s*나무위키\s*$/i, "").trim();
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}

function fileNameForImage(image) {
  const anchor = image.closest("a");
  const hrefTitle = anchor ? decodeWikiTitleFromHref(anchor.getAttribute("href") || "") : "";
  if (/^(?:파일|File):/i.test(hrefTitle)) return normalizeFileName(hrefTitle);

  const labels = [
    image.getAttribute("alt") || "",
    image.getAttribute("title") || "",
    anchor?.getAttribute("title") || "",
  ];
  for (const label of labels) {
    if (/^(?:파일|File):/i.test(label)) return normalizeFileName(label);
  }
  for (const label of labels) {
    if (looksLikeFileName(label)) return normalizeFileName(label);
  }
  return "";
}

function urlsForImage(image) {
  const srcset = image.getAttribute("srcset") || "";
  const urls = [
    image.currentSrc || "",
    image.getAttribute("src") || "",
    image.getAttribute("data-src") || "",
    image.getAttribute("data-original") || "",
    ...srcset.split(",").map((part) => part.trim().split(/\s+/)[0]),
  ];
  return unique(urls.map((value) => {
    if (!value || /^(?:data|blob):/i.test(value)) return "";
    try { return new URL(value, location.href).toString(); } catch { return ""; }
  }).filter((value) => /^https:\/\//i.test(value)));
}

function extractAssets() {
  const byFile = new Map();
  for (const image of Array.from(document.images)) {
    const fileName = fileNameForImage(image);
    if (!fileName) continue;
    const urls = urlsForImage(image);
    if (!urls.length) continue;
    const key = normalizeFileName(fileName).toLowerCase();
    const existing = byFile.get(key) || {
      fileName,
      urls: [],
      width: 0,
      height: 0,
    };
    existing.urls = unique([...existing.urls, ...urls]);
    existing.width = Math.max(existing.width, image.naturalWidth || 0);
    existing.height = Math.max(existing.height, image.naturalHeight || 0);
    byFile.set(key, existing);
  }

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    sourceTitle: sourceTitleFromLocation(),
    assets: [...byFile.values()],
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-images") return;
  try {
    sendResponse({ ok: true, ...extractAssets() });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
