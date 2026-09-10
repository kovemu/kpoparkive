import { findNamuAstNode, type NamuAstBlockNode, type NamuAstInlineNode } from "./namumarkAst";
import { applyNamuAstOperations, type NamuAstAppliedChange, type NamuAstEditOperation } from "./namumarkAstEdit";
import { assertEditingAstLossless, parseNamuMarkAstForEditing } from "./namumarkAstEditing";
import { applyNamuMediaChanges, type NamuMediaChanges } from "./namumarkMediaAst";

export type NamuAstCompleteEditOperation =
  | NamuAstEditOperation
  | ({ op: "media-fields"; nodeId: string } & NamuMediaChanges)
  | { op: "delete-node"; nodeId: string }
  | { op: "delete-inline-node"; nodeId: string }
  | { op: "insert-block"; anchorNodeId: string; position: "before" | "after"; wikitext: string };

type StructuralPatch = NamuAstAppliedChange & { sequence: number };

const DELETABLE_BLOCKS = new Set(["paragraph", "list", "table", "template", "media", "divider", "styled-block", "raw-block"]);
const DELETABLE_INLINE = new Set(["footnote", "inline-media", "link", "external-link", "format", "raw-inline"]);
const REPLACEABLE_PARENT = new Set(["paragraph", "list", "heading"]);
const MAX_INSERT_CHARS = 200_000;

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409 });
}

function isBaseOperation(operation: NamuAstCompleteEditOperation): operation is NamuAstEditOperation {
  return operation.op !== "media-fields" && operation.op !== "delete-node" && operation.op !== "delete-inline-node" && operation.op !== "insert-block";
}

function blockContaining(blocks: NamuAstBlockNode[], node: NamuAstInlineNode) {
  return blocks.find((block) => block.sourceStart <= node.sourceStart && node.sourceEnd <= block.sourceEnd) || null;
}

function sourceEol(source: string) {
  const match = source.match(/\r\n|\r|\n/);
  return match?.[0] || "\n";
}

