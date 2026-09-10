import {
  findNamuAstNode,
  parseNamuMarkAst,
  type NamuAstDocument,
  type NamuAstExternalLink,
  type NamuAstHeading,
  type NamuAstLink,
  type NamuAstText,
} from "./namumarkAst";

export type NamuAstEditOperation =
  | { op: "replace-text"; nodeId: string; text: string }
  | { op: "unlink"; nodeId: string }
  | { op: "set-link"; nodeId: string; target: string; label?: string }
  | { op: "set-heading"; nodeId: string; text: string; level?: number }
  | { op: "replace-raw"; nodeId: string; wikitext: string };

export type NamuAstAppliedChange = {
  op: NamuAstEditOperation["op"];
  nodeId: string;
  nodeType: string;
  sourceStart: number;
  sourceEnd: number;
  before: string;
  after: string;
};

type Patch = NamuAstAppliedChange;

const MAX_TEXT = 20_000;
const MAX_RAW = 200_000;
const FORBIDDEN_PLAIN_TEXT = ["[[", "]]", "{{{", "}}}", "'''", "''", "__", "~~", "^^"];

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409 });
}

function cleanPlainText(value: unknown, label: string, max = MAX_TEXT) {
  const text = String(value ?? "");
  if (text.length > max) throw badRequest(`${label} is too long`);
  if (/\r|\n/.test(text)) throw badRequest(`${label} must stay on one line`);
  for (const token of FORBIDDEN_PLAIN_TEXT) {
    if (text.includes(token)) throw badRequest(`${label} contains NamuMark control syntax (${token}). Use a structured formatting tool instead.`);
  }
  if (/\[(?:include|youtube|kakaotv|nicovideo|vimeo|age|dday)\(/i.test(text)) {
    throw badRequest(`${label} contains macro syntax. Use a structured insert tool instead.`);
  }
  return text;
}

function cleanInternalTarget(value: unknown) {
  const target = String(value ?? "").normalize("NFKC").trim();
  if (!target || target.length > 1000) throw badRequest("Link target is invalid");
  if (/\r|\n|\]\]|\|/.test(target)) throw badRequest("Link target contains unsupported NamuMark syntax");
  return target;
}

function cleanExternalTarget(value: unknown) {
  const target = String(value ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(target) || target.length > 4000 || /[\]\r\n]/.test(target)) {
    throw badRequest("External link target must be a valid http(s) URL");
  }
  return target;
}

function asTextNode(node: ReturnType<typeof findNamuAstNode>): NamuAstText {
  if (!node || node.type !== "text") throw conflict("The selected text node no longer exists. Reload and try again.");
  return node;
}

function asLinkNode(node: ReturnType<typeof findNamuAstNode>): NamuAstLink | NamuAstExternalLink {
  if (!node || (node.type !== "link" && node.type !== "external-link")) {
    throw conflict("The selected link node no longer exists. Reload and try again.");
  }
  return node;
}

function asHeadingNode(node: ReturnType<typeof findNamuAstNode>): NamuAstHeading {
  if (!node || node.type !== "heading") throw conflict("The selected heading no longer exists. Reload and try again.");
  return node;
}

function visibleLinkSource(node: NamuAstLink | NamuAstExternalLink) {
  if (node.type === "link") return node.explicitLabel ? node.raw.slice(node.labelStart - node.sourceStart, node.labelEnd - node.sourceStart) : node.target;
  return node.explicitLabel ? node.raw.slice(node.labelStart - node.sourceStart, node.labelEnd - node.sourceStart) : node.url;
}

function replacementForLink(node: NamuAstLink | NamuAstExternalLink, targetValue: string, labelValue?: string) {
  const oldVisible = visibleLinkSource(node);
  const explicitLabel = labelValue !== undefined;
  const label = explicitLabel ? cleanPlainText(labelValue, "Link label", 4000) : oldVisible;

  if (node.type === "link") {
    const target = cleanInternalTarget(targetValue);
    const targetChanged = target !== node.target;
    if (!node.explicitLabel && !explicitLabel && !targetChanged) return `[[${target}]]`;
    return `[[${target}|${label}]]`;
  }

  const target = cleanExternalTarget(targetValue);
  const targetChanged = target !== node.url;
  if (!node.explicitLabel && !explicitLabel && !targetChanged) return `[${target}]`;
  return `[${target} ${label}]`;
}

