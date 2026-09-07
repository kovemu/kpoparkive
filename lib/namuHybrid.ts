import { parseNamuHtmlV5, type ParsedSectionV5 } from "./namuParserV5";
import { parseNamuRaw, type NamuInline, type NamuRawNode } from "./namuRawParser";
import type { RawSourceSegment } from "./namuRawSource";

export type NamuHybridChunk =
  | { type: "raw"; sourceIndex: number; nodes: NamuRawNode[] }
  | { type: "rendered"; sourceIndex: number; sections: ParsedSectionV5[] };

export type NamuHybridParse = {
  chunks: NamuHybridChunk[];
  rawChunks: number;
  renderedChunks: number;
  skippedControlChunks: number;
  rawNodes: number;
  renderedSections: number;
  releaseCandidates: number;
  recoveredValues: number;
};

type ReleaseCandidate = {
  target: string;
  date: string;
};

function isControlRaw(source: string) {
  const trimmed = source.trimStart();
  return /^#!(?:if|style)\b/i.test(trimmed);
}

function usefulRenderedSection(section: ParsedSectionV5) {
  if (section.heading) return true;
  return section.content.length > 0;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function controlFlagFallbackHtml(source: string) {
  const trimmed = source.trimStart();
  if (!/^#!if\b/i.test(trimmed)) return null;
  if (!/행정구\s*==\s*null/i.test(trimmed) || !/속령\s*==\s*null/i.test(trimmed)) return null;

  const target = trimmed.match(/\[\[([^\]|\n]+)(?:\|[\s\S]*)?\]\]/)?.[1]?.trim();
  if (!target || /^(?:틀|Template|파일|File|분류|Category):/i.test(target)) return null;
  return `<span data-namu-control-fallback="country">${escapeHtml(target)}</span>`;
}

function normalizeDate(value: string) {
  // Do not use a trailing \b after Korean "일": JavaScript word boundaries are
  // ASCII-word based, so perfectly valid strings such as "2024년 3월 26일" fail.
  const korean = value.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  const dotted = value.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?/);
  const match = korean || dotted;
  if (!match) return null;
  const year = match[1];
  const month = String(Number(match[2])).padStart(2, "0");
  const day = String(Number(match[3])).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function inlineText(children: NamuInline[]) {
  return children.map((child) => {
    if (child.type === "text") return child.text;
    if (child.type === "link") return child.label;
    return "";
  }).join(" ");
}

function extractReleaseCatalog(segments: RawSourceSegment[]) {
  const candidates: ReleaseCandidate[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    if (segment.type !== "raw" || !/tableclass=albums/i.test(segment.source)) continue;
    for (const node of parseNamuRaw(segment.source)) {
      if (node.type !== "table") continue;
      for (const row of node.rows) {
        for (const cell of row) {
          const link = cell.children.find((child) => child.type === "link");
          if (!link || link.type !== "link") continue;
          const date = normalizeDate(inlineText(cell.children));
          const target = link.target.replace(/#.*$/, "").trim();
          if (!date || !target) continue;
          const key = `${target.normalize("NFKC")}\u0000${date}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ target, date });
        }
      }
    }
  }

  return candidates;
}

function normalizedCellText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function findRowGroup(rows: Extract<ParsedSectionV5["content"][number], { type: "rich-table" }>["rows"], labels: string[]) {
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    const labelIndex = row.findIndex((cell) => labels.includes(normalizedCellText(cell.text)));
    if (labelIndex < 0) continue;
    return {
      start: rowIndex,
      count: Math.max(1, row[labelIndex].rowspan || 1),
      labelIndex,
    };
  }
  return null;
}

function isBlankCell(cell: Extract<ParsedSectionV5["content"][number], { type: "rich-table" }>["rows"][number][number] | undefined) {
  return Boolean(cell) && !cell?.text && !cell?.image_url && !cell?.link_url;
}

function recoverMissingDebutAlbumValues(sections: ParsedSectionV5[], releases: ReleaseCandidate[]) {
  let recovered = 0;
  if (!releases.length) return recovered;

  for (const section of sections) {
    for (const block of section.content) {
      if (block.type !== "rich-table") continue;
      const debutDates = findRowGroup(block.rows, ["데뷔일"]);
      const debutAlbums = findRowGroup(block.rows, ["데뷔 음반", "데뷔 앨범"]);
      if (!debutDates || !debutAlbums) continue;

      const rowsToCompare = Math.min(debutDates.count, debutAlbums.count);
      for (let offset = 0; offset < rowsToCompare; offset += 1) {
        const dateRow = block.rows[debutDates.start + offset];
        const albumRow = block.rows[debutAlbums.start + offset];
        if (!dateRow?.length || !albumRow?.length) continue;

        const date = normalizeDate(dateRow.map((cell) => cell.text).join(" "));
        const valueCell = albumRow[albumRow.length - 1];
        if (!date || !isBlankCell(valueCell)) continue;

        const matches = releases.filter((release) => release.date === date);
        const uniqueTargets = [...new Set(matches.map((match) => match.target))];
        if (uniqueTargets.length !== 1) continue;

        const target = uniqueTargets[0];
        valueCell.text = target;
        valueCell.link_url = `/w/${encodeURIComponent(target)}`;
        valueCell.link_label = target;
        recovered += 1;
      }
    }
  }

  return recovered;
}

export function parseNamuHybridSegments(segments: RawSourceSegment[]): NamuHybridParse {
  const chunks: NamuHybridChunk[] = [];
  const releaseCatalog = extractReleaseCatalog(segments);
  let rawChunks = 0;
  let renderedChunks = 0;
  let skippedControlChunks = 0;
  let rawNodes = 0;
  let renderedSections = 0;
  let recoveredValues = 0;

  let renderedBuffer: { sourceIndex: number; source: string }[] = [];

  const flushRendered = () => {
    if (!renderedBuffer.length) return;
    const sourceIndex = renderedBuffer[0].sourceIndex;
    const source = renderedBuffer.map((part) => part.source).join("\n");
    renderedBuffer = [];

    const sections = parseNamuHtmlV5(source).filter(usefulRenderedSection);
    if (!sections.length) return;
    recoveredValues += recoverMissingDebutAlbumValues(sections, releaseCatalog);
    chunks.push({ type: "rendered", sourceIndex, sections });
    renderedChunks += 1;
    renderedSections += sections.length;
  };

  segments.forEach((segment, sourceIndex) => {
    if (segment.type === "rendered") {
      renderedBuffer.push({ sourceIndex, source: segment.source });
      return;
    }

    if (isControlRaw(segment.source)) {
      const fallback = controlFlagFallbackHtml(segment.source);
      if (fallback) renderedBuffer.push({ sourceIndex, source: fallback });
      skippedControlChunks += 1;
      return;
    }

    flushRendered();
    const nodes = parseNamuRaw(segment.source).filter((node) => node.type !== "raw-control");
    if (!nodes.length) return;
    chunks.push({ type: "raw", sourceIndex, nodes });
    rawChunks += 1;
    rawNodes += nodes.length;
  });

  flushRendered();

  return {
    chunks,
    rawChunks,
    renderedChunks,
    skippedControlChunks,
    rawNodes,
    renderedSections,
    releaseCandidates: releaseCatalog.length,
    recoveredValues,
  };
}
