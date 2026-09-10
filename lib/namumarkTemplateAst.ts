export type NamuTemplateParam = {
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

export type NamuTemplateAst = {
  version: 1;
  name: string;
  sourceStart: number;
  sourceEnd: number;
  includeStart: number;
  includeEnd: number;
  nameStart: number;
  nameEnd: number;
  paramCount: number;
  editableParamCount: number;
  params: NamuTemplateParam[];
};

export type NamuTemplateCall = {
  id: string;
  index: number;
  sourceStart: number;
  sourceEnd: number;
  raw: string;
  name: string;
  paramCount: number;
  editableParamCount: number;
  params: NamuTemplateParam[];
};

type Span = { start: number; end: number };

type ScanState = {
  square: number;
  curly: number;
  paren: number;
  doubleQuote: boolean;
};

function tinyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function id(kind: string, index: number, start: number, end: number, raw: string) {
  return `nmp:${kind}:${index}:${start}:${end}:${tinyHash(raw)}`;
}

function trimmedBounds(source: string, start: number, end: number) {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

function advanceState(source: string, index: number, limit: number, state: ScanState) {
  const char = source[index];
  const pair = source.slice(index, Math.min(limit, index + 2));
  const triple = source.slice(index, Math.min(limit, index + 3));

  if (state.doubleQuote) {
    if (char === '"' && source[index - 1] !== "\\") state.doubleQuote = false;
    return 0;
  }
  if (char === '"') {
    state.doubleQuote = true;
    return 0;
  }
  if (triple === "{{{") {
    state.curly += 1;
    return 2;
  }
  if (triple === "}}}" && state.curly > 0) {
    state.curly -= 1;
    return 2;
  }
  if (pair === "[[") {
    state.square += 1;
    return 1;
  }
  if (pair === "]]" && state.square > 0) {
    state.square -= 1;
    return 1;
  }
  if (state.square === 0 && state.curly === 0) {
    if (char === "(") state.paren += 1;
    else if (char === ")" && state.paren > 0) state.paren -= 1;
  }
  return 0;
}

function topLevel(state: ScanState) {
  return state.square === 0 && state.curly === 0 && state.paren === 0 && !state.doubleQuote;
}

function findIncludeClose(source: string, openParen: number) {
  const state: ScanState = { square: 0, curly: 0, paren: 0, doubleQuote: false };
  for (let index = openParen + 1; index < source.length - 1; index += 1) {
    const char = source[index];
    if (topLevel(state) && char === ")" && source[index + 1] === "]") return index;
    index += advanceState(source, index, source.length, state);
  }
  return -1;
}

function splitTopLevel(source: string, start: number, end: number, delimiter: string) {
  const spans: Span[] = [];
  const state: ScanState = { square: 0, curly: 0, paren: 0, doubleQuote: false };
  let segmentStart = start;

  for (let index = start; index < end; index += 1) {
    if (topLevel(state) && source[index] === delimiter) {
      spans.push({ start: segmentStart, end: index });
      segmentStart = index + 1;
      continue;
    }
    index += advanceState(source, index, end, state);
  }
  spans.push({ start: segmentStart, end });
  return spans;
}

function findTopLevelEquals(source: string, start: number, end: number) {
  const state: ScanState = { square: 0, curly: 0, paren: 0, doubleQuote: false };
  for (let index = start; index < end; index += 1) {
    if (topLevel(state) && source[index] === "=") return index;
    index += advanceState(source, index, end, state);
  }
  return -1;
}

function lockedReason(value: string) {
  if (value.length > 20_000) return "Parameter is too large for visual editing";
  if (/\r|\n/.test(value)) return "Multiline parameter";
  if (/\[include\(/i.test(value)) return "Nested template call";
  if (/\{\{\{|\}\}\}/.test(value)) return "Structured NamuMark formatting";
  if (/\|\|/.test(value)) return "Nested table syntax";
  if (/\[\[(?:파일|File|분류|Category):/i.test(value)) return "File or metadata parameter";
  if (/\[(?:youtube|kakaotv|nicovideo|vimeo)\(/i.test(value)) return "Embedded media parameter";
  return null;
}

export function parseNamuTemplateAst(templateRaw: string): NamuTemplateAst {
  const source = String(templateRaw ?? "");
  const includeMatch = /\[include\(/i.exec(source);
  if (!includeMatch) throw new Error("Template block does not contain an include call");
  const includeStart = includeMatch.index;
  if (source.slice(0, includeStart).trim()) throw new Error("Unexpected source before template include");

  const openParen = includeStart + includeMatch[0].length - 1;
  const closeParen = findIncludeClose(source, openParen);
  if (closeParen < 0) throw new Error("Template include is not balanced");
  const includeEnd = closeParen + 2;
  if (source.slice(includeEnd).trim()) throw new Error("Unexpected source after template include");

  const innerStart = openParen + 1;
  const innerEnd = closeParen;
  const segments = splitTopLevel(source, innerStart, innerEnd, ",");
  if (!segments.length) throw new Error("Template name is missing");

  const nameBounds = trimmedBounds(source, segments[0].start, segments[0].end);
  const name = source.slice(nameBounds.start, nameBounds.end);
  if (!name) throw new Error("Template name is missing");

  const params: NamuTemplateParam[] = [];
  for (let segmentIndex = 1; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    const bounds = trimmedBounds(source, segment.start, segment.end);
    const equals = findTopLevelEquals(source, bounds.start, bounds.end);
    const positional = equals < 0;
    const nameBoundsForParam = positional ? null : trimmedBounds(source, bounds.start, equals);
    const valueBounds = positional ? bounds : trimmedBounds(source, equals + 1, bounds.end);
    const paramName = nameBoundsForParam ? source.slice(nameBoundsForParam.start, nameBoundsForParam.end) : null;
    const valueRaw = source.slice(valueBounds.start, valueBounds.end);
    const reason = lockedReason(valueRaw);
    const raw = source.slice(segment.start, segment.end);
    params.push({
      id: id("param", segmentIndex, segment.start, segment.end, raw),
      index: segmentIndex,
      name: paramName || null,
      positional,
      sourceStart: segment.start,
      sourceEnd: segment.end,
      valueStart: valueBounds.start,
      valueEnd: valueBounds.end,
      raw,
      valueRaw,
      editable: !reason,
      lockedReason: reason,
    });
  }

  return {
    version: 1,
    name,
    sourceStart: 0,
    sourceEnd: source.length,
    includeStart,
    includeEnd,
    nameStart: nameBounds.start,
    nameEnd: nameBounds.end,
    paramCount: params.length,
    editableParamCount: params.filter((param) => param.editable).length,
    params,
  };
}

function shiftedParam(param: NamuTemplateParam, offset: number, callIndex: number) {
  const sourceStart = param.sourceStart + offset;
  const sourceEnd = param.sourceEnd + offset;
  const valueStart = param.valueStart + offset;
  const valueEnd = param.valueEnd + offset;
  return {
    ...param,
    id: id("call-param", callIndex * 1000 + param.index, sourceStart, sourceEnd, param.raw),
    sourceStart,
    sourceEnd,
    valueStart,
    valueEnd,
  };
}

export function scanNamuTemplateCalls(sourceValue: string): NamuTemplateCall[] {
  const source = String(sourceValue ?? "");
  const calls: NamuTemplateCall[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const match = /\[include\(/ig;
    match.lastIndex = cursor;
    const found = match.exec(source);
    if (!found) break;
    const start = found.index;
    const openParen = start + found[0].length - 1;
    const closeParen = findIncludeClose(source, openParen);
    if (closeParen < 0) {
      cursor = start + found[0].length;
      continue;
    }
    const end = closeParen + 2;
    const raw = source.slice(start, end);
    try {
      const model = parseNamuTemplateAst(raw);
      const callIndex = calls.length + 1;
      calls.push({
        id: id("call", callIndex, start, end, raw),
        index: callIndex,
        sourceStart: start,
        sourceEnd: end,
        raw,
        name: model.name,
        paramCount: model.paramCount,
        editableParamCount: model.editableParamCount,
        params: model.params.map((param) => shiftedParam(param, start, callIndex)),
      });
    } catch {
      // An unusual include expression stays opaque; continue scanning after it.
    }
    cursor = end;
  }
  return calls;
}

export function validateNamuTemplateParamValue(value: unknown) {
  const proposed = String(value ?? "");
  if (proposed.length > 20_000) throw new Error("Template parameter is too large");
  if (/\r|\n/.test(proposed)) throw new Error("Template parameter must stay on one line in visual mode");
  if (/\)\]/.test(proposed)) throw new Error("Template parameter cannot contain an include terminator");
  return proposed;
}

function sameShape(before: NamuTemplateAst, after: NamuTemplateAst) {
  if (before.name !== after.name || before.params.length !== after.params.length) return false;
  return before.params.every((param, index) => {
    const next = after.params[index];
    return Boolean(next) && param.positional === next.positional && param.name === next.name;
  });
}

function sameCallShape(before: NamuTemplateCall[], after: NamuTemplateCall[]) {
  if (before.length !== after.length) return false;
  return before.every((call, index) => {
    const next = after[index];
    if (!next || call.name !== next.name || call.params.length !== next.params.length) return false;
    return call.params.every((param, paramIndex) => {
      const nextParam = next.params[paramIndex];
      return Boolean(nextParam) && param.positional === nextParam.positional && param.name === nextParam.name;
    });
  });
}

export function applyNamuTemplateParamChanges(
  templateRaw: string,
  changes: Array<{ paramId: string; proposedValue: string }>,
) {
  const source = String(templateRaw ?? "");
  const model = parseNamuTemplateAst(source);
  const params = new Map(model.params.map((param) => [param.id, param]));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const changed: Array<{
    paramId: string;
    index: number;
    name: string | null;
    before: string;
    after: string;
  }> = [];

  for (const change of changes) {
    const param = params.get(change.paramId);
    if (!param) throw new Error("Template parameter no longer exists. Reload and try again.");
    if (!param.editable) throw new Error(`Template parameter is protected (${param.lockedReason || "unsupported structure"})`);
    const value = validateNamuTemplateParamValue(change.proposedValue);
    if (value === param.valueRaw) continue;
    replacements.push({ start: param.valueStart, end: param.valueEnd, value });
    changed.push({
      paramId: param.id,
      index: param.index,
      name: param.name,
      before: param.valueRaw,
      after: value,
    });
  }

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let proposed = source;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error("Overlapping template parameter edits are not supported");
    proposed = `${proposed.slice(0, replacement.start)}${replacement.value}${proposed.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  if (changed.length) {
    const reparsed = parseNamuTemplateAst(proposed);
    if (!sameShape(model, reparsed)) {
      throw new Error("Template edit changed the include structure. Use advanced source editing for structural changes.");
    }
  }
  return { model, proposed, changed };
}

export function applyNamuTemplateCallParamChanges(
  sourceValue: string,
  changes: Array<{ callId: string; paramId: string; proposedValue: string }>,
) {
  const source = String(sourceValue ?? "");
  const calls = scanNamuTemplateCalls(source);
  const callMap = new Map(calls.map((call) => [call.id, call]));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const changed: Array<{
    callId: string;
    paramId: string;
    name: string | null;
    before: string;
    after: string;
    sourceStart: number;
    sourceEnd: number;
  }> = [];

  for (const change of changes) {
    const call = callMap.get(change.callId);
    if (!call) throw new Error("Nested template call no longer exists. Reload and try again.");
    const param = call.params.find((item) => item.id === change.paramId);
    if (!param) throw new Error("Nested template parameter no longer exists. Reload and try again.");
    if (!param.editable) throw new Error(`Nested template parameter is protected (${param.lockedReason || "unsupported structure"})`);
    const value = validateNamuTemplateParamValue(change.proposedValue);
    if (value === param.valueRaw) continue;
    replacements.push({ start: param.valueStart, end: param.valueEnd, value });
    changed.push({
      callId: call.id,
      paramId: param.id,
      name: param.name,
      before: param.valueRaw,
      after: value,
      sourceStart: param.valueStart,
      sourceEnd: param.valueEnd,
    });
  }

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let proposed = source;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error("Overlapping nested template edits are not supported");
    proposed = `${proposed.slice(0, replacement.start)}${replacement.value}${proposed.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  if (changed.length) {
    const reparsed = scanNamuTemplateCalls(proposed);
    if (!sameCallShape(calls, reparsed)) {
      throw new Error("Nested template edit changed table/template structure. Use advanced source editing for structural changes.");
    }
  }
  return { calls, proposed, changed };
}