function headingReplacement(node: NamuAstHeading, textValue: string, levelValue?: number) {
  const text = cleanPlainText(textValue.trim(), "Heading", 500);
  if (!text) throw badRequest("Heading cannot be empty");
  const requested = levelValue === undefined ? node.level : Number(levelValue);
  if (!Number.isFinite(requested)) throw badRequest("Heading level is invalid");
  const level = Math.max(2, Math.min(6, Math.round(requested)));
  const eol = node.raw.match(/(?:\r\n|\r|\n)$/)?.[0] || "";
  const marks = "=".repeat(level);
  return `${marks} ${text} ${marks}${eol}`;
}

function rawReplacementAllowed(type: string) {
  return type === "raw-block" || type === "styled-block" || type === "table" || type === "template" || type === "media";
}

function operationPatch(document: NamuAstDocument, operation: NamuAstEditOperation): Patch {
  const node = findNamuAstNode(document, operation.nodeId);
  if (!node) throw conflict(`AST node ${operation.nodeId} no longer exists. Reload and try again.`);

  let after = node.raw;
  if (operation.op === "replace-text") {
    const textNode = asTextNode(node);
    after = cleanPlainText(operation.text, "Text");
    if (textNode.raw === after) after = textNode.raw;
  } else if (operation.op === "unlink") {
    const link = asLinkNode(node);
    after = visibleLinkSource(link);
  } else if (operation.op === "set-link") {
    const link = asLinkNode(node);
    after = replacementForLink(link, operation.target, operation.label);
  } else if (operation.op === "set-heading") {
    const heading = asHeadingNode(node);
    after = headingReplacement(heading, operation.text, operation.level);
  } else if (operation.op === "replace-raw") {
    if (!rawReplacementAllowed(node.type)) throw badRequest(`Raw source editing is not allowed for ${node.type} nodes`);
    after = String(operation.wikitext ?? "");
    if (after.length > MAX_RAW) throw badRequest("Advanced source block is too large");
  }

  return {
    op: operation.op,
    nodeId: operation.nodeId,
    nodeType: node.type,
    sourceStart: node.sourceStart,
    sourceEnd: node.sourceEnd,
    before: node.raw,
    after,
  };
}

function validatePatches(patches: Patch[]) {
  const sorted = [...patches].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd);
  for (let index = 0; index < sorted.length; index += 1) {
    const patch = sorted[index];
    if (patch.sourceStart < 0 || patch.sourceEnd < patch.sourceStart) throw badRequest("Invalid AST source range");
    if (index === 0) continue;
    const previous = sorted[index - 1];
    if (patch.sourceStart < previous.sourceEnd) {
      throw badRequest(`Overlapping visual edits are not allowed (${previous.nodeType} and ${patch.nodeType}). Apply one structural edit to the parent node instead.`);
    }
  }
}

export function applyNamuAstOperations(source: string, operations: NamuAstEditOperation[]) {
  if (!Array.isArray(operations) || !operations.length) throw badRequest("No AST edit operations were supplied");
  if (operations.length > 500) throw badRequest("Too many AST edit operations in one proposal");

  const document = parseNamuMarkAst(source);
  const patches = operations.map((operation) => operationPatch(document, operation));
  validatePatches(patches);

  let proposed = source;
  for (const patch of [...patches].sort((a, b) => b.sourceStart - a.sourceStart || b.sourceEnd - a.sourceEnd)) {
    if (source.slice(patch.sourceStart, patch.sourceEnd) !== patch.before) {
      throw conflict(`Source range for ${patch.nodeType} changed while editing. Reload and try again.`);
    }
    proposed = `${proposed.slice(0, patch.sourceStart)}${patch.after}${proposed.slice(patch.sourceEnd)}`;
  }

  const changed = patches.filter((patch) => patch.before !== patch.after);
  if (!changed.length) throw badRequest("No changes were made");

  return {
    proposed,
    changes: changed,
    beforeAst: document,
    afterAst: parseNamuMarkAst(proposed),
  };
}
