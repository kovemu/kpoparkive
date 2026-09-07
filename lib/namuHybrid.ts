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

/**
 * namu.moe sometimes leaves the country flag helper itself as raw #!if syntax
 * inside an otherwise rendered infobox cell. We must keep the surrounding table
 * stitched together, but an entirely empty hole loses the visible country name.
 *
 * Only the primary country branch is safe to materialize here: it explicitly
 * requires both administrative-area alternatives to be null and its first wiki
 * target is the country document. Other #!if blocks remain stored but invisible,
 * so this never chooses between arbitrary template branches.
 */
function controlFlagFallbackHtml(source: string) {
  const trimmed = source.trimStart();
  if (!/^#!if\b/i.test(trimmed)) return null;
  if (!/행정구\s*==\s*null/i.test(trimmed) || !/속령\s*==\s*null/i.test(trimmed)) return null;

  const target = trimmed.match(/\[\[([^\]|\n]+)(?:\|[\s\S]*)?\]\]/)?.[1]?.trim();
  if (!target || /^(?:틀|Template|파일|File|분류|Category):/i.test(target)) return null;
  return `<span data-namu-control-fallback="country">${escapeHtml(target)}</span>`;
}

function normalizeDate(value: string) {
  const korean = value.match(/\b(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일\b/);
  const dotted = value.match(/\b(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})\.?/);
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

/**
 * Album navigation templates leak as raw Namu source on namu.moe even when an
 * infobox value is missing from the rendered mirror. Build a same-document release
 * catalog from those raw album tables. It is deliberately date + link only; no
 * external lookup or title guessing is involved.
 */
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

/**
 * Recover only values that are provable from two independent positions in the
 * same stored source document. Example: the rendered infobox contains a debut
 * date but namu.moe leaves the corresponding debut-album cell blank, while the
 * raw album navigation contains exactly one release on that exact date.
 *
 * Zero or multiple matches are intentionally left blank. This is a generic mirror
 * repair rule, not a group-specific fact table.
 */
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

/**
 * Preserve the mirror's exact segment order, but do not parse every rendered
 * fragment independently. namu.moe frequently emits unsupported control syntax
 * as <pre><code> *inside* an otherwise valid table. Splitting on that code block tears the
 * surrounding <table>/<tr>/<td> markup into invalid fragments and is the main
 * reason infobox rows used to appear as unrelated link rows.
 *
 * Control-only raw blocks are therefore treated like transparent holes: rendered
 * HTML on both sides is stitched back together before V5 sees it. Safe visible
 * fallbacks (currently country-name branches) are inserted into the hole without
 * changing table geometry. A visible raw block is still a hard boundary and is
 * rendered in its original source position. This is generic for every imported
 * document; no group-specific reconstruction rules belong here.
 */
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
      // Keep the HTML context alive across #!if / #!style islands. A narrowly
      // provable country-name branch may contribute visible text to that hole.
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

  return { chunks, rawChunks, renderedChunks, skippedControlChunks, rawNodes, renderedSections, recoveredValues };
}
