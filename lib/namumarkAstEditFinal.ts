import { parseNamuMarkAstForEditing } from "./namumarkAstEditing";
import { applyNamuAstOperationsComplete, type NamuAstCompleteEditOperation } from "./namumarkAstEditCompleteBase";
import { applyNamuTableLayoutChanges, type NamuTableLayoutAction } from "./namumarkTableLayoutEdit";
import { applyNamuTableCellStyleChanges, type NamuTableCellStyleChange } from "./namumarkTableStyleEdit";
import { applyNamuTableStructuredChanges } from "./namumarkTableStructuredEdit";

export type NamuAstFinalEditOperation =
  | NamuAstCompleteEditOperation
  | { op: "table-layout"; nodeId: string; actions: NamuTableLayoutAction[] }
  | { op: "table-cell-style"; nodeId: string; changes: NamuTableCellStyleChange[] };

type TableStructureOperation = Extract<NamuAstCompleteEditOperation, { op: "table-structure" }>;
type TableFieldsOperation = Extract<NamuAstCompleteEditOperation, { op: "table-fields" }>;
type TableMediaOperation = Extract<NamuAstCompleteEditOperation, { op: "table-media" }>;
type DeleteNodeOperation = Extract<NamuAstCompleteEditOperation, { op: "delete-node" }>;
type LayoutOperation = Extract<NamuAstFinalEditOperation, { op: "table-layout" }>;
type StyleOperation = Extract<NamuAstFinalEditOperation, { op: "table-cell-style" }>;

function badRequest(message: string) {
  return Object.assign(new Error(message), { status: 400 });
}

function conflict(message: string) {
  return Object.assign(new Error(message), { status: 409 });
}

function isLayout(operation: NamuAstFinalEditOperation): operation is LayoutOperation {
  return operation.op === "table-layout";
}

function isStyle(operation: NamuAstFinalEditOperation): operation is StyleOperation {
  return operation.op === "table-cell-style";
}

function isTableSibling(
  operation: NamuAstFinalEditOperation,
  nodeId: string,
): operation is TableStructureOperation | TableFieldsOperation | TableMediaOperation {
  return (
    (operation.op === "table-structure" || operation.op === "table-fields" || operation.op === "table-media") &&
    operation.nodeId === nodeId
  );
}

function combineTable(source: string, nodeId: string, operations: NamuAstFinalEditOperation[]) {
  const document = parseNamuMarkAstForEditing(source);
  const node = document.blocks.find((block) => block.id === nodeId);
  if (!node || node.type !== "table") throw conflict("The selected table no longer exists. Reload and try again.");

  const fields: Array<{ fieldId: string; proposedWikitext: string }> = [];
  const templateParams: Array<{ callId: string; paramId: string; proposedValue: string }> = [];
  const mediaCalls: TableMediaOperation["mediaCalls"] = [];
  const styles: NamuTableCellStyleChange[] = [];
  const layouts: NamuTableLayoutAction[] = [];

  for (const operation of operations) {
    if (isTableSibling(operation, nodeId)) {
      if (operation.op === "table-fields") fields.push(...(operation.changes || []));
      if (operation.op === "table-structure") {
        fields.push(...(operation.fields || []));
        templateParams.push(...(operation.templateParams || []));
      }
      if (operation.op === "table-media") mediaCalls.push(...(operation.mediaCalls || []));
      continue;
    }
    if (isStyle(operation) && operation.nodeId === nodeId) styles.push(...(operation.changes || []));
    if (isLayout(operation) && operation.nodeId === nodeId) layouts.push(...(operation.actions || []));
  }

  let raw = node.raw;
  if (fields.length || templateParams.length || mediaCalls.length) {
    raw = applyNamuTableStructuredChanges(raw, {
      fields: fields.length ? fields : undefined,
      templateParams: templateParams.length ? templateParams : undefined,
      mediaCalls: mediaCalls.length ? mediaCalls : undefined,
    }).proposed;
  }
  if (styles.length) raw = applyNamuTableCellStyleChanges(raw, styles).proposed;
  if (layouts.length) raw = applyNamuTableLayoutChanges(raw, layouts).proposed;
  return raw;
}

export function applyNamuAstOperationsFinal(source: string, operations: NamuAstFinalEditOperation[]) {
  if (!Array.isArray(operations) || !operations.length) throw badRequest("No AST edit operations were supplied");
  if (operations.length > 500) throw badRequest("Too many AST edit operations in one proposal");

  const deleted = new Set(
    operations
      .filter((operation): operation is DeleteNodeOperation => operation.op === "delete-node")
      .map((operation) => operation.nodeId),
  );

  const specialTableNodeIds = Array.from(new Set(
    operations
      .filter((operation): operation is LayoutOperation | StyleOperation => isLayout(operation) || isStyle(operation))
      .map((operation) => operation.nodeId)
      .filter((nodeId) => !deleted.has(nodeId)),
  ));

  if (!specialTableNodeIds.length) {
    const baseOnly = operations.filter((operation) => !isLayout(operation) && !isStyle(operation)) as NamuAstCompleteEditOperation[];
    return applyNamuAstOperationsComplete(source, baseOnly);
  }

  const replacements = new Map<string, string>();
  for (const nodeId of specialTableNodeIds) replacements.set(nodeId, combineTable(source, nodeId, operations));

  const consumed = new Set(specialTableNodeIds);
  const normalized: NamuAstCompleteEditOperation[] = [];
  for (const operation of operations) {
    if (isLayout(operation) || isStyle(operation)) continue;

    if ("nodeId" in operation && operation.nodeId && consumed.has(operation.nodeId)) {
      if (operation.op === "delete-node") {
        normalized.push(operation);
        continue;
      }
      if (operation.op === "table-structure" || operation.op === "table-fields" || operation.op === "table-media") continue;
      if (operation.op === "replace-raw") {
        throw badRequest("Table visual/style/layout changes cannot be combined with Advanced raw replacement on the same table");
      }
    }
    normalized.push(operation as NamuAstCompleteEditOperation);
  }

  for (const [nodeId, wikitext] of replacements.entries()) {
    if (!deleted.has(nodeId)) normalized.push({ op: "replace-raw", nodeId, wikitext });
  }
  return applyNamuAstOperationsComplete(source, normalized);
}
