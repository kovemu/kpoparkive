export type VisualEditToolbarCommand =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "underline"
  | "strike"
  | "bulletList"
  | "orderedList"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignJustify"
  | "link"
  | "citation";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function escapeAttr(value: string) { return escapeHtml(value).replace(/'/g, "&#39;"); }

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
    if (value.startsWith("[br]", index)) { html += "<br>"; index += 4; continue; }

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

    if (value.startsWith("{{{#", index)) {
      const end = value.indexOf("}}}", index + 4);
      if (end > index) {
        const inside = value.slice(index + 3, end);
        const split = inside.search(/\s/);
        if (split > 1) {
          const color = inside.slice(0, split).split(",")[0].trim();
          const body = inside.slice(split).trimStart();
          if (/^#[0-9a-f]{3,8}$/i.test(color)) {
            html += `<span style="color:${escapeAttr(color)}" data-wiki-color="${escapeAttr(color)}">${renderInline(body)}</span>`;
            index = end + 3;
            continue;
          }
        }
      }
    }

    const markPairs: Array<[string, string, string]> = [
      ["'''", "<strong>", "</strong>"],
      ["''", "<em>", "</em>"],
      ["__", "<u>", "</u>"],
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

function simpleAlignedBlock(wikitext: string) {
  const match = wikitext.match(/^\{\{\{#!wiki\s+style=["']text-align:\s*(left|center|right|justify);?["']\s*\n([\s\S]*?)\n\}\}\}$/i);
  return match ? { align: match[1].toLowerCase(), body: match[2] } : null;
}

export function wikiBlockToEditorHtml(wikitext: string) {
  const aligned = simpleAlignedBlock(wikitext.trim());
  const source = aligned?.body ?? wikitext;
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const chunks: string[] = [];
  let listItems: Array<{ prefix: string; body: string; ordered: boolean }> = [];

  const flushList = () => {
    if (!listItems.length) return;
    const ordered = listItems[0].ordered;
    const tag = ordered ? "ol" : "ul";
    chunks.push(`<${tag}>${listItems.map(({ prefix, body }) => `<li data-wiki-list-prefix="${escapeAttr(prefix)}">${renderInline(body)}</li>`).join("")}</${tag}>`);
    listItems = [];
  };

  for (const line of lines) {
    const bullet = line.match(/^(\s*\*)\s?(.*)$/);
    const ordered = line.match(/^(\s*1\.)\s?(.*)$/);
    if (bullet || ordered) {
      const match = bullet || ordered;
      listItems.push({ prefix: match![1], body: match![2], ordered: Boolean(ordered) });
      continue;
    }
    flushList();
    if (!line.trim()) chunks.push("<p><br></p>");
    else chunks.push(`<p${aligned ? ` style="text-align:${aligned.align}" data-wiki-align="${aligned.align}"` : ""}>${renderInline(line)}</p>`);
  }
  flushList();
  return chunks.join("") || "<p><br></p>";
}

function normalizeTextNode(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/[\u200b-\u200d\u2060\ufeff]/g, "");
}

function cssColorToHex(value: string) {
  const text = value.trim();
  if (/^#[0-9a-f]{3,8}$/i.test(text)) return text;
  const rgb = text.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgb) return text;
  const hex = [rgb[1], rgb[2], rgb[3]].map((part) => Math.max(0, Math.min(255, Number(part))).toString(16).padStart(2, "0")).join("");
  return `#${hex}`;
}

function inlineNodeToWiki(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return normalizeTextNode(node.textContent || "");
  if (!(node instanceof HTMLElement)) return "";
  if (node.matches("span[data-wiki-footnote]")) return node.dataset.wikiFootnote || "";
  if (node.tagName === "BR") return "[br]";

  const children = Array.from(node.childNodes).map(inlineNodeToWiki).join("");
  let wrapped = children;
  if (node.tagName === "STRONG" || node.tagName === "B") wrapped = `'''${children}'''`;
  else if (node.tagName === "EM" || node.tagName === "I") wrapped = `''${children}''`;
  else if (node.tagName === "U") wrapped = `__${children}__`;
  else if (node.tagName === "S" || node.tagName === "DEL" || node.tagName === "STRIKE") wrapped = `~~${children}~~`;
  else if (node.tagName === "SUP") wrapped = `^^${children}^^`;
  else if (node.tagName === "A") {
    const internalTarget = node.dataset.wikiTarget;
    if (internalTarget) {
      const label = children.trim();
      wrapped = label === internalTarget ? `[[${internalTarget}]]` : `[[${internalTarget}|${children}]]`;
    } else {
      const href = node.getAttribute("href") || "";
      if (/^https?:\/\//i.test(href)) wrapped = `[${href}${children.trim() ? ` ${children}` : ""}]`;
    }
  }

  const explicitColor = node.dataset.wikiColor || (node.tagName === "FONT" ? node.getAttribute("color") || "" : "") || node.style?.color || "";
  if (explicitColor && wrapped && !node.matches("span[data-wiki-footnote]")) {
    const color = cssColorToHex(explicitColor);
    if (/^#[0-9a-f]{3,8}$/i.test(color)) wrapped = `{{{${color} ${wrapped}}}}`;
  }
  return wrapped;
}

export function editorElementToWikitext(root: HTMLElement) {
  const lines: string[] = [];
  let alignment: string | null = null;
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
        const prefix = child.dataset.wikiListPrefix || (node.tagName === "OL" ? "1." : "*");
        if (body) lines.push(`${prefix} ${body}`);
      }
      continue;
    }
    if (node.tagName === "P" || node.tagName === "DIV" || node.tagName === "BLOCKQUOTE") {
      const body = Array.from(node.childNodes).map(inlineNodeToWiki).join("");
      lines.push(body === "[br]" ? "" : body);
      const align = node.dataset.wikiAlign || node.style.textAlign || "";
      if (align && align !== "left") alignment = align;
      continue;
    }
    const body = inlineNodeToWiki(node);
    if (body) lines.push(body);
  }
  const body = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (alignment && /^(center|right|justify)$/i.test(alignment)) {
    return `{{{#!wiki style="text-align: ${alignment.toLowerCase()}"\n${body}\n}}}`;
  }
  return body;
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
  if (command === "underline") return document.execCommand("underline");
  if (command === "strike") return document.execCommand("strikeThrough");
  if (command === "bulletList") return document.execCommand("insertUnorderedList");
  if (command === "orderedList") return document.execCommand("insertOrderedList");
  if (command === "alignLeft") return document.execCommand("justifyLeft");
  if (command === "alignCenter") return document.execCommand("justifyCenter");
  if (command === "alignRight") return document.execCommand("justifyRight");
  if (command === "alignJustify") return document.execCommand("justifyFull");

  if (command === "link") {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return false;
    const target = window.prompt("Link target (wiki page title or https:// URL)");
    if (!target?.trim()) return false;
    const value = target.trim();
    const href = /^https?:\/\//i.test(value) ? value : `/w/${encodeURIComponent(value)}`;
    const ok = document.execCommand("createLink", false, href);
    const anchor = selection.anchorNode instanceof Element ? selection.anchorNode.closest("a") : selection.anchorNode?.parentElement?.closest("a");
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
    return document.execCommand("insertHTML", false, `<span class="kpoparkiveVisualCitation" contenteditable="false" data-wiki-footnote="${escapeAttr(raw)}" title="${escapeAttr(note.trim())}">[citation]</span>`);
  }
  return false;
}

export function applyVisualTextColor(activeEditor: HTMLElement | null, color: string) {
  if (!activeEditor || !/^#[0-9a-f]{6}$/i.test(color)) return false;
  activeEditor.focus();
  return document.execCommand("foreColor", false, color);
}
