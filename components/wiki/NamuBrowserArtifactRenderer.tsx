import { parse } from "node-html-parser";

export type BrowserArtifactAssetMap = Record<string, string>;

const FLOW_HEIGHT_TAGS = new Set([
  "div", "section", "article", "main", "header", "footer", "nav", "aside",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
  "details", "summary", "p", "blockquote", "pre", "ul", "ol", "li", "dl", "dt", "dd",
  "h1", "h2", "h3", "h4", "h5", "h6",
]);

function safeStyle(value: string | undefined) {
  if (!value) return "";
  const output: string[] = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    let rawValue = declaration.slice(colon + 1).trim();
    if (!/^-?[a-z][a-z0-9-]*$/i.test(property)) continue;
    if (!rawValue || /[<>]/.test(rawValue)) continue;
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(rawValue)) continue;
    if (property === "behavior" || property === "-moz-binding") continue;

    if (["overflow", "overflow-x", "overflow-y"].includes(property) && /^(?:auto|scroll)$/i.test(rawValue)) {
      rawValue = "visible";
    }

    output.push(`${property}:${rawValue}`);
  }
  return output.join(";");
}

function stripFlowHeights(value: string | undefined) {
  if (!value) return "";
  const blocked = new Set(["height", "min-height", "max-height"]);
  return value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((declaration) => {
      const colon = declaration.indexOf(":");
      if (colon < 1) return false;
      return !blocked.has(declaration.slice(0, colon).trim().toLowerCase());
    })
    .join(";");
}

function styleProperty(value: string | undefined, property: string) {
  if (!value) return "";
  const lower = property.toLowerCase();
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() === lower) return declaration.slice(colon + 1).trim();
  }
  return "";
}

function thawNormalFlowHeight(tag: string, style: string) {
  if (!FLOW_HEIGHT_TAGS.has(tag)) return style;
  const position = styleProperty(style, "position").toLowerCase();
  if (position === "absolute" || position === "fixed") return style;
  return stripFlowHeights(style);
}

