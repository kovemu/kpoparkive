import { parse } from "node-html-parser";

export type BrowserArtifactAssetMap = Record<string, string>;

function safeStyle(value: string | undefined) {
  if (!value) return "";
  const output: string[] = [];
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const rawValue = declaration.slice(colon + 1).trim();
    if (!/^-?[a-z][a-z0-9-]*$/i.test(property)) continue;
    if (!rawValue || /[<>]/.test(rawValue)) continue;
    if (/url\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(rawValue)) continue;
    if (property === "behavior" || property === "-moz-binding") continue;
    output.push(`${property}:${rawValue}`);
  }
  return output.join(";");
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
  return assets[normalized] || value;
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

function sanitizeArtifactHtml(html: string, assets: BrowserArtifactAssetMap) {
  const root = parse(html, { comment: false, lowerCaseTagName: false });
  for (const node of root.querySelectorAll("script,noscript,style,link,meta,base")) node.remove();

  for (const element of root.querySelectorAll("*")) {
    for (const attr of Object.keys(element.attributes || {})) {
      const lower = attr.toLowerCase();
      if (/^on/i.test(lower) || ["nonce", "integrity", "srcdoc"].includes(lower)) element.removeAttribute(attr);
    }

    const style = safeStyle(element.getAttribute("style") || undefined);
    if (style) element.setAttribute("style", style);
    else element.removeAttribute("style");

    const tag = element.tagName.toLowerCase();
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
      <div dangerouslySetInnerHTML={{ __html: safeHtml }} />
    </div>
  );
}
