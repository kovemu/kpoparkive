import { evaluateNamuCondition } from "./namuCondition";
import { normalizeNamuRawBlocks } from "./namuRawNormalize";
import { parseNamuRaw, type NamuDirectiveKind, type NamuRawNode } from "./namuRawParser";

export type NamuRawGrammarAnalysis = {
  sourceCharacters: number;
  normalizedCharacters: number;
  normalizedChanged: boolean;
  siblingDirectiveBoundariesRepaired: number;
  topLevelNodes: number;
  tableNodes: number;
  directiveNodes: Record<NamuDirectiveKind, number>;
  rawControls: number;
  squareBalance: number;
  curlyBalance: number;
  unsupportedSamples: string[];
};

const DIRECTIVE_KINDS: NamuDirectiveKind[] = ["wiki", "if", "style", "folding", "html", "unknown"];

function emptyDirectiveCounts(): Record<NamuDirectiveKind, number> {
  return { wiki: 0, if: 0, style: 0, folding: 0, html: 0, unknown: 0 };
}

function syntaxBalance(source: string) {
  let square = 0;
  let curly = 0;
  for (let i = 0; i < source.length; i += 1) {
    const pair = source.slice(i, i + 2);
    const triple = source.slice(i, i + 3);
    if (pair === "[[") { square += 1; i += 1; continue; }
    if (pair === "]]" && square > 0) { square -= 1; i += 1; continue; }
    if (triple === "{{{") { curly += 1; i += 2; continue; }
    if (triple === "}}}" && curly > 0) { curly -= 1; i += 2; continue; }
  }
  return { square, curly };
}

