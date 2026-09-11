import type { HTMLElement } from "node-html-parser";

/**
 * NamuWiki operational chrome belongs to the source site, not to the article
 * content. Kpoparkive has its own edit/access policy, so these source-site
 * notices must not be rendered into imported articles.
 */
export function stripNamuOperationalSource(source: string) {
  return String(source || "").replace(
    /^\s*\[include\(\s*틀\s*:\s*접근\s*제한(?:\s*,[^\]\r\n]*)?\)\]\s*$/gim,
    "",
  );
}

function isProtectionNotice(node: HTMLElement) {
  for (const link of node.querySelectorAll("a")) {
    const href = link.getAttribute("href") || "";
    const title = link.getAttribute("title") || "";
    const text = link.textContent || "";
    if (
      /Document_Protect\.svg/i.test(href) ||
      /Document_Protect\.svg/i.test(title) ||
      /Document_Protect\.svg/i.test(text)
    ) {
      return true;
    }
  }

  const text = (node.textContent || "").replace(/\s+/g, " ").trim();
  return /편집\s*보호된\s*문서입니다/.test(text) && /ACL/.test(text);
}

/**
 * Removes stale protection notices from HTML that may have been rendered and
 * stored before stripNamuOperationalSource was introduced.
 */
export function stripNamuOperationalHtml(root: HTMLElement) {
  for (const paragraph of root.querySelectorAll(".wiki-paragraph")) {
    if (isProtectionNotice(paragraph)) paragraph.remove();
  }
}
