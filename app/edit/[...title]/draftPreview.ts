import { wikiBlockToEditorHtml } from "../../../lib/wikiVisualEdit";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stripOuterParagraph(html: string) {
  const match = html.match(/^<p(?:\s[^>]*)?>([\s\S]*)<\/p>$/i);
  return match ? match[1] : html;
}

function filePlaceholders(html: string) {
  return html.replace(
    /\[\[(?:파일|File):([^\]|]+)(?:\|[^\]]*)?\]\]/gi,
    (_full, name: string) => `<span class="nmDraftFile">Image · ${escapeHtml(String(name).trim())}</span>`,
  );
}

function inlineHtml(source: string) {
  return filePlaceholders(stripOuterParagraph(wikiBlockToEditorHtml(source)));
}

function stripTableParams(value: string) {
  let text = value.trim();
  while (/^<[^>]+>/.test(text)) text = text.replace(/^<[^>]+>/, "").trimStart();
  return text;
}

function tableHtml(lines: string[]) {
  const rows = lines.map((line) => {
    const pieces = line.split("||");
    const rawCells = pieces.slice(1, pieces.length > 1 && pieces[pieces.length - 1] === "" ? -1 : undefined);
    const cells = rawCells.map((cell) => `<td>${inlineHtml(stripTableParams(cell)) || "&nbsp;"}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<div class="nmDraftTableWrap"><table class="nmDraftTable"><tbody>${rows}</tbody></table></div>`;
}

function youtubeHtml(line: string) {
  const match = line.trim().match(/^\[youtube\(\s*([A-Za-z0-9_-]{6,})(?:\s*,[^)]*)?\)\]$/i);
  if (!match) return null;
  const id = encodeURIComponent(match[1]);
  return `<div class="nmDraftYoutube"><iframe src="https://www.youtube.com/embed/${id}" title="YouTube preview" loading="lazy" allowfullscreen></iframe></div>`;
}

function directiveDepth(value: string) {
  const opens = value.match(/\{\{\{/g)?.length || 0;
  const closes = value.match(/\}\}\}/g)?.length || 0;
  return opens - closes;
}

function advancedBlock(lines: string[], start: number) {
  let depth = 0;
  let end = start;
  for (; end < lines.length; end += 1) {
    depth += directiveDepth(lines[end]);
    if (end > start && depth <= 0) break;
  }
  const first = lines[start].trim();
  const inner = lines.slice(start + 1, Math.max(start + 1, end));
  const label = first.match(/^\{\{\{#!([A-Za-z]+)/)?.[1] || "advanced";
  return {
    end,
    html: `<section class="nmDraftAdvanced"><div class="nmDraftAdvancedLabel">${escapeHtml(label)} block</div>${renderLines(inner)}</section>`,
  };
}

function renderLines(lines: string[]) {
  const chunks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      chunks.push('<div class="nmDraftSpacer"></div>');
      continue;
    }

    if (/^\[\[(?:분류|Category):/i.test(trimmed)) {
      const categories = [...trimmed.matchAll(/\[\[(?:분류|Category):([^\]]+)\]\]/gi)]
        .map((match) => `<span class="nmDraftCategory">${escapeHtml(match[1].trim())}</span>`)
        .join("");
      if (categories) chunks.push(`<div class="nmDraftCategories">${categories}</div>`);
      continue;
    }

    if (/^\[(?:clearfix|목차)\]$/i.test(trimmed)) {
      if (/목차/i.test(trimmed)) chunks.push('<div class="nmDraftToc">Contents</div>');
      continue;
    }

    if (/^\[include\(/i.test(trimmed)) {
      const label = trimmed.slice(9, -1).trim();
      chunks.push(`<div class="nmDraftTemplate">Template · ${escapeHtml(label)}</div>`);
      continue;
    }

    if (/^\{\{\{#!(?:wiki|style|folding|if)\b/i.test(trimmed)) {
      const block = advancedBlock(lines, index);
      chunks.push(block.html);
      index = block.end;
      continue;
    }

    const heading = trimmed.match(/^(={2,6})\s*(.*?)\s*\1$/);
    if (heading) {
      const level = Math.min(6, Math.max(2, heading[1].length));
      chunks.push(`<h${level}>${inlineHtml(heading[2])}</h${level}>`);
      continue;
    }

    if (/^-{4,}$/.test(trimmed)) {
      chunks.push("<hr>");
      continue;
    }

    const youtube = youtubeHtml(trimmed);
    if (youtube) {
      chunks.push(youtube);
      continue;
    }

    if (/^\s*\|\|/.test(line)) {
      const tableLines = [line];
      while (index + 1 < lines.length && /^\s*\|\|/.test(lines[index + 1])) {
        tableLines.push(lines[index + 1]);
        index += 1;
      }
      chunks.push(tableHtml(tableLines));
      continue;
    }

    if (/^\s*(?:\*|1\.)\s/.test(line)) {
      const listLines = [line];
      while (index + 1 < lines.length && /^\s*(?:\*|1\.)\s/.test(lines[index + 1])) {
        listLines.push(lines[index + 1]);
        index += 1;
      }
      chunks.push(`<div class="nmDraftList">${wikiBlockToEditorHtml(listLines.join("\n"))}</div>`);
      continue;
    }

    chunks.push(`<p>${inlineHtml(line)}</p>`);
  }
  return chunks.join("");
}

export function renderPublicNamuMarkPreview(source: string) {
  const normalized = source.replace(/\r\n?/g, "\n");
  return renderLines(normalized.split("\n"));
}
