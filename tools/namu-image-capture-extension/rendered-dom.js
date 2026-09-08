const KPOP_CAPTURE_VERSION = "chrome-rendered-artifact-v2";

const KPOP_COMPUTED_STYLE_PROPERTIES = [
  "display", "box-sizing", "position", "top", "right", "bottom", "left", "float", "clear",
  "overflow", "overflow-x", "overflow-y", "visibility", "opacity", "z-index",
  "width", "min-width", "max-width", "height", "min-height", "max-height",
  "margin-top", "margin-right", "margin-bottom", "margin-left",
  "padding-top", "padding-right", "padding-bottom", "padding-left",
  "border-top-width", "border-right-width", "border-bottom-width", "border-left-width",
  "border-top-style", "border-right-style", "border-bottom-style", "border-left-style",
  "border-top-color", "border-right-color", "border-bottom-color", "border-left-color",
  "border-top-left-radius", "border-top-right-radius", "border-bottom-right-radius", "border-bottom-left-radius",
  "border-collapse", "border-spacing", "table-layout", "caption-side",
  "background-color", "background-image", "background-position", "background-size", "background-repeat",
  "color", "font-family", "font-size", "font-style", "font-weight", "line-height", "letter-spacing",
  "text-align", "text-indent", "text-transform", "text-decoration-line", "text-decoration-color", "text-decoration-style",
  "vertical-align", "white-space", "word-break", "overflow-wrap", "text-overflow",
  "list-style-type", "list-style-position",
  "flex", "flex-basis", "flex-direction", "flex-grow", "flex-shrink", "flex-wrap",
  "align-content", "align-items", "align-self", "justify-content", "justify-items", "justify-self",
  "gap", "row-gap", "column-gap",
  "grid-template-columns", "grid-template-rows", "grid-auto-flow", "grid-auto-columns", "grid-auto-rows",
  "grid-column-start", "grid-column-end", "grid-row-start", "grid-row-end",
  "object-fit", "object-position", "aspect-ratio",
  "transform", "transform-origin", "filter", "clip-path",
];

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

