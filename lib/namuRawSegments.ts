import { parseNamuRaw, type NamuRawNode } from "./namuRawParser";
import type { RawSourceSegment } from "./namuRawSource";

export type VisibleRawParse = {
  nodes: NamuRawNode[];
  visibleRawBlocks: number;
  skippedControlBlocks: number;
};

/**
 * namu.moe exposes template condition branches as their own <pre><code>
 * segments. Those #!if / #!style blocks are implementation source, not the
 * evaluated article body. Preserve them in source_raw_segments, but do not
 * paint them into the article preview. The adjacent rendered segment keeps the
 * evaluated output until a true /raw source is available.
 */
export function parseVisibleNamuRawSegments(segments: RawSourceSegment[]): VisibleRawParse {
  const nodes: NamuRawNode[] = [];
  let visibleRawBlocks = 0;
  let skippedControlBlocks = 0;

  for (const segment of segments) {
    if (segment.type !== "raw") continue;
    const trimmed = segment.source.trimStart();
    if (/^#!(?:if|style)\b/i.test(trimmed)) {
      skippedControlBlocks += 1;
      continue;
    }
    const parsed = parseNamuRaw(segment.source).filter((node) => node.type !== "raw-control");
    if (!parsed.length) continue;
    visibleRawBlocks += 1;
    nodes.push(...parsed);
  }

  return { nodes, visibleRawBlocks, skippedControlBlocks };
}
