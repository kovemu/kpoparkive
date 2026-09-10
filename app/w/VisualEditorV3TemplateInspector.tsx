"use client";

import { collectV3RegisteredOperations } from "./visualEditorV3OperationRegistry";

export type V3TemplateParam = {
  id: string;
  index: number;
  name: string | null;
  positional: boolean;
  sourceStart: number;
  sourceEnd: number;
  valueStart: number;
  valueEnd: number;
  raw: string;
  valueRaw: string;
  editable: boolean;
  lockedReason: string | null;
};

export type V3TemplateModel = {
  nodeId: string;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  name: string;
  paramCount: number;
  editableParamCount: number;
  params: V3TemplateParam[];
};

export type V3NestedTemplateCall = {
  id: string;
  index: number;
  sourceStart: number;
  sourceEnd: number;
  name: string;
  paramCount: number;
  editableParamCount: number;
  params: V3TemplateParam[];
};

export type V3TableTemplateOwner = {
  nodeId: string;
  sectionIndex: number;
  templateCalls?: V3NestedTemplateCall[];
};

export type V3TemplateTarget = {
  key: string;
  ownerType: "document" | "table";
  ownerNodeId: string;
  callId: string | null;
  sectionIndex: number;
  name: string;
  paramCount: number;
  editableParamCount: number;
  params: V3TemplateParam[];
};

export type V3TemplateDrafts = Record<string, Record<string, string>>;

export type V3TemplateFieldOperation = {
  op: "template-fields";
  nodeId: string;
  changes: Array<{ paramId: string; proposedValue: string }>;
};

export type V3TableTemplateChange = {
  callId: string;
  paramId: string;
  proposedValue: string;
};

export function createV3TemplateTargets(templates: V3TemplateModel[], tables: V3TableTemplateOwner[]): V3TemplateTarget[] {
  const standalone = templates.map((template) => ({
    key: `document:${template.nodeId}`,
    ownerType: "document" as const,
    ownerNodeId: template.nodeId,
    callId: null,
    sectionIndex: template.sectionIndex,
    name: template.name,
    paramCount: template.paramCount,
    editableParamCount: template.editableParamCount,
    params: template.params,
  }));
  const nested = tables.flatMap((table) => (table.templateCalls || []).map((call) => ({
    key: `table:${table.nodeId}:${call.id}`,
    ownerType: "table" as const,
    ownerNodeId: table.nodeId,
    callId: call.id,
    sectionIndex: table.sectionIndex,
    name: call.name,
    paramCount: call.paramCount,
    editableParamCount: call.editableParamCount,
    params: call.params,
  })));
  return [...standalone, ...nested];
}

function asTargets(items: Array<V3TemplateTarget | V3TemplateModel>): V3TemplateTarget[] {
  return items.map((item) => "key" in item ? item : ({
    key: `document:${item.nodeId}`,
    ownerType: "document" as const,
    ownerNodeId: item.nodeId,
    callId: null,
    sectionIndex: item.sectionIndex,
    name: item.name,
    paramCount: item.paramCount,
    editableParamCount: item.editableParamCount,
    params: item.params,
  }));
}

export function createV3TemplateDrafts(items: Array<V3TemplateTarget | V3TemplateModel>): V3TemplateDrafts {
  const drafts: V3TemplateDrafts = {};
  for (const target of asTargets(items)) {
    drafts[target.key] = Object.fromEntries(target.params.map((param) => [param.id, param.valueRaw]));
    if (target.ownerType === "document") drafts[target.ownerNodeId] = drafts[target.key];
  }
  return drafts;
}

export function collectV3TemplateEdits(targets: V3TemplateTarget[], drafts: V3TemplateDrafts) {
  const standalone: V3TemplateFieldOperation[] = [];
  const tableParams = new Map<string, V3TableTemplateChange[]>();

  for (const target of targets) {
    const targetDraft = drafts[target.key] || drafts[target.ownerNodeId] || {};
    const changes = target.params
      .filter((param) => param.editable)
      .map((param) => ({ param, proposedValue: targetDraft[param.id] ?? param.valueRaw }))
      .filter(({ param, proposedValue }) => proposedValue !== param.valueRaw);
    if (!changes.length) continue;

    if (target.ownerType === "document") {
      standalone.push({
        op: "template-fields",
        nodeId: target.ownerNodeId,
        changes: changes.map(({ param, proposedValue }) => ({ paramId: param.id, proposedValue })),
      });
      continue;
    }

    if (!target.callId) continue;
    const current = tableParams.get(target.ownerNodeId) || [];
    current.push(...changes.map(({ param, proposedValue }) => ({
      callId: target.callId!,
      paramId: param.id,
      proposedValue,
    })));
    tableParams.set(target.ownerNodeId, current);
  }

  // FullPageVisualEditorV3 already funnels this array directly into its single
  // atomic POST. Auxiliary AST editors register here so media/footnote/
  // structural changes share the same proposal instead of creating parallel saves.
  const auxiliary = collectV3RegisteredOperations();
  for (const operation of auxiliary) standalone.push(operation as unknown as V3TemplateFieldOperation);

  return { standalone, tableParams };
}

