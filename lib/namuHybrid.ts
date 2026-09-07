import { parseNamuHtmlV5, type ParsedSectionV5 } from "./namuParserV5";
import { parseNamuRaw, type NamuRawNode } from "./namuRawParser";
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
};

function isControlRaw(source: string) {
  const trimmed = source.trimStart();
  return /^#!(?:if|style)\b/i.test(trimmed);
}

function usefulRenderedSection(section: ParsedSectionV5) {
  if (section.heading) return true;
  return section.content.length > 0;
}

/**
 * Preserve the mirror's exact segment order. Unsupported constructs survive as
 * raw Namu syntax while ordinary article content is already rendered as HTML.
 * We parse each representation in-place instead of concatenating all raw blocks
 * ahead of all rendered blocks, which would destroy the original document flow.
 */
export function parseNamuHybridSegments(segments: RawSourceSegment[]): NamuHybridParse {
  const chunks: NamuHybridChunk[] = [];
  let rawChunks = 0;
  let renderedChunks = 0;
  let skippedControlChunks = 0;
  let rawNodes = 0;
  let renderedSections = 0;

  segments.forEach((segment, sourceIndex) => {
    if (segment.type === "raw") {
      if (isControlRaw(segment.source)) {
        skippedControlChunks += 1;
        return;
      }
      const nodes = parseNamuRaw(segment.source).filter((node) => node.type !== "raw-control");
      if (!nodes.length) return;
      chunks.push({ type: "raw", sourceIndex, nodes });
      rawChunks += 1;
      rawNodes += nodes.length;
      return;
    }

    const sections = parseNamuHtmlV5(segment.source).filter(usefulRenderedSection);
    if (!sections.length) return;
    chunks.push({ type: "rendered", sourceIndex, sections });
    renderedChunks += 1;
    renderedSections += sections.length;
  });

  return { chunks, rawChunks, renderedChunks, skippedControlChunks, rawNodes, renderedSections };
}
