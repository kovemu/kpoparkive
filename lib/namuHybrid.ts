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
  relationCandidates: number;
  recoveredValues: number;
};

type ReleaseCandidate = {
  target: string;
  date: string;
};

type PrimaryRelationCandidate = {
  label: string;
  target: string;
};

type RichTableRows = Extract<ParsedSectionV5["content"][number], { type: "rich-table" }>["rows"];
type RichCell = RichTableRows[number][number];

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
 * namu.moe can leave the country flag helper itself as raw #!if syntax inside an
 * otherwise rendered infobox cell. Keep table geometry intact, and materialize
 * only a branch whose source explicitly says both administrative alternatives are
 * null and whose first wiki target is the country document.
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
  // A trailing \b after Korean "일" is invalid for this purpose because JS word
  // boundaries are ASCII-word based.
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

function normalizedCellText(value: string) {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function normalizeTarget(target: string) {
  return target.normalize("NFKC").replace(/#.*$/, "").trim();
}

function usefulTarget(target: string) {
  const value = normalizeTarget(target);
  return Boolean(value) && !/^(?:틀|Template|파일|File|분류|Category):/i.test(value) && !/^https?:\/\//i.test(value);
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
          const target = normalizeTarget(link.target);
          if (!date || !usefulTarget(target)) continue;
          const key = `${target}\u0000${date}`;
          if (seen.has(key)) continue;
          seen.add(key);
          candidates.push({ target, date });
        }
      }
    }
  }

  return candidates;
}

/**
 * Namu navigation templates also encode a stable "category -> primary document"
 * relationship. Example shape (not a hard-coded value):
 *   | category label | primary link | secondary link | ... |
 *
 * We only read tables explicitly marked tableclass=documents, require the category
 * cell to be text-only, and choose the first direct linked sibling. Later recovery
 * still requires the same category label to resolve to exactly one unique target
 * across the complete stored source document.
 */
function extractPrimaryRelationCatalog(segments: RawSourceSegment[]) {
  const candidates: PrimaryRelationCandidate[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    if (segment.type !== "raw" || !/tableclass=documents/i.test(segment.source)) continue;
    for (const node of parseNamuRaw(segment.source)) {
      if (node.type !== "table") continue;
      for (const row of node.rows) {
        if (row.length < 2) continue;
        const category = row[0];
        if (category.children.some((child) => child.type === "link" || child.type === "image")) continue;
        const label = normalizedCellText(inlineText(category.children));
        if (!label || label.length > 40) continue;

        let target = "";
        for (const cell of row.slice(1)) {
          const link = cell.children.find((child) => child.type === "link");
          if (link?.type === "link" && usefulTarget(link.target)) {
            target = normalizeTarget(link.target);
            break;
          }
        }
        if (!target) continue;

        const key = `${label}\u0000${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push({ label, target });
      }
    }
  }

  return candidates;
}

function findRowGroup(rows: RichTableRows, labels: string[]) {
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

function isBlankCell(cell: RichCell | undefined) {
  return Boolean(cell) && !cell?.text && !cell?.image_url && !cell?.link_url;
}

function writeRecoveredLink(cell: RichCell, target: string) {
  cell.text = target;
  cell.link_url = `/w/${encodeURIComponent(target)}`;
  cell.link_label = target;
}

/**
 * Recover only values provable from two positions in the same stored document.
 * A blank debut-album cell can be filled when the rendered infobox contains a date
 * and the raw album navigator has exactly one release on that exact date.
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

        writeRecoveredLink(valueCell, uniqueTargets[0]);
        recovered += 1;
      }
    }
  }

  return recovered;
}

/**
 * Recover a blank labeled infobox relation only when the raw document navigation
 * proves one unique primary target for the exact same label. We additionally
 * require exactly one explicit blank value cell after the label in that rendered
 * row; malformed/ambiguous table geometry is left untouched rather than guessed.
 */
function recoverMissingPrimaryRelations(sections: ParsedSectionV5[], relations: PrimaryRelationCandidate[]) {
  let recovered = 0;
  if (!relations.length) return recovered;

  const targetsByLabel = new Map<string, Set<string>>();
  for (const relation of relations) {
    const label = normalizedCellText(relation.label);
    if (!targetsByLabel.has(label)) targetsByLabel.set(label, new Set());
    targetsByLabel.get(label)?.add(relation.target);
  }

  for (const section of sections) {
    for (const block of section.content) {
      if (block.type !== "rich-table") continue;
      for (const row of block.rows) {
        for (let labelIndex = 0; labelIndex < row.length - 1; labelIndex += 1) {
          const label = normalizedCellText(row[labelIndex].text);
          const targets = targetsByLabel.get(label);
          if (!targets || targets.size !== 1) continue;

          const explicitValues = row.slice(labelIndex + 1);
          const blankValues = explicitValues.filter(isBlankCell);
          const nonBlankValues = explicitValues.filter((cell) => !isBlankCell(cell));
          if (blankValues.length !== 1 || nonBlankValues.length !== 0) continue;

          const target = [...targets][0];
          writeRecoveredLink(blankValues[0], target);
          recovered += 1;
          break;
        }
      }
    }
  }

  return recovered;
}

/**
 * Preserve the mirror's exact segment order, but do not parse every rendered
 * fragment independently. namu.moe frequently emits unsupported control syntax as
 * <pre><code> inside an otherwise valid table. Splitting on it tears surrounding table
 * markup apart, so control-only raw blocks are transparent holes while visible raw
 * blocks remain hard source-order boundaries.
 */
export function parseNamuHybridSegments(segments: RawSourceSegment[]): NamuHybridParse {
  const chunks: NamuHybridChunk[] = [];
  const releaseCatalog = extractReleaseCatalog(segments);
  const relationCatalog = extractPrimaryRelationCatalog(segments);
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
    recoveredValues += recoverMissingPrimaryRelations(sections, relationCatalog);
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
    relationCandidates: relationCatalog.length,
    recoveredValues,
  };
}
