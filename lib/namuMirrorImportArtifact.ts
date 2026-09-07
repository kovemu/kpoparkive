import { parse } from "node-html-parser";
import { normalizeNamuMirrorHtmlWithReport, type NamuMirrorSyntaxRepairReport } from "./namuMirrorNormalize";
import {
  analyzeNamuRawGrammar,
  mergeNamuRawGrammarAnalyses,
  normalizeNamuRawCodeBlocksForRender,
  repairExpandedIncludeResiduesForRender,
} from "./namuRawGrammar";
import { extractMirrorRawBundle, type MirrorRawBundle, type RenderedFileMap } from "./namuRawSource";

export const NAMU_RENDER_ARTIFACT_VERSION = "namu-mirror-render-artifact-v4-grammar-aware";

export type NamuRenderManifest = {
  version: string;
  articleCharacters: number;
  rawBlockCount: number;
  rawCoverage: number;
  styleBlockCount: number;
  tableCount: number;
  iframeCount: number;
  floatRightTableCount: number;
  renderedFileCount: number;
  rawFileRefCount: number;
  unresolvedRawFileCount: number;
  unresolvedRawFiles: string[];
  hasToc: boolean;
  hasSectionAnchors: boolean;
  hasRawControls: boolean;
  syntaxRepair: NamuMirrorSyntaxRepairReport;
  rawGrammar: ReturnType<typeof mergeNamuRawGrammarAnalyses> & {
    renderNormalizedCodeBlocks: number;
    expandedIncludeResiduesRepaired: number;
  };
};

export type NamuMirrorImportArtifact = {
  rawBundle: MirrorRawBundle;
  articleHtml: string;
  templateCss: string;
  renderedFileMap: RenderedFileMap;
  manifest: NamuRenderManifest;
};

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
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

function extractExactArticleHtml(html: string) {
  const match = html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i);
  return match?.[1] ?? html;
}

function cleanRawBlock(value: string) {
  return decodeEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trimEnd();
}

function extractTemplateStyleBlocks(articleHtml: string) {
  const blocks: string[] = [];
  const pattern = /<pre\b[^>]*>\s*<code\b[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
  for (const match of articleHtml.matchAll(pattern)) {
    const source = cleanRawBlock(match[1] || "");
    const style = source.match(/^#!style\b[^\n]*(?:\n([\s\S]*))?$/i)?.[1];
    if (style?.trim()) blocks.push(style.trim());
  }
  return blocks;
}

function hasFloatRight(style: string | undefined) {
  return /(?:^|;)\s*float\s*:\s*right\b/i.test(style || "");
}

export function buildNamuMirrorImportArtifact(html: string): NamuMirrorImportArtifact {
  const rawArticleHtml = extractExactArticleHtml(html || "");
  const rawBundle = extractMirrorRawBundle(html || "");

  // Phase 1: repair only syntax leaked by the partial mirror renderer. Raw
  // <pre><code> blocks are protected by this pass and canonical source remains untouched.
  const mirrorNormalized = normalizeNamuMirrorHtmlWithReport(rawArticleHtml);

  // Phase 2: source_article_html is a derived render artifact. Normalize only
  // structural boundaries inside its raw code blocks so renderer and importer
  // parse exactly the same Namu grammar. source_wikitext/raw_html remain intact.
  const renderNormalized = normalizeNamuRawCodeBlocksForRender(mirrorNormalized.html);

  // Phase 3: [include(...)] is Namu control syntax. A partial mirror can leave
  // the invocation in front of the HTML it already expanded. Remove only that
  // duplicated control token when a block-level expansion is immediately next.
  const includeNormalized = repairExpandedIncludeResiduesForRender(renderNormalized.html);
  const articleHtml = includeNormalized.html;

  const rawAnalyses = rawBundle.segments
    .filter((segment) => segment.type === "raw")
    .map((segment) => analyzeNamuRawGrammar(segment.source));
  const rawGrammar = {
    ...mergeNamuRawGrammarAnalyses(rawAnalyses),
    renderNormalizedCodeBlocks: renderNormalized.normalizedBlocks,
    expandedIncludeResiduesRepaired: includeNormalized.repaired,
  };

  const root = parse(articleHtml);
  const templateStyleBlocks = extractTemplateStyleBlocks(articleHtml);
  const renderedFiles = rawBundle.renderedFileMap;
  const unresolvedRawFiles = rawBundle.fileRefs.filter((file) => !renderedFiles[file]);
  const tables = root.querySelectorAll("table");

  return {
    rawBundle,
    articleHtml,
    templateCss: templateStyleBlocks.join("\n\n"),
    renderedFileMap: renderedFiles,
    manifest: {
      version: NAMU_RENDER_ARTIFACT_VERSION,
      articleCharacters: articleHtml.length,
      rawBlockCount: rawBundle.rawBlockCount,
      rawCoverage: rawBundle.estimatedRawCoverage,
      styleBlockCount: templateStyleBlocks.length,
      tableCount: tables.length,
      iframeCount: root.querySelectorAll("iframe").length,
      floatRightTableCount: tables.filter((table) => hasFloatRight(table.getAttribute("style"))).length,
      renderedFileCount: Object.keys(renderedFiles).length,
      rawFileRefCount: rawBundle.fileRefs.length,
      unresolvedRawFileCount: unresolvedRawFiles.length,
      unresolvedRawFiles: unresolvedRawFiles.slice(0, 300),
      hasToc: Boolean(root.querySelector(".toc") || root.querySelector("#toc")),
      hasSectionAnchors: Boolean(root.querySelector('[id^="s-"]')),
      hasRawControls: rawGrammar.rawControls > 0 || mirrorNormalized.report.leakedDirectiveOpeners > 0 || mirrorNormalized.report.orphanDirectiveClosers > 0,
      syntaxRepair: mirrorNormalized.report,
      rawGrammar,
    },
  };
}