export function collectV3TemplateOperations(templates: V3TemplateModel[], drafts: V3TemplateDrafts): V3TemplateFieldOperation[] {
  return collectV3TemplateEdits(createV3TemplateTargets(templates, []), drafts).standalone;
}

function templateLabel(template: V3TemplateTarget, index: number) {
  const short = template.name.replace(/^틀:/, "");
  const owner = template.ownerType === "table" ? "table" : "page";
  return `${index + 1}. ${short} · §${template.sectionIndex} · ${owner}`;
}

export default function VisualEditorV3TemplateInspector({
  open,
  targets,
  templates,
  selectedKey,
  selectedNodeId,
  drafts,
  onClose,
  onSelect,
  onChange,
  onRevealSection,
}: {
  open: boolean;
  targets?: V3TemplateTarget[];
  templates?: V3TemplateModel[];
  selectedKey?: string | null;
  selectedNodeId?: string | null;
  drafts: V3TemplateDrafts;
  onClose: () => void;
  onSelect: (key: string) => void;
  onChange: (targetKey: string, paramId: string, value: string) => void;
  onRevealSection: (sectionIndex: number) => void;
}) {
  if (!open) return null;
  const resolvedTargets = targets || createV3TemplateTargets(templates || [], []);
  const parameterized = resolvedTargets.filter((target) => target.paramCount > 0);
  const requested = selectedKey || (selectedNodeId ? `document:${selectedNodeId}` : null);
  const selected = parameterized.find((target) => target.key === requested || target.ownerNodeId === selectedNodeId) || parameterized[0] || null;

  return (
    <aside className="kpoparkiveAstTemplatePanel" aria-label="Template parameter inspector">
      <div className="kpoparkiveAstTemplatePanelHeader">
        <div>
          <strong>Template inspector</strong>
          <span>Exact AST parameters · page + table calls</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close template inspector">×</button>
      </div>

      {!selected ? (
        <div className="kpoparkiveAstTemplateEmpty">This page has no template parameters that can be edited here.</div>
      ) : (
        <>
          <div className="kpoparkiveAstTemplatePicker">
            <select value={selected.key} onChange={(event) => onSelect(event.target.value)} aria-label="Template call">
              {parameterized.map((template, index) => (
                <option key={template.key} value={template.key}>{templateLabel(template, index)}</option>
              ))}
            </select>
            <button type="button" onClick={() => onRevealSection(selected.sectionIndex)}>Go to section</button>
          </div>

          <div className="kpoparkiveAstTemplateMeta">
            <b>{selected.name}</b>
            <span>
              {selected.editableParamCount}/{selected.paramCount} parameters editable · {selected.ownerType === "table" ? "inside table" : "standalone call"}
            </span>
          </div>

          <div className="kpoparkiveAstTemplateFields">
            {selected.params.map((param) => {
              const value = drafts[selected.key]?.[param.id] ?? drafts[selected.ownerNodeId]?.[param.id] ?? param.valueRaw;
              return (
                <label key={param.id} className={param.editable ? "" : "locked"}>
                  <span className="kpoparkiveAstTemplateFieldName">
                    {param.name || `#${param.index}`}
                    {param.positional ? <small>positional</small> : null}
                  </span>
                  <input
                    type="text"
                    value={value}
                    disabled={!param.editable}
                    onChange={(event) => onChange(selected.key, param.id, event.target.value)}
                    spellCheck={false}
                  />
                  {!param.editable ? <small className="kpoparkiveAstTemplateLock">Protected · {param.lockedReason || "complex source"}</small> : null}
                </label>
              );
            })}
          </div>

          <p className="kpoparkiveAstTemplateNote">
            Only this page&apos;s <code>[include(...)]</code> argument values are changed. Generated template body text is never rewritten from the calling page.
          </p>
        </>
      )}
    </aside>
  );
}