function safeHref(value: string | undefined) {
  const href = String(value || "").trim();
  if (!href || /^javascript:/i.test(href) || /^data:/i.test(href)) return "";
  if (href.startsWith("#")) return href;

  const convert = (pathname: string, hash = "") => {
    const encoded = pathname.replace(/^\/w\//, "");
    let title = encoded;
    try { title = decodeURIComponent(encoded); } catch {}
    const base = `/admin/namu-browser-preview/${encodeURIComponent(title)}`;
    return hash ? `${base}#${hash}` : base;
  };

  if (href.startsWith("/w/")) {
    const [pathname, hash = ""] = href.split("#", 2);
    return convert(pathname, hash);
  }

  try {
    const url = new URL(href, "https://namu.wiki");
    if (/(^|\.)namu\.wiki$/i.test(url.hostname) && url.pathname.startsWith("/w/")) {
      return convert(url.pathname, url.hash.replace(/^#/, ""));
    }
    if (/^https?:$/i.test(url.protocol)) return url.toString();
  } catch {}
  return "";
}

function normalizeUrlKey(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try { return new URL(raw, "https://namu.wiki").toString(); }
  catch { return raw; }
}

function assetUrl(value: string, assets: BrowserArtifactAssetMap) {
  if (!value) return "";
  const exact = assets[value];
  if (exact) return exact;
  const normalized = normalizeUrlKey(value);
  return assets[normalized] || normalized || value;
}

function sanitizePseudoCss(source: string | null | undefined) {
  if (!source) return "";
  const output: string[] = [];
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(source))) {
    const selector = match[1].trim();
    if (!/^\[data-kpop-node-id="k\d+"\]::(?:before|after)$/i.test(selector)) continue;
    const declarations = safeStyle(match[2]);
    if (!declarations) continue;
    output.push(`[data-kpop-browser-artifact] ${selector}{${declarations}}`);
  }
  return output.join("\n");
}

function thawElementHeight(element: any) {
  const cleaned = stripFlowHeights(element.getAttribute?.("style") || undefined);
  if (cleaned) element.setAttribute?.("style", cleaned);
  else element.removeAttribute?.("style");
}

function sanitizeArtifactHtml(html: string, assets: BrowserArtifactAssetMap) {
  const root = parse(html, { comment: false, lowerCaseTagName: false });
  for (const node of root.querySelectorAll("script,noscript,style,link,meta,base")) node.remove();

  for (const element of root.querySelectorAll("*")) {
    for (const attr of Object.keys(element.attributes || {})) {
      const lower = attr.toLowerCase();
      if (/^on/i.test(lower) || ["nonce", "integrity", "srcdoc"].includes(lower)) element.removeAttribute(attr);
    }

    const tag = element.tagName.toLowerCase();
    let style = safeStyle(element.getAttribute("style") || undefined);
    style = thawNormalFlowHeight(tag, style);
    if (style) element.setAttribute("style", style);
    else element.removeAttribute("style");

    if (tag === "a") {
      const href = safeHref(element.getAttribute("href") || undefined);
      if (href) element.setAttribute("href", href);
      else element.removeAttribute("href");
      if (/^https?:\/\//i.test(href)) {
        element.setAttribute("rel", "noreferrer noopener");
        element.setAttribute("target", "_blank");
      }
    }

    if (tag === "img") {
      const src = element.getAttribute("src") || element.getAttribute("data-kpop-source-url") || element.getAttribute("data-original") || "";
      const resolved = assetUrl(src, assets);
      if (resolved) {
        element.setAttribute("src", resolved);
        element.setAttribute("data-original", resolved);
      }
      element.removeAttribute("srcset");
      element.removeAttribute("sizes");
      element.removeAttribute("loading");
    }

    if (tag === "video") {
      const src = element.getAttribute("src") || element.getAttribute("data-kpop-source-url") || element.getAttribute("data-original") || "";
      const resolved = assetUrl(src, assets);
      if (resolved) element.setAttribute("src", resolved);

      const poster = element.getAttribute("poster") || "";
      if (poster) element.setAttribute("poster", assetUrl(poster, assets));

      element.setAttribute("autoplay", "");
      element.setAttribute("muted", "");
      element.setAttribute("playsinline", "");
      element.setAttribute("loop", "");
      element.setAttribute("preload", "metadata");
      element.removeAttribute("loading");
    }

    if (tag === "iframe") {
      const src = String(element.getAttribute("src") || "").trim();
      let allowed = false;
      try {
        const url = new URL(src);
        const host = url.hostname.toLowerCase();
        allowed = ["youtube.com", "www.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"].includes(host);
      } catch {}
      if (!allowed) element.remove();
    }

    if (tag === "form") {
      element.removeAttribute("action");
      element.removeAttribute("method");
    }
  }

  for (const details of root.querySelectorAll("details")) {
    for (const child of details.querySelectorAll("*")) {
      const tag = String(child.tagName || "").toLowerCase();
      if (!["img", "video", "iframe", "canvas", "svg"].includes(tag)) thawElementHeight(child);
    }

    let current: any = details;
    let depth = 0;
    while (current && depth < 80) {
      thawElementHeight(current);
      if (current.getAttribute?.("data-kpop-capture-root") === "true") break;
      current = current.parentNode;
      depth += 1;
    }
  }

  return root.toString();
}

export default function NamuBrowserArtifactRenderer({
  html,
  styleCss,
  assets,
  capturedWidth,
}: {
  html: string;
  styleCss?: string | null;
  assets: BrowserArtifactAssetMap;
  capturedWidth?: number | null;
}) {
  const safeHtml = sanitizeArtifactHtml(html, assets);
  const pseudoCss = sanitizePseudoCss(styleCss);
  const width = Number.isFinite(Number(capturedWidth)) && Number(capturedWidth) > 0 ? Number(capturedWidth) : undefined;

  return (
    <div
      data-kpop-browser-artifact
      style={{
        width: width ? `${width}px` : "100%",
        maxWidth: "none",
        margin: "0 auto",
        overflow: "visible",
        background: "white",
      }}
    >
      {pseudoCss ? <style dangerouslySetInnerHTML={{ __html: pseudoCss }} /> : null}
      <style dangerouslySetInnerHTML={{ __html: `
        [data-kpop-browser-artifact] details,
        [data-kpop-browser-artifact] details > :not(summary),
        [data-kpop-browser-artifact] *:has(> details),
        [data-kpop-browser-artifact] *:has(details[open]) {
          height:auto !important;
          min-height:0 !important;
          max-height:none !important;
          overflow:visible !important;
          overflow-x:visible !important;
          overflow-y:visible !important;
        }
        [data-kpop-browser-artifact] [data-kpop-capture-root="true"]:has(details[open]) {
          height:auto !important;
          max-height:none !important;
          overflow:visible !important;
        }
        [data-kpop-browser-artifact] summary { cursor:pointer !important; }
        [data-kpop-browser-artifact] video { max-width:100%; }
      ` }} />
      <div dangerouslySetInnerHTML={{ __html: safeHtml }} />
    </div>
  );
}
