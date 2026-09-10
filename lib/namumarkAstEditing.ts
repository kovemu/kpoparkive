import {
  parseNamuMarkAst,
  type NamuAstBlockNode,
  type NamuAstDocument,
  type NamuAstInlineNode,
  type NamuAstTable,
} from "./namumarkAst";

function tinyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function topLevelTableRowClosed(value: string) {
  let curlyDepth = 0;
  let squareDepth = 0;
  let lastDelimiter = -1;

  for (let index = 0; index < value.length - 1; index += 1) {
    const triple = value.slice(index, index + 3);
    const pair = value.slice(index, index + 2);

    if (triple === "{{{") {
      curlyDepth += 1;
      index += 2;
      continue;
    }
    if (triple === "}}}" && curlyDepth > 0) {
      curlyDepth -= 1;
      index += 2;
      continue;
    }
    if (pair === "[[") {
      squareDepth += 1;
      index += 1;
      continue;
    }
    if (pair === "]]" && squareDepth > 0) {
      squareDepth -= 1;
      index += 1;
      continue;
    }
    if (pair === "||" && curlyDepth === 0 && squareDepth === 0) {
      lastDelimiter = index;
      index += 1;
    }
  }

  return lastDelimiter >= 0 && !value.slice(lastDelimiter + 2).trim();
}

function countLogicalTableRows(value: string) {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  let curlyDepth = 0;
  let squareDepth = 0;
  let count = 0;

  for (const line of lines) {
    if (curlyDepth === 0 && squareDepth === 0 && /^\s*\|\|/.test(line)) count += 1;
    for (let index = 0; index < line.length; index += 1) {
      const triple = line.slice(index, index + 3);
      const pair = line.slice(index, index + 2);
      if (triple === "{{{") { curlyDepth += 1; index += 2; continue; }
      if (triple === "}}}" && curlyDepth > 0) { curlyDepth -= 1; index += 2; continue; }
      if (pair === "[[") { squareDepth += 1; index += 1; continue; }
      if (pair === "]]" && squareDepth > 0) { squareDepth -= 1; index += 1; }
    }
  }
  return Math.max(1, count);
}

function tableNode(source: string, start: number, end: number): NamuAstTable {
  const raw = source.slice(start, end);
  return {
    id: `nm:table:${start}:${end}:${tinyHash(raw)}`,
    type: "table",
    sourceStart: start,
    sourceEnd: end,
    raw,
    rowCount: countLogicalTableRows(raw),
    editingMode: "structured-bridge",
  };
}

function coalesceTableContinuations(source: string, blocks: NamuAstBlockNode[]) {
  const repaired: NamuAstBlockNode[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== "table" || topLevelTableRowClosed(block.raw)) {
      repaired.push(block);
      continue;
    }

    let endIndex = index;
    let candidateEnd = block.sourceEnd;
    let candidate = block.raw;

    while (endIndex + 1 < blocks.length && candidate.length < 200_000 && !topLevelTableRowClosed(candidate)) {
      endIndex += 1;
      candidateEnd = blocks[endIndex].sourceEnd;
      candidate = source.slice(block.sourceStart, candidateEnd);
    }

    if (endIndex > index && topLevelTableRowClosed(candidate)) {
      repaired.push(tableNode(source, block.sourceStart, candidateEnd));
      index = endIndex;
      continue;
    }

    repaired.push(block);
  }

  return repaired;
}

function inlineStats(nodes: NamuAstInlineNode[]) {
  let inlineNodeCount = 0;
  let linkCount = 0;
  const visit = (items: NamuAstInlineNode[]) => {
    for (const node of items) {
      inlineNodeCount += 1;
      if (node.type === "link" || node.type === "external-link") linkCount += 1;
      if (node.type === "link" || node.type === "external-link" || node.type === "format") visit(node.children);
    }
  };
  visit(nodes);
  return { inlineNodeCount, linkCount };
}

function repairStats(document: NamuAstDocument, blocks: NamuAstBlockNode[]) {
  let inlineNodeCount = 0;
  let linkCount = 0;
  for (const block of blocks) {
    if (block.type === "heading" || block.type === "paragraph") {
      const stats = inlineStats(block.children);
      inlineNodeCount += stats.inlineNodeCount;
      linkCount += stats.linkCount;
    } else if (block.type === "list") {
      for (const line of block.lines) {
        const stats = inlineStats(line.children);
        inlineNodeCount += stats.inlineNodeCount;
        linkCount += stats.linkCount;
      }
    }
  }
  return {
    ...document.stats,
    blockCount: blocks.length,
    inlineNodeCount,
    linkCount,
    headingCount: blocks.filter((block) => block.type === "heading").length,
    tableCount: blocks.filter((block) => block.type === "table").length,
    templateCount: blocks.filter((block) => block.type === "template").length,
    mediaCount: blocks.filter((block) => block.type === "media").length,
    fallbackBlockCount: blocks.filter((block) => block.type === "styled-block" || block.type === "raw-block").length,
  };
}

export function parseNamuMarkAstForEditing(source: string): NamuAstDocument {
  const parsed = parseNamuMarkAst(source);
  const blocks = coalesceTableContinuations(source, parsed.blocks);
  if (blocks === parsed.blocks || (blocks.length === parsed.blocks.length && blocks.every((block, index) => block === parsed.blocks[index]))) {
    return parsed;
  }
  return {
    ...parsed,
    blocks,
    stats: repairStats(parsed, blocks),
  };
}

export function assertEditingAstLossless(source: string, document = parseNamuMarkAstForEditing(source)) {
  const rebuilt = document.blocks.map((block) => block.raw).join("");
  if (rebuilt !== source) {
    throw new Error(`Editing AST round-trip mismatch (${source.length} -> ${rebuilt.length})`);
  }
  return true;
}
