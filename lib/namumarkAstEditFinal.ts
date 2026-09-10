import { parseNamuMarkAstForEditing } from "./namumarkAstEditing";
import { applyNamuAstOperationsComplete, type NamuAstCompleteEditOperation } from "./namumarkAstEditComplete";
import { applyNamuTableLayoutChanges, type NamuTableLayoutAction } from "./namumarkTableLayoutEdit";
import { applyNamuTableStructuredChanges } from "./namumarkTableStructuredEdit";

export type NamuAstFinalEditOperation =
  | NamuAstCompleteEditOperation
  | { op: "table-layout"; nodeId: string; actions: NamuTableLayoutAction[] };

type TableStructureOperation = Extract<NamuAstCompleteEditOperation, { op: "table-structure" }>;
type TableFieldsOperation = Extract<NamuAstCompleteEditOperation, { op: "table-fields" }>;
type TableMediaOperation = Extract<NamuAstCompleteEditOperation, { op: "table-media" }>;
type DeleteNodeOperation = Extract<NamuAstCompleteEditOperation, { op: "delete-node" }>;

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409 });
}

function isLayout(operation: NamuAstFinalEditOperation): operation is Extract<NamuAstFinalEditOperation, { op: "table-layout" }> {
  return operation.op === "table-layout";
}

function isTableSibling(operation: NamuAstFinalEditOperation, nodeId: string): operation is TableStructureOperation | TableFieldsOperation | TableMediaOperation {
  return (operation.op === "table-structure" || operation.op === "table-fields" || operation.op === "table-media") && operation.nodeId === nodeId;
}

function combineLayoutTable(source: string, nodeId: string, operations: NamuAstFinalEditOperation[]) {
  const document = parseNamuMarkAstForEditing(source);
  const node = document.blocks.find((block) => block.id === nodeId);
  if (!node || node.type !== "table") throw conflict("The selected table no longer exists. Reload and try again.");

  const layouts = operations.filter((operation): operation is Extract<NamuAstFinalEditOperation, { op: "table-layout" }> => isLayout(operation) && operation.nodeId === nodeId);
  if (!layouts.length) throw badRequest("No table layout operation was supplied");

  const actions = layouts.flatMap((operation) => Array.isArray(operation.actions) ? operation.actions : []);
  if (!actions.length) throw badRequest("No table layout actions were supplied");

  const fields: Array<{ fieldId: string; proposedWikitext: string }> = [];
  const templateParams: Array<{ callId: string; paramId: string; proposedValue: string }> = [];
  const mediaCalls: any[] = [];

  for (const operation of operations) {
    if (!isTableSibling(operation, nodeId)) continue;
    if (operation.op === "table-fields") fields.push(...(operation.changes || []));
    if (operation.op === "table-structure") {
      fields.push(...(operation.fields || []));
      templateParams.push(...(operation.templateParams || []));
    }
    if (operation.op === "table-media") mediaCalls.push(...(operation.mediaCalls || []));
  }

  let raw = node.raw;
  if (fields.length || templateParams.length || mediaCalls.length) {
    raw = applyNamuTableStructuredChanges(raw, {
      fields: fields.length ? fields : undefined,
      templateParams: templateParams.length ? templateParams : undefined,
      mediaCalls: mediaCalls.length ? mediaCalls : undefined,
    }).proposed;
  }
  return applyNamuTableLayoutChanges(raw, actions).proposed;
}

export function applyNamuAstOperationsFinal(source: string, operations: NamuAstFinalEditOperation[]) {
  if (!Array.isArray(operations) || !operations.length) throw badRequest("No AST edit operations were supplied");
  if (operations.length > 500) throw badRequest("Too many AST edit operations in one proposal");

  const deleted = new Set(
    operations
      .filter((operation): operation is DeleteNodeOperation => operation.op === "delete-node")
      .map((operation) => operation.nodeId),
  );

  const layoutNodeIds = Array.from(new Set(
    operations
      .filter((operation): operation is Extract<NamuAstFinalEditOperation, { op: "table-layout" }> => isLayout(operation))
      .map((operation) => operation.nodeId)
      .filter((nodeId) => !deleted.has(nodeId)),
  ));

  if (!layoutNodeIds.length) return applyNamuAstOperationsComplete(source, operations as NamuAstCompleteEditOperation[]);

  const replacements = new Map<string, string>();
  for (const nodeId of layoutNodeIds) replacements.set(nodeId, combineLayoutTable(source, nodeId, operations));

  const consumed = new Set(layoutNodeIds);
  const normalized: NamuAstCompleteEditOperation[] = [];
  for (const operation of operations) {
    if (isLayout(operation)) continue;
    if ("nodeId" in operation && consumed.has(operation.nodeId)) {
      if (operation.op === "delete-node") normalized.push(operation);
      else if (operation.op === "table-structure" || operation.op === "table-fields" || operation.op === "table-media") continue;
      else if (operation.op === "replace-raw") throw badRequest("Table layout cannot be combined with Advanced raw replacement on the same table");
      else normalized.push(operation as NamuAstCompleteEditOperation);
      continue;
    }
    normalized.push(operation as NamuAstCompleteEditOperation);
  }

  for (const [nodeId, wikitext] of replacements.entries()) {
    if (!deleted.has(nodeId)) normalized.push({ op: "replace-raw", nodeId, wikitext });
  }

  return applyNamuAstOperationsComplete(source, normalized);
}
