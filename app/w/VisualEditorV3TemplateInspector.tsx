"use client";

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

export type V3TemplateDrafts = Record<string, Record<string, string>>;

export type V3TemplateFieldOperation = {
  op: "template-fields";
  nodeId: string;
  changes: Array<{ paramId: string; proposedValue: string }>;
};

export function createV3TemplateDrafts(templates: V3TemplateModel[]): V3TemplateDrafts {
  const drafts: V3TemplateDrafts = {};
  for (const template of templates) {
    drafts[template.nodeId] = Object.fromEntries(template.params.map((param) => [param.id, param.valueRaw]));
  }
  return drafts;
}

export function collectV3TemplateOperations(templates: V3TemplateModel[], drafts: V3TemplateDrafts): V3TemplateFieldOperation[] {
  const operations: V3TemplateFieldOperation[] = [];
  for (const template of templates) {
    const templateDraft = drafts[template.nodeId] || {};
    const changes = template.params
      .filter((param) => param.editable)
      .map((param) => ({ paramId: param.id, original: param.valueRaw, proposedValue: templateDraft[param.id] ?? param.valueRaw }))
      .filter((change) => change.proposedValue !== change.original)
      .map(({ paramId, proposedValue }) => ({ paramId, proposedValue }));
    if (changes.length) operations.push({ op: "template-fields", nodeId: template.nodeId, changes });
  }
  return operations;
}

function templateLabel(template: V3TemplateModel, index: number) {
  const short = template.name.replace(/^틀:/, "");
  return `${index + 1}. ${short} · §${template.sectionIndex}`;
}

export default function VisualEditorV3TemplateInspector({
  open,
  templates,
  selectedNodeId,
  drafts,
  onClose,
  onSelect,
  onChange,
  onRevealSection,
}: {
  open: boolean;
  templates: V3TemplateModel[];
  selectedNodeId: string | null;
  drafts: V3TemplateDrafts;
  onClose: () => void;
  onSelect: (nodeId: string) => void;
  onChange: (nodeId: string, paramId: string, value: string) => void;
  onRevealSection: (sectionIndex: number) => void;
}) {
  if (!open) return null;
  const editableTemplates = templates.filter((template) => template.paramCount > 0);
  const selected = editableTemplates.find((template) => template.nodeId === selectedNodeId) || editableTemplates[0] || null;

  return (
    <aside className="kpoparkiveAstTemplatePanel" aria-label="Template parameter inspector">
      <div className="kpoparkiveAstTemplatePanelHeader">
        <div>
          <strong>Template inspector</strong>
          <span>Exact AST parameters</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close template inspector">×</button>
      </div>

      {!selected ? (
        <div className="kpoparkiveAstTemplateEmpty">This page has no standalone template parameters that can be edited here.</div>
      ) : (
        <>
          <div className="kpoparkiveAstTemplatePicker">
            <select
              value={selected.nodeId}
              onChange={(event) => onSelect(event.target.value)}
              aria-label="Template call"
            >
              {editableTemplates.map((template, index) => (
                <option key={template.nodeId} value={template.nodeId}>{templateLabel(template, index)}</option>
              ))}
            </select>
            <button type="button" onClick={() => onRevealSection(selected.sectionIndex)}>Go to section</button>
          </div>

          <div className="kpoparkiveAstTemplateMeta">
            <b>{selected.name}</b>
            <span>{selected.editableParamCount}/{selected.paramCount} parameters editable</span>
          </div>

          <div className="kpoparkiveAstTemplateFields">
            {selected.params.map((param) => {
              const value = drafts[selected.nodeId]?.[param.id] ?? param.valueRaw;
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
                    onChange={(event) => onChange(selected.nodeId, param.id, event.target.value)}
                    spellCheck={false}
                  />
                  {!param.editable ? <small className="kpoparkiveAstTemplateLock">Protected · {param.lockedReason || "complex source"}</small> : null}
                </label>
              );
            })}
          </div>

          <p className="kpoparkiveAstTemplateNote">
            Only this page&apos;s <code>[include(...)]</code> argument values are changed. Text generated inside the template document stays untouched.
          </p>
        </>
      )}
    </aside>
  );
}
