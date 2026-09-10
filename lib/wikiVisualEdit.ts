export type VisualEditToolbarCommand =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "strike"
  | "bulletList"
  | "link"
  | "citation";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value: string) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function findBalancedBracket(value: string, start: number) {
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function renderInline(value: string): string {
  let html = "";
  let index = 0;

  while (index < value.length) {
    if (value.startsWith("[br]", index)) {
      html += "<br>";
      index += 4;
      continue;
    }

    if (value.startsWith("[*", index)) {
      const end = findBalancedBracket(value, index);
      if (end > index) {
        const raw = value.slice(index, end + 1);
        const body = value.slice(index + 2, end).trim();
        html += `<span class="kpoparkiveVisualCitation" contenteditable="false" data-wiki-footnote="${escapeAttr(raw)}" title="${escapeAttr(body || "citation")}">[citation]</span>`;
        index = end + 1;
        continue;
      }
    }

    if (value.startsWith("[[", index)) {
      const end = value.indexOf("]]", index + 2);
      if (end > index) {
        const inside = value.slice(index + 2, end);
        const pipe = inside.indexOf("|");
        const target = (pipe >= 0 ? inside.slice(0, pipe) : inside).trim();
        const label = (pipe >= 0 ? inside.slice(pipe + 1) : target).trim();
        if (target && !/^(?:파일|File):/i.test(target)) {
          html += `<a href="/w/${encodeURIComponent(target)}" data-wiki-target="${escapeAttr(target)}">${renderInline(label)}</a>`;
          index = end + 2;
          continue;
        }
      }
    }

    if (value[index] === "[" && /^https?:\/\//i.test(value.slice(index + 1))) {
      const end = value.indexOf("]", index + 1);
      if (end > index) {
        const inside = value.slice(index + 1, end).trim();
        const space = inside.search(/\s/);
        const href = space >= 0 ? inside.slice(0, space) : inside;
        const label = space >= 0 ? inside.slice(space).trim() : href;
        html += `<a href="${escapeAttr(href)}" data-wiki-external="1">${renderInline(label)}</a>`;
        index = end + 1;
        continue;
      }
    }

    const markPairs: Array<[string, string, string]> = [
      ["'''", "<strong>", "</strong>"],
      ["''", "<em>", "</em>"],
      ["~~", "<s>", "</s>"],
      ["^^", "<sup>", "</sup>"],
    ];

    let matched = false;
    for (const [token, open, close] of markPairs) {
      if (!value.startsWith(token, index)) continue;
      const end = value.indexOf(token, index + token.length);
      if (end <= index) continue;
      html += `${open}${renderInline(value.slice(index + token.length, end))}${close}`;
      index = end + token.length;
      matched = true;
      break;
    }
    if (matched) continue;

    html += escapeHtml(value[index]);
    index += 1;
  }

  return html;
}

export function wikiBlockToEditorHtml(wikitext: string) {
  const lines = wikitext.replace(/\r\n?/g, "\n").split("\n");
  const chunks: string[] = [];
  let listItems: Array<{ prefix: string; body: string }> = [];

  const flushList = () => {
    if (!listItems.length) return;
    chunks.push(
      `<ul>${listItems
        .map(({ prefix, body }) => `<li data-wiki-list-prefix="${escapeAttr(prefix)}">${renderInline(body)}</li>`)
        .join("")}</ul>`,
    );
    listItems = [];
  };

  for (const line of lines) {
    const listMatch = line.match(/^(\s*\*)\s?(.*)$/);
    if (listMatch) {
      listItems.push({ prefix: listMatch[1], body: listMatch[2] });
      continue;
    }
    flushList();
    if (!line.trim()) chunks.push("<p><br></p>");
    else chunks.push(`<p>${renderInline(line)}</p>`);
  }
  flushList();

  return chunks.join("") || "<p><br></p>";
}

function normalizeTextNode(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
}

function inlineNodeToWiki(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeTextNode(node.textContent || "");
  if (!(node instanceof HTMLElement)) return "";

  if (node.matches("span[data-wiki-footnote]")) return node.dataset.wikiFootnote || "";
  if (node.tagName === "BR") return "[br]";

  const children = Array.from(node.childNodes).map(inlineNodeToWiki).join("");

  if (node.tagName === "STRONG" || node.tagName === "B") return `'''${children}'''`;
  if (node.tagName === "EM" || node.tagName === "I") return `''${children}''`;
  if (node.tagName === "S" || node.tagName === "DEL" || node.tagName === "STRIKE") return `~~${children}~~`;
  if (node.tagName === "SUP") return `^^${children}^^`;

  if (node.tagName === "A") {
    const internalTarget = node.dataset.wikiTarget;
    if (internalTarget) {
      const label = children.trim();
      return label === internalTarget ? `[[${internalTarget}]]` : `[[${internalTarget}|${children}]]`;
    }
    const href = node.getAttribute("href") || "";
    if (/^https?:\/\//i.test(href)) return `[${href}${children.trim() ? ` ${children}` : ""}]`;
  }

  return children;
}

export function editorElementToWikitext(root: HTMLElement) {
  const lines: string[] = [];

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeTextNode(node.textContent || "").trim();
      if (text) lines.push(text);
      continue;
    }
    if (!(node instanceof HTMLElement)) continue;

    if (node.tagName === "UL" || node.tagName === "OL") {
      for (const child of Array.from(node.children)) {
        if (!(child instanceof HTMLElement) || child.tagName !== "LI") continue;
        const body = Array.from(child.childNodes).map(inlineNodeToWiki).join("").trim();
        const prefix = child.dataset.wikiListPrefix || "*";
        if (body) lines.push(`${prefix} ${body}`);
      }
      continue;
    }

    if (node.tagName === "P" || node.tagName === "DIV" || node.tagName === "BLOCKQUOTE") {
      const body = Array.from(node.childNodes).map(inlineNodeToWiki).join("");
      lines.push(body === "[br]" ? "" : body);
      continue;
    }

    const body = inlineNodeToWiki(node);
    if (body) lines.push(body);
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function visualEditorPlainText(root: HTMLElement) {
  return (root.innerText || root.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function applyVisualCommand(command: VisualEditToolbarCommand, activeEditor: HTMLElement | null) {
  if (!activeEditor) return false;
  activeEditor.focus();

  if (command === "undo") return document.execCommand("undo");
  if (command === "redo") return document.execCommand("redo");
  if (command === "bold") return document.execCommand("bold");
  if (command === "italic") return document.execCommand("italic");
  if (command === "strike") return document.execCommand("strikeThrough");
  if (command === "bulletList") return document.execCommand("insertUnorderedList");

  if (command === "link") {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const target = window.prompt("Link target (wiki page title or https:// URL)");
    if (!target?.trim()) return false;
    const value = target.trim();
    const href = /^https?:\/\//i.test(value) ? value : `/w/${encodeURIComponent(value)}`;
    const ok = document.execCommand("createLink", false, href);
    const anchor = selection.anchorNode instanceof Element
      ? selection.anchorNode.closest("a")
      : selection.anchorNode?.parentElement?.closest("a");
    if (anchor) {
      if (/^https?:\/\//i.test(value)) anchor.setAttribute("data-wiki-external", "1");
      else anchor.setAttribute("data-wiki-target", value);
    }
    return ok;
  }

  if (command === "citation") {
    const note = window.prompt("Citation / footnote text");
    if (!note?.trim()) return false;
    const raw = `[* ${note.trim()}]`;
    return document.execCommand(
      "insertHTML",
      false,
      `<span class="kpoparkiveVisualCitation" contenteditable="false" data-wiki-footnote="${escapeAttr(raw)}" title="${escapeAttr(note.trim())}">[citation]</span>`,
    );
  }

  return false;
}