function normalizeInsertedBlock(source: string, value: unknown) {
  let text = String(value ?? "");
  if (!text.trim()) throw badRequest("Inserted block cannot be empty");
  if (text.length > MAX_INSERT_CHARS) throw badRequest("Inserted block is too large");
  const eol = sourceEol(source);
  text = text.replace(/\r\n|\r|\n/g, eol);
  if (!text.endsWith(eol)) text += eol;

  const parsed = parseNamuMarkAstForEditing(text);
  assertEditingAstLossless(text, parsed);
  const semantic = parsed.blocks.filter((block) => block.type !== "whitespace");
  if (semantic.length !== 1) throw badRequest("Insert must contain exactly one structural wiki block");
  if (semantic[0].type === "raw-block" && !/^\s*\{\{\{/.test(semantic[0].raw)) {
    throw badRequest("Unsupported inserted raw block");
  }
  return { text, nodeType: semantic[0].type };
}

function patchInlineRaw(parent: NamuAstBlockNode, edits: Array<{ start: number; end: number; value: string }>) {
  const local = edits.map((edit) => ({
    start: edit.start - parent.sourceStart,
    end: edit.end - parent.sourceStart,
    value: edit.value,
  })).sort((a, b) => a.start - b.start || a.end - b.end);

  for (let index = 0; index < local.length; index += 1) {
    const edit = local[index];
    if (edit.start < 0 || edit.end < edit.start || edit.end > parent.raw.length) throw badRequest("Invalid inline source range");
    if (index && edit.start < local[index - 1].end) throw badRequest("Overlapping inline structural edits are not allowed");
  }

  let raw = parent.raw;
  for (const edit of [...local].sort((a, b) => b.start - a.start || b.end - a.end)) {
    raw = `${raw.slice(0, edit.start)}${edit.value}${raw.slice(edit.end)}`;
  }
  return raw;
}

function preprocessInlineOperations(source: string, operations: NamuAstCompleteEditOperation[]) {
  const document = parseNamuMarkAstForEditing(source);
  const passthrough: NamuAstEditOperation[] = [];
  const grouped = new Map<string, { parent: NamuAstBlockNode; edits: Array<{ start: number; end: number; value: string }> }>();
  const structural: StructuralPatch[] = [];

  const addParentEdit = (parent: NamuAstBlockNode, start: number, end: number, value: string) => {
    if (!REPLACEABLE_PARENT.has(parent.type)) throw badRequest(`Inline editing inside ${parent.type} is not supported by the visual editor yet`);
    const current = grouped.get(parent.id) || { parent, edits: [] };
    current.edits.push({ start, end, value });
    grouped.set(parent.id, current);
  };

  operations.forEach((operation, sequence) => {
    if (isBaseOperation(operation)) {
      passthrough.push(operation);
      return;
    }

    if (operation.op === "media-fields") {
      const node = findNamuAstNode(document, operation.nodeId);
      if (!node || (node.type !== "media" && node.type !== "inline-media")) {
        throw conflict("The selected media node no longer exists. Reload and try again.");
      }
      const proposed = applyNamuMediaChanges(node.raw, {
        target: operation.target,
        params: operation.params,
        removeParamIds: operation.removeParamIds,
        appendParams: operation.appendParams,
      }).proposed;
      if (node.type === "media") {
        passthrough.push({ op: "replace-raw", nodeId: node.id, wikitext: proposed });
      } else {
        const parent = blockContaining(document.blocks, node);
        if (!parent) throw conflict("The media parent block no longer exists. Reload and try again.");
        addParentEdit(parent, node.sourceStart, node.sourceEnd, proposed);
      }
      return;
    }

    if (operation.op === "delete-inline-node") {
      const node = findNamuAstNode(document, operation.nodeId);
      if (!node || !DELETABLE_INLINE.has(node.type)) throw conflict("The selected inline node can no longer be deleted. Reload and try again.");
      const parent = blockContaining(document.blocks, node as NamuAstInlineNode);
      if (!parent) throw conflict("The selected inline node parent no longer exists. Reload and try again.");
      addParentEdit(parent, node.sourceStart, node.sourceEnd, "");
      return;
    }

    if (operation.op === "delete-node") {
      const block = document.blocks.find((item) => item.id === operation.nodeId);
      if (!block || !DELETABLE_BLOCKS.has(block.type)) throw conflict("The selected block can no longer be deleted. Reload and try again.");
      structural.push({
        op: "delete-node",
        nodeId: block.id,
        nodeType: block.type,
        sourceStart: block.sourceStart,
        sourceEnd: block.sourceEnd,
        before: block.raw,
        after: "",
        sequence,
      });
      return;
    }

    const anchor = document.blocks.find((item) => item.id === operation.anchorNodeId);
    if (!anchor) throw conflict("The insertion anchor no longer exists. Reload and try again.");
    const inserted = normalizeInsertedBlock(source, operation.wikitext);
    const point = operation.position === "before" ? anchor.sourceStart : anchor.sourceEnd;
    structural.push({
      op: "insert-block",
      nodeId: anchor.id,
      nodeType: inserted.nodeType,
      sourceStart: point,
      sourceEnd: point,
      before: "",
      after: inserted.text,
      sequence,
    });
  });

  for (const { parent, edits } of grouped.values()) {
    const replacement = patchInlineRaw(parent, edits);
    passthrough.push({ op: "replace-node", nodeId: parent.id, wikitext: replacement });
  }

  return { document, passthrough, structural };
}

function rangesOverlap(a: Pick<NamuAstAppliedChange, "sourceStart" | "sourceEnd">, b: Pick<NamuAstAppliedChange, "sourceStart" | "sourceEnd">) {
  const aInsert = a.sourceStart === a.sourceEnd;
  const bInsert = b.sourceStart === b.sourceEnd;
  if (aInsert && bInsert) return false;
  if (aInsert) return b.sourceStart < a.sourceStart && a.sourceStart < b.sourceEnd;
  if (bInsert) return a.sourceStart < b.sourceStart && b.sourceStart < a.sourceEnd;
  return a.sourceStart < b.sourceEnd && b.sourceStart < a.sourceEnd;
}

function validateStructuralPatches(structural: StructuralPatch[], baseChanges: NamuAstAppliedChange[]) {
  const sorted = [...structural].sort((a, b) => a.sourceStart - b.sourceStart || a.sourceEnd - b.sourceEnd || a.sequence - b.sequence);
  for (let index = 0; index < sorted.length; index += 1) {
    const patch = sorted[index];
    if (patch.sourceStart < 0 || patch.sourceEnd < patch.sourceStart) throw badRequest("Invalid structural source range");
    if (index && rangesOverlap(sorted[index - 1], patch)) throw badRequest("Overlapping structural edits are not allowed");
    if (baseChanges.some((change) => rangesOverlap(change, patch))) {
      throw badRequest(`A structural ${patch.op} overlaps another visual edit. Revert the block edit before deleting or restructuring it.`);
    }
  }
}

function deltaBefore(position: number, changes: NamuAstAppliedChange[]) {
  let delta = 0;
  for (const change of changes) {
    if (change.sourceEnd <= position) delta += change.after.length - change.before.length;
  }
  return delta;
}

function applyStructuralPatches(sourceAfterBase: string, structural: StructuralPatch[], baseChanges: NamuAstAppliedChange[]) {
  const adjusted = structural.map((patch) => ({
    ...patch,
    adjustedStart: patch.sourceStart + deltaBefore(patch.sourceStart, baseChanges),
    adjustedEnd: patch.sourceEnd + deltaBefore(patch.sourceEnd, baseChanges),
  }));
  let proposed = sourceAfterBase;
  for (const patch of [...adjusted].sort((a, b) => b.adjustedStart - a.adjustedStart || b.adjustedEnd - a.adjustedEnd || b.sequence - a.sequence)) {
    if (patch.before && proposed.slice(patch.adjustedStart, patch.adjustedEnd) !== patch.before) {
      throw conflict(`Source range for ${patch.nodeType} changed while applying structural edits. Reload and try again.`);
    }
    proposed = `${proposed.slice(0, patch.adjustedStart)}${patch.after}${proposed.slice(patch.adjustedEnd)}`;
  }
  return proposed;
}

export function applyNamuAstOperationsComplete(source: string, operations: NamuAstCompleteEditOperation[]) {
  if (!Array.isArray(operations) || !operations.length) throw badRequest("No AST edit operations were supplied");
  if (operations.length > 500) throw badRequest("Too many AST edit operations in one proposal");

  const { document, passthrough, structural } = preprocessInlineOperations(source, operations);
  let proposed = source;
  let baseChanges: NamuAstAppliedChange[] = [];

  if (passthrough.length) {
    const result = applyNamuAstOperations(source, passthrough);
    proposed = result.proposed;
    baseChanges = result.changes;
  }

  validateStructuralPatches(structural, baseChanges);
  if (structural.length) proposed = applyStructuralPatches(proposed, structural, baseChanges);

  const structuralChanges = structural.map(({ sequence: _sequence, ...change }) => change);
  const changes = [...baseChanges, ...structuralChanges].filter((change) => change.before !== change.after);
  if (!changes.length) throw badRequest("No changes were made");

  const afterAst = parseNamuMarkAstForEditing(proposed);
  assertEditingAstLossless(proposed, afterAst);
  return {
    proposed,
    changes,
    beforeAst: document,
    afterAst,
  };
}
