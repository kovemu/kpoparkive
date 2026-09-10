import { applyNamuTableFieldChanges, parseNamuTableAst } from "./namumarkTableAst";
import { applyNamuTemplateCallParamChanges, scanNamuTemplateCalls } from "./namumarkTemplateAst";

export type NamuTableStructuredChanges = {
  fields?: Array<{ fieldId: string; proposedWikitext: string }>;
  templateParams?: Array<{ callId: string; paramId: string; proposedValue: string }>;
};

type Replacement = {
  start: number;
  end: number;
  value: string;
  kind: "field" | "template-param";
  id: string;
};

function sameTableShape(beforeRaw: string, afterRaw: string) {
  const before = parseNamuTableAst(beforeRaw);
  const after = parseNamuTableAst(afterRaw);
  if (before.rowCount !== after.rowCount || before.cellCount !== after.cellCount) return false;
  if (before.rows.length !== after.rows.length) return false;
  return before.rows.every((row, index) => row.cells.length === after.rows[index]?.cells.length);
}

function sameTemplateShape(beforeRaw: string, afterRaw: string) {
  const before = scanNamuTemplateCalls(beforeRaw);
  const after = scanNamuTemplateCalls(afterRaw);
  if (before.length !== after.length) return false;
  return before.every((call, index) => {
    const next = after[index];
    if (!next || call.name !== next.name || call.params.length !== next.params.length) return false;
    return call.params.every((param, paramIndex) => {
      const nextParam = next.params[paramIndex];
      return Boolean(nextParam) && param.name === nextParam.name && param.positional === nextParam.positional;
    });
  });
}

export function applyNamuTableStructuredChanges(tableRaw: string, changes: NamuTableStructuredChanges) {
  const source = String(tableRaw ?? "");
  const replacements: Replacement[] = [];
  const changed: Array<{
    kind: "field" | "template-param";
    id: string;
    before: string;
    after: string;
    sourceStart: number;
    sourceEnd: number;
  }> = [];

  const fieldChanges = Array.isArray(changes.fields) ? changes.fields : [];
  if (fieldChanges.length) {
    const result = applyNamuTableFieldChanges(source, fieldChanges);
    const fieldMap = new Map(
      result.model.rows.flatMap((row) => row.cells.flatMap((cell) => cell.fields)).map((field) => [field.id, field]),
    );
    for (const item of result.changed) {
      const field = fieldMap.get(item.fieldId);
      if (!field) throw new Error("Table field range disappeared during validation");
      replacements.push({
        start: field.sourceStart,
        end: field.sourceEnd,
        value: item.after,
        kind: "field",
        id: item.fieldId,
      });
      changed.push({
        kind: "field",
        id: item.fieldId,
        before: item.before,
        after: item.after,
        sourceStart: field.sourceStart,
        sourceEnd: field.sourceEnd,
      });
    }
  }

  const templateParams = Array.isArray(changes.templateParams) ? changes.templateParams : [];
  if (templateParams.length) {
    const result = applyNamuTemplateCallParamChanges(source, templateParams);
    for (const item of result.changed) {
      replacements.push({
        start: item.sourceStart,
        end: item.sourceEnd,
        value: item.after,
        kind: "template-param",
        id: item.paramId,
      });
      changed.push({
        kind: "template-param",
        id: item.paramId,
        before: item.before,
        after: item.after,
        sourceStart: item.sourceStart,
        sourceEnd: item.sourceEnd,
      });
    }
  }

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let proposed = source;
  for (const replacement of replacements) {
    if (replacement.start < 0 || replacement.end < replacement.start || replacement.end > source.length) {
      throw new Error("Invalid table structured edit range");
    }
    if (replacement.end > previousStart) {
      throw new Error(`Overlapping table structured edits are not supported (${replacement.kind}:${replacement.id})`);
    }
    proposed = `${proposed.slice(0, replacement.start)}${replacement.value}${proposed.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  if (changed.length) {
    if (!sameTableShape(source, proposed)) {
      throw new Error("Table edit changed row/cell structure. Use the structural table editor instead.");
    }
    if (!sameTemplateShape(source, proposed)) {
      throw new Error("Table edit changed nested template structure. Use advanced source editing instead.");
    }
  }

  return { proposed, changed };
}
