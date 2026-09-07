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

/**
 * source_article_html is a derived render artifact, so its <pre><code> payloads
 * may be structurally normalized. raw_html/source_wikitext remain byte-faithful.
 * This makes the renderer consume the same normalized grammar that the importer
 * analyzed, without rewriting the canonical stored source.
 */
export function normalizeNamuRawCodeBlocksForRender(html: string) {
  let normalizedBlocks = 0;
  const output = String(html || "").replace(
    /(<pre\b[^>]*>\s*<code\b[^>]*>)([\s\S]*?)(<\/code>\s*<\/pre>)/gi,
    (full, open: string, body: string, close: string) => {
      const decoded = decodeCodeEntities(body).replace(/\\n/g, "\n").replace(/\r\n?/g, "\n");
      const normalized = normalizeNamuRawBlocks(decoded);
      if (normalized === decoded) return full;
      normalizedBlocks += 1;
      return `${open}${escapeCodeHtml(normalized)}${close}`;
    },
  );
  return { html: output, normalizedBlocks };
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
