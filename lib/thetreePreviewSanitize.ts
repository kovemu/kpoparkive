import { parse } from "node-html-parser";
import { stripNamuOperationalHtml } from "./namuOperationalNotices";

function rewriteHref(href: string, title: string) {
  if (/^\/edit\//i.test(href)) {
    return `/edit/${title.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  }
  if (/^https:\/\/namu\.wiki\/w\//i.test(href)) return href.replace(/^https:\/\/namu\.wiki/i, "");
  return href;
}

function normalizeTooltipText(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function localizeLinkTooltips(root: any) {
  for (const anchor of root.querySelectorAll("a[href]")) {
    const visible = normalizeTooltipText(anchor.text || anchor.innerText || "");
    const aria = normalizeTooltipText(anchor.getAttribute("aria-label") || "");
    const tooltip =
      visible && !/[가-힣]/.test(visible)
        ? visible
        : aria && !/[가-힣]/.test(aria)
          ? aria
          : "";

    if (tooltip) {
      anchor.setAttribute("title", tooltip);
      anchor.setAttribute("aria-label", tooltip);
    } else if (/[가-힣]/.test(anchor.getAttribute("title") || "")) {
      anchor.removeAttribute("title");
    }
  }
}

/**
 * Final safety pass for HTML emitted by the pinned The Tree renderer.
 * It intentionally does not redesign or re-render markup: only executable
 * attributes/scripts are removed and internal edit links are localized.
 */
export function sanitizeExactPreviewHtml(html: string, title: string) {
  const root = parse(`<div id="kpop-preview-root">${html}</div>`);

  for (const script of root.querySelectorAll("script")) script.remove();
  stripNamuOperationalHtml(root);

  for (const node of root.querySelectorAll("*")) {
    for (const name of Object.keys(node.attributes)) {
      if (/^on/i.test(name)) node.removeAttribute(name);
    }

    const href = node.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) node.removeAttribute("href");
    else if (href) node.setAttribute("href", rewriteHref(href, title));
  }

  localizeLinkTooltips(root);

  return root.querySelector("#kpop-preview-root")?.innerHTML || "";
}
