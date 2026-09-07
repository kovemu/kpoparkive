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
 * Preserve the mirror's exact segment order, but do not parse every rendered
 * fragment independently. namu.moe frequently emits unsupported control syntax
 * as <pre><code> *inside* an otherwise valid table. Splitting on that code block tears the
 * surrounding <table>/<tr>/<td> markup into invalid fragments and is the main
 * reason infobox rows used to appear as unrelated link rows.
 *
 * Control-only raw blocks are therefore treated like transparent holes: rendered
 * HTML on both sides is stitched back together before V5 sees it. A visible raw
 * block is still a hard boundary and is rendered in its original source position.
 * This is generic for every imported document; no group-specific reconstruction
 * rules belong here.
 */
export function parseNamuHybridSegments(segments: RawSourceSegment[]): NamuHybridParse {
  const chunks: NamuHybridChunk[] = [];
  let rawChunks = 0;
  let renderedChunks = 0;
  let skippedControlChunks = 0;
  let rawNodes = 0;
  let renderedSections = 0;

  let renderedBuffer: { sourceIndex: number; source: string }[] = [];

  const flushRendered = () => {
    if (!renderedBuffer.length) return;
    const sourceIndex = renderedBuffer[0].sourceIndex;
    const source = renderedBuffer.map((part) => part.source).join("\n");
    renderedBuffer = [];

    const sections = parseNamuHtmlV5(source).filter(usefulRenderedSection);
    if (!sections.length) return;
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
      // Keep the HTML context alive across #!if / #!style islands. These raw
      // snippets affect presentation/branching, but are not visible article
      // content on their own.
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

  return { chunks, rawChunks, renderedChunks, skippedControlChunks, rawNodes, renderedSections };
}
