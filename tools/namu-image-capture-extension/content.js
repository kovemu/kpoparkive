function decodeMaybe(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalizeFileName(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[?#].*$/, "")
    .replace(/\s+/g, " ");
}

function looksLikeFileName(value) {
  return /\.(?:jpe?g|png|gif|webp|avif|svg)(?:$|[?#])/i.test(String(value || "").trim());
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sourceTitleFromLocation() {
  const match = location.pathname.match(/^\/w\/(.+)$/);
  if (!match) return document.title.replace(/\s*-\s*나무위키\s*$/i, "").trim();
  return decodeMaybe(match[1]);
}

function kpopNamuChallengeVisible() {
  const isVisible = (element) => {
    if (!(element instanceof Element)) return false;
    try {
      const style = getComputedStyle(element);
      if (!style) return false;
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) return false;
      const rect = element.getBoundingClientRect();
      if (!rect || rect.width < 20 || rect.height < 20) return false;
      return true;
    } catch {
      return false;
    }
  };

  const selectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    '.cf-turnstile',
    '[data-sitekey][class*="turnstile" i]',
    '[id*="cf-chl" i]',
    '[class*="challenge-platform" i]',
    'form[action*="challenge" i]'
  ];

  for (const selector of selectors) {
    try {
      for (const element of document.querySelectorAll(selector)) {
        if (isVisible(element)) return true;
      }
    } catch {}
  }

  const title = String(document.title || "").trim();
  if (/just a moment|attention required|잠시만 기다려|보안 확인/i.test(title)) return true;

  const text = String(document.body?.innerText || "").replace(/\s+/g, " ").trim();
  if (text.length > 0 && text.length < 1200) {
    return /captcha|cf-chl|challenge-platform|비정상적인 접근|자동화된 접근|사람인지 확인/i.test(text);
  }

  return false;
}
function namuVerificationBlocked() {
  return kpopNamuChallengeVisible();
}

function semanticFileNameFromString(value, allowPlain = true) {
  const raw = decodeMaybe(String(value || "").normalize("NFKC"));
  const prefixed = raw.match(/(?:파일|File):([^?#"'<>\n]+?\.(?:jpe?g|png|gif|webp|avif|svg))(?:$|[?#&\s"'<>])/i);
  if (prefixed) return normalizeFileName(prefixed[1]);

  if (!allowPlain) return "";
  const trimmed = raw.trim();
  if (!trimmed || /^https?:\/\//i.test(trimmed) || /(?:^|\/)i\.namu\.wiki\/i\//i.test(trimmed)) return "";
  if (/[\\/]/.test(trimmed)) return "";
  if (looksLikeFileName(trimmed)) return normalizeFileName(trimmed);
  return "";
}

function semanticStringsForElement(element) {
  const values = [];
  let current = element;
  for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
    if (!(current instanceof Element)) continue;

    for (const name of ["alt", "title", "aria-label", "data-filename", "data-file-name", "data-file", "data-name"]) {
      const value = current.getAttribute?.(name);
      if (value) values.push({ value, allowPlain: true });
    }

    const href = current.getAttribute?.("href") || "";
    if (href && /(?:파일|File)(?::|%3A)/i.test(decodeMaybe(href))) {
      values.push({ value: href, allowPlain: false });
    }

    for (const attr of Array.from(current.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (["src", "srcset", "data-src", "data-original", "style"].includes(name)) continue;
      const value = attr.value || "";
      if (/(?:파일|File):/i.test(decodeMaybe(value))) values.push({ value, allowPlain: false });
    }

    if (depth <= 2) {
      const text = (current.textContent || "").replace(/\s+/g, " ").trim();
      if (text && text.length <= 240) values.push({ value: text, allowPlain: true });
    }
  }
  return values;
}

function urlsFromSrcset(srcset, baseUrl) {
  return String(srcset || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .map((value) => normalizeUrl(value, baseUrl))
    .filter(Boolean);
}

function normalizeUrl(value, baseUrl = location.href) {
  if (!value || /^(?:data|blob):/i.test(value)) return "";
  try {
    const url = new URL(value, baseUrl).toString();
    return /^https?:\/\//i.test(url) ? url : "";
  } catch {
    return "";
  }
}

function isNamuContentImageUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "i.namu.wiki" && url.pathname.startsWith("/i/");
  } catch {
    return false;
  }
}

function cssBackgroundUrls(element) {
  const values = [];
  try {
    const inline = element.getAttribute?.("style") || "";
    const computed = getComputedStyle(element).backgroundImage || "";
    for (const text of [inline, computed]) {
      for (const match of text.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
        const url = normalizeUrl(match[1]);
        if (url) values.push(url);
      }
    }
  } catch {}
  return unique(values);
}

function collectOpenRoots() {
  const roots = [document];
  const seen = new Set(roots);
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    for (const element of Array.from(root.querySelectorAll?.("*") || [])) {
      if (element.shadowRoot && !seen.has(element.shadowRoot)) {
        seen.add(element.shadowRoot);
        roots.push(element.shadowRoot);
      }
    }
  }
  return roots;
}

function fileNameForElement(element) {
  for (const entry of semanticStringsForElement(element)) {
    const fileName = semanticFileNameFromString(entry.value, entry.allowPlain);
    if (fileName) return fileName;
  }
  return "";
}

function urlsForImage(image) {
  const urls = [
    normalizeUrl(image.currentSrc || ""),
    normalizeUrl(image.getAttribute("src") || ""),
    normalizeUrl(image.getAttribute("data-src") || ""),
    normalizeUrl(image.getAttribute("data-original") || ""),
    ...urlsFromSrcset(image.getAttribute("srcset") || ""),
    ...cssBackgroundUrls(image),
  ];

  const picture = image.closest("picture");
  if (picture) {
    for (const source of picture.querySelectorAll("source")) {
      urls.push(normalizeUrl(source.getAttribute("src") || ""));
      urls.push(...urlsFromSrcset(source.getAttribute("srcset") || ""));
      urls.push(...urlsFromSrcset(source.getAttribute("data-srcset") || ""));
    }
  }
  return unique(urls);
}

function nearbyContext(element) {
  const parts = [];
  let current = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
    if (!(current instanceof Element)) continue;
    const text = (current.textContent || "").replace(/\s+/g, " ").trim();
    if (text && text.length <= 500) parts.push(text);
  }
  const heading = (() => {
    let node = element;
    for (let steps = 0; node && steps < 20; steps += 1) {
      let prev = node.previousElementSibling;
      while (prev) {
        const h = prev.matches?.("h1,h2,h3,h4,h5,h6") ? prev : prev.querySelector?.("h1,h2,h3,h4,h5,h6");
        if (h) return (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180);
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    return "";
  })();
  return { text: unique(parts).join(" | ").slice(0, 1200), heading };
}

function extractAssets() {
  const byFile = new Map();
  const anonymousByUrl = new Map();
  const roots = collectOpenRoots();
  let imageCount = 0;
  let pictureSourceCount = 0;
  let backgroundCount = 0;
  let fileLinkCount = 0;
  let domIndex = 0;
  const unlabeledSamples = [];

  const addAsset = (fileName, urls, width = 0, height = 0, meta = {}) => {
    const clean = normalizeFileName(fileName);
    if (!clean || !urls.length) return;
    const key = clean.toLowerCase();
    const existing = byFile.get(key) || { fileName: clean, urls: [], width: 0, height: 0, anonymous: false, domIndex: meta.domIndex ?? null, contextText: meta.contextText || "", heading: meta.heading || "", alt: meta.alt || "", title: meta.title || "" };
    existing.urls = unique([...existing.urls, ...urls]);
    existing.width = Math.max(existing.width, width || 0);
    existing.height = Math.max(existing.height, height || 0);
    if (existing.domIndex == null && meta.domIndex != null) existing.domIndex = meta.domIndex;
    byFile.set(key, existing);
  };

  const addAnonymous = (image, urls, index) => {
    const primary = urls.find(isNamuContentImageUrl);
    if (!primary) return;
    if (anonymousByUrl.has(primary)) return;
    const context = nearbyContext(image);
    anonymousByUrl.set(primary, {
      fileName: "",
      anonymous: true,
      domIndex: index,
      urls: [primary, ...urls.filter((url) => url !== primary)],
      width: image.naturalWidth || 0,
      height: image.naturalHeight || 0,
      contextText: context.text,
      heading: context.heading,
      alt: image.getAttribute("alt") || "",
      title: image.getAttribute("title") || "",
    });
  };

  for (const root of roots) {
    const images = Array.from(root.querySelectorAll?.("img") || []);
    imageCount += images.length;
    pictureSourceCount += root.querySelectorAll?.("picture source")?.length || 0;

    for (const image of images) {
      domIndex += 1;
      const urls = urlsForImage(image);
      if (!urls.length) continue;
      const context = nearbyContext(image);
      const fileName = fileNameForElement(image);
      if (fileName) {
        addAsset(fileName, urls, image.naturalWidth || 0, image.naturalHeight || 0, {
          domIndex,
          contextText: context.text,
          heading: context.heading,
          alt: image.getAttribute("alt") || "",
          title: image.getAttribute("title") || "",
        });
      } else {
        addAnonymous(image, urls, domIndex);
        if (unlabeledSamples.length < 12) {
          unlabeledSamples.push({ tag: "img", alt: image.getAttribute("alt") || "", title: image.getAttribute("title") || "", src: urls[0] || "", parent: image.parentElement?.tagName || "", domIndex });
        }
      }
    }

    for (const anchor of Array.from(root.querySelectorAll?.("a[href]") || [])) {
      const href = anchor.getAttribute("href") || "";
      const fileName = semanticFileNameFromString(href, false) || fileNameForElement(anchor);
      if (!fileName) continue;
      fileLinkCount += 1;
      const urls = [];
      for (const image of anchor.querySelectorAll("img")) urls.push(...urlsForImage(image));
      urls.push(...cssBackgroundUrls(anchor));
      addAsset(fileName, unique(urls));
    }

    for (const element of Array.from(root.querySelectorAll?.('[style*="background" i], [style*="url(" i]') || [])) {
      const urls = cssBackgroundUrls(element);
      if (!urls.length) continue;
      backgroundCount += 1;
      const fileName = fileNameForElement(element);
      if (fileName) addAsset(fileName, urls);
    }
  }

  const assets = [...byFile.values(), ...anonymousByUrl.values()]
    .sort((a, b) => (a.domIndex ?? Number.MAX_SAFE_INTEGER) - (b.domIndex ?? Number.MAX_SAFE_INTEGER));

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    sourceTitle: sourceTitleFromLocation(),
    blocked: namuVerificationBlocked(),
    assets,
    debug: {
      roots: roots.length,
      images: imageCount,
      pictureSources: pictureSourceCount,
      backgroundSurfaces: backgroundCount,
      fileLinks: fileLinkCount,
      labeledAssets: byFile.size,
      anonymousAssets: anonymousByUrl.size,
      unlabeledSamples,
    },
  };
}

function kpopNamuVerificationBlocked() {
  return kpopNamuChallengeVisible();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-detect-namu-verification") {
    sendResponse({ ok: true, blocked: kpopNamuVerificationBlocked() });
    return;
  }

  if (message?.type !== "kpoparkive-extract-namu-images") return;
  try {
    sendResponse({ ok: true, blocked: kpopNamuVerificationBlocked(), ...extractAssets() });
  } catch (error) {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