function kpopSafeComputedValue(property, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (/[<>]/.test(text) || /expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(text)) return "";
  if (/url\s*\(/i.test(text)) return "";
  if (property === "filter" && /url\s*\(/i.test(text)) return "";
  return text;
}

function kpopComputedStyleText(element, pseudo = null) {
  let computed;
  try { computed = getComputedStyle(element, pseudo); }
  catch { return ""; }

  const output = [];
  for (const property of KPOP_COMPUTED_STYLE_PROPERTIES) {
    const value = kpopSafeComputedValue(property, computed.getPropertyValue(property));
    if (value) output.push(`${property}:${value}`);
  }
  return output.join(";");
}

function kpopPseudoRule(nodeId, element, pseudo) {
  let computed;
  try { computed = getComputedStyle(element, pseudo); }
  catch { return ""; }

  const content = String(computed.getPropertyValue("content") || "").trim();
  if (!content || content === "none" || content === "normal" || /[<>]/.test(content) || /url\s*\(/i.test(content)) return "";
  const declarations = [`content:${content}`];
  for (const property of KPOP_COMPUTED_STYLE_PROPERTIES) {
    const value = kpopSafeComputedValue(property, computed.getPropertyValue(property));
    if (value) declarations.push(`${property}:${value}`);
  }
  return `[data-kpop-node-id="${nodeId}"]${pseudo}{${declarations.join(";")}}`;
}

function kpopSanitizeRenderedClone(sourceRoot) {
  const clone = sourceRoot.cloneNode(true);
  const originals = [sourceRoot, ...sourceRoot.querySelectorAll("*")];
  const copies = [clone, ...clone.querySelectorAll("*")];
  const rootRect = sourceRoot.getBoundingClientRect();
  const pseudoRules = [];
  let styledNodes = 0;
  let layoutNodes = 0;

  for (let index = 0; index < Math.min(originals.length, copies.length); index += 1) {
    const original = originals[index];
    const copy = copies[index];
    if (!(original instanceof Element) || !(copy instanceof Element)) continue;

    const nodeId = `k${index}`;
    copy.setAttribute("data-kpop-node-id", nodeId);

    for (const attr of Array.from(copy.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (/^on/i.test(name) || ["nonce", "integrity", "srcdoc"].includes(name)) copy.removeAttribute(attr.name);
    }

    const computedStyle = kpopComputedStyleText(original);
    if (computedStyle) {
      copy.setAttribute("style", computedStyle);
      styledNodes += 1;
    } else {
      copy.removeAttribute("style");
    }

    const rect = original.getBoundingClientRect();
    if (Number.isFinite(rect.width) && Number.isFinite(rect.height)) {
      copy.setAttribute("data-kpop-layout-x", String(Math.round((rect.left - rootRect.left) * 100) / 100));
      copy.setAttribute("data-kpop-layout-y", String(Math.round((rect.top - rootRect.top) * 100) / 100));
      copy.setAttribute("data-kpop-layout-width", String(Math.round(rect.width * 100) / 100));
      copy.setAttribute("data-kpop-layout-height", String(Math.round(rect.height * 100) / 100));
      layoutNodes += 1;
    }

    const before = kpopPseudoRule(nodeId, original, "::before");
    const after = kpopPseudoRule(nodeId, original, "::after");
    if (before) pseudoRules.push(before);
    if (after) pseudoRules.push(after);

    if (original instanceof HTMLImageElement && copy instanceof HTMLImageElement) {
      const current = kpopAbsoluteUrl(original.currentSrc || original.getAttribute("src") || original.getAttribute("data-src") || original.getAttribute("data-original"));
      if (current) {
        copy.setAttribute("src", current);
        copy.setAttribute("data-original", current);
        copy.setAttribute("data-kpop-source-url", current);
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
      if (/^javascript:/i.test(href)) copy.removeAttribute("href");
      else if (href) copy.setAttribute("href", href);
    }

    if (copy.tagName.toLowerCase() === "form") {
      copy.removeAttribute("action");
      copy.removeAttribute("method");
    }
  }

  for (const unwanted of clone.querySelectorAll("script,noscript,style,link,meta,base")) unwanted.remove();
  return { clone, pseudoCss: pseudoRules.join("\n"), styledNodes, layoutNodes, pseudoRuleCount: pseudoRules.length };
}

function kpopExtractRenderedDocument() {
  const found = kpopFindPresentationRoot();
  if (!found) throw new Error("Could not locate the rendered NamuWiki article/main content root.");

  const source = found.element;
  const snapshot = kpopSanitizeRenderedClone(source);
  const html = snapshot.clone.outerHTML;
  const styleCss = snapshot.pseudoCss;
  const rect = source.getBoundingClientRect();

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    sourceTitle: kpopSourceTitleFromLocation(),
    articleHtml: html,
    styleCss,
    captureVersion: KPOP_CAPTURE_VERSION,
    meta: {
      selector: found.selector,
      tagName: source.tagName.toLowerCase(),
      articleBytes: new TextEncoder().encode(html).byteLength,
      styleBytes: new TextEncoder().encode(styleCss).byteLength,
      nodeCount: source.querySelectorAll("*").length,
      styledNodes: snapshot.styledNodes,
      layoutNodes: snapshot.layoutNodes,
      pseudoRuleCount: snapshot.pseudoRuleCount,
      stylePropertyCount: KPOP_COMPUTED_STYLE_PROPERTIES.length,
      imageCount: source.querySelectorAll("img").length,
      tableCount: source.querySelectorAll("table").length,
      headingCount: source.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
      renderedWidth: Math.round(rect.width || 0),
      renderedHeight: Math.round(rect.height || 0),
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
