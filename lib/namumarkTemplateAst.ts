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

type Span = { start: number; end: number };

type ScanState = {
  square: number;
  curly: number;
  paren: number;
  quote: string | null;
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

  if (state.quote) {
    if (char === state.quote && source[index - 1] !== "\\") state.quote = null;
    return 0;
  }
  if (char === '"' || char === "'") {
    state.quote = char;
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
  return state.square === 0 && state.curly === 0 && state.paren === 0 && !state.quote;
}

function findIncludeClose(source: string, openParen: number) {
  const state: ScanState = { square: 0, curly: 0, paren: 0, quote: null };
  for (let index = openParen + 1; index < source.length - 1; index += 1) {
    const char = source[index];
    if (topLevel(state) && char === ")" && source[index + 1] === "]") return index;
    index += advanceState(source, index, source.length, state);
  }
  return -1;
}

function splitTopLevel(source: string, start: number, end: number, delimiter: string) {
  const spans: Span[] = [];
  const state: ScanState = { square: 0, curly: 0, paren: 0, quote: null };
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
  const state: ScanState = { square: 0, curly: 0, paren: 0, quote: null };
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
    const valueBounds = positional
      ? bounds
      : trimmedBounds(source, equals + 1, bounds.end);
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

function validateProposedValue(value: unknown) {
  const proposed = String(value ?? "");
  if (proposed.length > 20_000) throw new Error("Template parameter is too large");
  if (/\r|\n/.test(proposed)) throw new Error("Template parameter must stay on one line in visual mode");
  if (/\)\]/.test(proposed)) throw new Error("Template parameter cannot contain a top-level include terminator");
  return proposed;
}

function sameShape(before: NamuTemplateAst, after: NamuTemplateAst) {
  if (before.name !== after.name || before.params.length !== after.params.length) return false;
  return before.params.every((param, index) => {
    const next = after.params[index];
    return Boolean(next) && param.positional === next.positional && param.name === next.name;
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
    const value = validateProposedValue(change.proposedValue);
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