function countSiblingBoundaryRepairs(source: string, normalized: string) {
  const before = (source.match(/\}\}\}\s*\{\{\{#!/g) || []).length;
  const after = (normalized.match(/\}\}\}\n\{\{\{#!/g) || []).length;
  return Math.max(0, after - before);
}

function walkNodes(nodes: NamuRawNode[], analysis: NamuRawGrammarAnalysis) {
  for (const node of nodes) {
    if (node.type === "table") analysis.tableNodes += 1;
    if (node.type === "directive") {
      analysis.directiveNodes[node.kind] += 1;
      walkNodes(node.children, analysis);
    } else if (node.type === "quote") {
      walkNodes(node.children, analysis);
    } else if (node.type === "raw-control") {
      analysis.rawControls += 1;
      if (analysis.unsupportedSamples.length < 20) {
        const sample = node.source.replace(/\s+/g, " ").trim().slice(0, 240);
        if (sample && !analysis.unsupportedSamples.includes(sample)) analysis.unsupportedSamples.push(sample);
      }
    }
  }
}

/**
 * Canonical parser entry point for imported Namu source.
 *
 * The original source stays untouched in source_wikitext. This function only
 * repairs structural boundaries that the mirror can collapse (not content),
 * then feeds the existing Namu grammar parser. That keeps importer diagnostics
 * and rendering on the same grammar path.
 */
export function parseNamuRawCanonical(source: string): NamuRawNode[] {
  return parseNamuRaw(normalizeNamuRawBlocks(String(source || "")));
}

function findBalancedTripleEnd(source: string, start: number) {
  let depth = 1;
  for (let cursor = start + 3; cursor < source.length - 2; cursor += 1) {
    if (source.slice(cursor, cursor + 3) === "{{{") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (source.slice(cursor, cursor + 3) === "}}}") {
      depth -= 1;
      if (depth === 0) return cursor;
      cursor += 2;
    }
  }
  return -1;
}

/**
 * Resolve inline {{{#!if ...}}} macros only in derived render source. Canonical
 * source_wikitext/raw_html are never rewritten. This closes a long-standing
 * gap where block #!if was evaluated by the renderer but an inline #!if inside
 * a link/table cell silently exposed its body regardless of the condition.
 *
 * Unsupported conditions are hidden rather than guessed, matching the block
 * renderer's conservative behavior. Missing template parameters use the shared
 * Namu condition evaluator's default-null semantics.
 */
export function normalizeNamuConditionalMacrosForRender(source: string) {
  const input = String(source || "");
  let output = "";
  let cursor = 0;
  let evaluated = 0;
  let included = 0;
  let excluded = 0;

  while (cursor < input.length) {
    const start = input.indexOf("{{{#!if", cursor);
    if (start < 0) {
      output += input.slice(cursor);
      break;
    }
    output += input.slice(cursor, start);
    const end = findBalancedTripleEnd(input, start);
    if (end < 0) {
      output += input.slice(start);
      break;
    }

    const inner = input.slice(start + 3, end);
    const match = inner.match(/^#!if\b([^\n]*)(?:\n([\s\S]*))?$/i);
    if (!match) {
      output += input.slice(start, end + 3);
      cursor = end + 3;
      continue;
    }

    evaluated += 1;
    const condition = match[1].trim();
    const body = match[2] || "";
    const result = evaluateNamuCondition(condition);
    if (result === true) {
      const nested = normalizeNamuConditionalMacrosForRender(body);
      output += nested.source;
      evaluated += nested.evaluated;
      included += 1 + nested.included;
      excluded += nested.excluded;
    } else {
      excluded += 1;
    }
    cursor = end + 3;
  }

  return { source: output, evaluated, included, excluded };
}

/** Render parser: canonical structural normalization plus conditional pruning. */
export function parseNamuRawForRender(source: string): NamuRawNode[] {
  const structurallyNormalized = normalizeNamuRawBlocks(String(source || ""));
  const conditional = normalizeNamuConditionalMacrosForRender(structurallyNormalized);
  return parseNamuRaw(conditional.source);
}

export function analyzeNamuRawGrammar(source: string): NamuRawGrammarAnalysis {
  const original = String(source || "").replace(/\r\n?/g, "\n");
  const normalized = normalizeNamuRawBlocks(original);
  const balance = syntaxBalance(normalized);
  const analysis: NamuRawGrammarAnalysis = {
    sourceCharacters: original.length,
    normalizedCharacters: normalized.length,
    normalizedChanged: normalized !== original,
    siblingDirectiveBoundariesRepaired: countSiblingBoundaryRepairs(original, normalized),
    topLevelNodes: 0,
    tableNodes: 0,
    directiveNodes: emptyDirectiveCounts(),
    rawControls: 0,
    squareBalance: balance.square,
    curlyBalance: balance.curly,
    unsupportedSamples: [],
  };

  const nodes = parseNamuRaw(normalized);
  analysis.topLevelNodes = nodes.length;
  walkNodes(nodes, analysis);
  return analysis;
}

function decodeCodeEntities(value: string) {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#91;/gi, "[")
    .replace(/&#93;/gi, "]")
    .replace(/&#123;/gi, "{")
    .replace(/&#125;/gi, "}")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function escapeCodeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function protectRawCodeBlocks(source: string) {
  const blocks: string[] = [];
  const html = source.replace(/<pre\b[^>]*>\s*<code\b[^>]*>[\s\S]*?<\/code>\s*<\/pre>/gi, (block) => {
    const index = blocks.push(block) - 1;
    return `<!--KPOPARKIVE_GRAMMAR_RAW_${index}-->`;
  });
  return { html, blocks };
}

function restoreRawCodeBlocks(source: string, blocks: string[]) {
  return source.replace(/<!--KPOPARKIVE_GRAMMAR_RAW_(\d+)-->/g, (match, index: string) => blocks[Number(index)] ?? match);
}

/**
 * Partial mirrors sometimes leave the literal Namu [include(...)] invocation
 * directly in front of the HTML that is already the expansion of that include.
 * The invocation is control syntax, not visible article text. Remove it only
 * when a block-level rendered expansion follows immediately. If there is no
 * expansion, preserve it so a future template evaluator can handle it.
 */
export function repairExpandedIncludeResiduesForRender(source: string) {
  const protectedSource = protectRawCodeBlocks(String(source || ""));
  let repaired = 0;
  const html = protectedSource.html.replace(
    /(?:\[|&#91;)include\(([\s\S]{1,3000}?)\)(?:\]|&#93;)(\s*)(?=<(?:table|div|dl|section|article|figure|aside)\b)/gi,
    (_full, _args: string, whitespace: string) => {
      repaired += 1;
      return whitespace;
    },
  );
  return { html: restoreRawCodeBlocks(html, protectedSource.blocks), repaired };
}

/**
 * source_article_html is a derived render artifact, so its <pre><code> payloads
 * may be structurally normalized. raw_html/source_wikitext remain byte-faithful.
 * This makes the renderer consume the same normalized grammar that the importer
 * analyzed, without rewriting the canonical stored source.
 */
export function normalizeNamuRawCodeBlocksForRender(html: string) {
  let normalizedBlocks = 0;
  let conditionalMacrosEvaluated = 0;
  let conditionalMacrosIncluded = 0;
  let conditionalMacrosExcluded = 0;
  const output = String(html || "").replace(
    /(<pre\b[^>]*>\s*<code\b[^>]*>)([\s\S]*?)(<\/code>\s*<\/pre>)/gi,
    (full, open: string, body: string, close: string) => {
      const decoded = decodeCodeEntities(body).replace(/\\n/g, "\n").replace(/\r\n?/g, "\n");
      const structural = normalizeNamuRawBlocks(decoded);
      const conditional = normalizeNamuConditionalMacrosForRender(structural);
      const normalized = conditional.source;
      conditionalMacrosEvaluated += conditional.evaluated;
      conditionalMacrosIncluded += conditional.included;
      conditionalMacrosExcluded += conditional.excluded;
      if (normalized === decoded) return full;
      normalizedBlocks += 1;
      return `${open}${escapeCodeHtml(normalized)}${close}`;
    },
  );
  return {
    html: output,
    normalizedBlocks,
    conditionalMacrosEvaluated,
    conditionalMacrosIncluded,
    conditionalMacrosExcluded,
  };
}

export function mergeNamuRawGrammarAnalyses(items: NamuRawGrammarAnalysis[]) {
  const directiveNodes = emptyDirectiveCounts();
  const unsupportedSamples: string[] = [];
  let normalizedBlocks = 0;
  let siblingDirectiveBoundariesRepaired = 0;
  let tableNodes = 0;
  let rawControls = 0;
  let unbalancedBlocks = 0;

  for (const item of items) {
    if (item.normalizedChanged) normalizedBlocks += 1;
    siblingDirectiveBoundariesRepaired += item.siblingDirectiveBoundariesRepaired;
    tableNodes += item.tableNodes;
    rawControls += item.rawControls;
    if (item.squareBalance || item.curlyBalance) unbalancedBlocks += 1;
    for (const kind of DIRECTIVE_KINDS) directiveNodes[kind] += item.directiveNodes[kind];
    for (const sample of item.unsupportedSamples) {
      if (unsupportedSamples.length >= 30) break;
      if (!unsupportedSamples.includes(sample)) unsupportedSamples.push(sample);
    }
  }

  return {
    analyzedBlocks: items.length,
    structurallyNormalizedBlocks: normalizedBlocks,
    siblingDirectiveBoundariesRepaired,
    parsedTableNodes: tableNodes,
    directiveNodes,
    rawControls,
    unbalancedBlocks,
    unsupportedSamples,
  };
}
