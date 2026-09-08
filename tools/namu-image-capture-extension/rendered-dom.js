function kpopDecodeMaybe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function kpopSourceTitleFromLocation() {
  const match = location.pathname.match(/^\/w\/(.+)$/);
  if (!match) return document.title.replace(/\s*-\s*나무위키\s*$/i, "").trim();
  return kpopDecodeMaybe(match[1]);
}

function kpopScorePresentationRoot(element) {
  if (!(element instanceof Element)) return -1;
  const textLength = (element.textContent || "").replace(/\s+/g, " ").trim().length;
  const tables = element.querySelectorAll("table").length;
  const images = element.querySelectorAll("img").length;
  const headings = element.querySelectorAll("h1,h2,h3,h4,h5,h6").length;
  return textLength + tables * 900 + images * 180 + headings * 300;
}

function kpopFindPresentationRoot() {
  const articles = Array.from(document.querySelectorAll("article"));
  if (articles.length) {
    articles.sort((a, b) => kpopScorePresentationRoot(b) - kpopScorePresentationRoot(a));
    return { element: articles[0], selector: "article:max-score" };
  }

  for (const selector of ["main", "[role='main']"]) {
    const candidates = Array.from(document.querySelectorAll(selector));
    if (!candidates.length) continue;
    candidates.sort((a, b) => kpopScorePresentationRoot(b) - kpopScorePresentationRoot(a));
    if (kpopScorePresentationRoot(candidates[0]) > 1000) return { element: candidates[0], selector: `${selector}:max-score` };
  }
  return null;
}

function kpopAbsoluteUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:data|blob|javascript):/i.test(raw)) return "";
  try {
    const url = new URL(raw, location.href);
    return /^https?:$/i.test(url.protocol) ? url.toString() : "";
  } catch {
    return "";
  }
}

function kpopSanitizeRenderedClone(sourceRoot) {
  const clone = sourceRoot.cloneNode(true);
  const originals = [sourceRoot, ...sourceRoot.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];

  for (let index = 0; index < Math.min(originals.length, copies.length); index += 1) {
    const original = originals[index];
    const copy = copies[index];
    if (!(original instanceof Element) || !(copy instanceof Element)) continue;

    for (const attr of Array.from(copy.attributes || [])) {
      if (/^on/i.test(attr.name) || ["nonce", "integrity"].includes(attr.name.toLowerCase())) copy.removeAttribute(attr.name);
    }

    if (original instanceof HTMLImageElement && copy instanceof HTMLImageElement) {
      const current = kpopAbsoluteUrl(original.currentSrc || original.getAttribute("src") || original.getAttribute("data-src") || original.getAttribute("data-original"));
      if (current) {
        copy.setAttribute("src", current);
        copy.setAttribute("data-original", current);
      }
      copy.removeAttribute("srcset");
      copy.removeAttribute("sizes");
      copy.removeAttribute("loading");
      copy.setAttribute("data-kpop-rendered-natural-width", String(original.naturalWidth || 0));
      copy.setAttribute("data-kpop-rendered-natural-height", String(original.naturalHeight || 0));
    }

    if (original instanceof HTMLIFrameElement && copy instanceof HTMLIFrameElement) {
      const current = kpopAbsoluteUrl(original.getAttribute("src"));
      if (current) copy.setAttribute("src", current);
    }

    if (original instanceof HTMLAnchorElement && copy instanceof HTMLAnchorElement) {
      const href = original.getAttribute("href") || "";
      if (href) copy.setAttribute("href", href);
    }
  }

  for (const unwanted of clone.querySelectorAll("script,noscript,style,link,meta")) unwanted.remove();
  return clone;
}

function kpopExtractRenderedDocument() {
  const found = kpopFindPresentationRoot();
  if (!found) throw new Error("Could not locate the rendered NamuWiki article/main content root.");

  const source = found.element;
  const clone = kpopSanitizeRenderedClone(source);
  const html = clone.outerHTML;
  const rect = source.getBoundingClientRect();

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    sourceTitle: kpopSourceTitleFromLocation(),
    articleHtml: html,
    captureVersion: "chrome-rendered-dom-v1",
    meta: {
      selector: found.selector,
      tagName: source.tagName.toLowerCase(),
      articleBytes: new TextEncoder().encode(html).byteLength,
      nodeCount: source.querySelectorAll("*").length,
      imageCount: source.querySelectorAll("img").length,
      tableCount: source.querySelectorAll("table").length,
      headingCount: source.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
      renderedWidth: Math.round(rect.width || 0),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
      userAgent: navigator.userAgent,
    },
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-rendered-document") return;
  try {
    sendResponse({ ok: true, ...kpopExtractRenderedDocument() });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
