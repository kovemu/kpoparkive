import { parse } from "node-html-parser";

function rewriteHref(href: string, title: string) {
  if (/^\/edit\//i.test(href)) {
    return `/edit/${title.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
  }
  if (/^https:\/\/namu\.wiki\/w\//i.test(href)) return href.replace(/^https:\/\/namu\.wiki/i, "");
  return href;
}

/**
 * Final safety pass for HTML emitted by the pinned The Tree renderer.
 * It intentionally does not redesign or re-render markup: only executable
 * attributes/scripts are removed and internal edit links are localized.
 */
export function sanitizeExactPreviewHtml(html: string, title: string) {
  const root = parse(`<div id="kpop-preview-root">${html}</div>`);

  for (const script of root.querySelectorAll("script")) script.remove();

  for (const node of root.querySelectorAll("*")) {
    for (const name of Object.keys(node.attributes)) {
      if (/^on/i.test(name)) node.removeAttribute(name);
    }

    const href = node.getAttribute("href") || "";
    if (/^javascript:/i.test(href)) node.removeAttribute("href");
    else if (href) node.setAttribute("href", rewriteHref(href, title));
  }

  return root.querySelector("#kpop-preview-root")?.innerHTML || "";
}
