export type NamuMediaKind = "file" | "youtube" | "video-macro";

export type NamuMediaParam = {
  id: string;
  index: number;
  name: string | null;
  positional: boolean;
  sourceStart: number;
  sourceEnd: number;
  valueStart: number;
  valueEnd: number;
  delimiterStart: number;
  raw: string;
  valueRaw: string;
  editable: boolean;
  lockedReason: string | null;
};

export type NamuMediaModel = {
  kind: NamuMediaKind;
  macroName: string;
  raw: string;
  sourceStart: number;
  sourceEnd: number;
  target: string;
  targetStart: number;
  targetEnd: number;
  params: NamuMediaParam[];
  paramCount: number;
  editableParamCount: number;
  insertAt: number;
  appendSeparator: string;
};

export type NamuMediaChanges = {
  target?: string;
  params?: Array<{ paramId: string; proposedValue: string }>;
  removeParamIds?: string[];
  appendParams?: Array<{ name: string; value: string }>;
};

function tinyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function bad(message: string): never {
  throw new Error(message);
}

function trimRange(source: string, start: number, end: number) {
  while (start < end && /\s/.test(source[start])) start += 1;
  while (end > start && /\s/.test(source[end - 1])) end -= 1;
  return { start, end };
}

function findDoubleSquareEnd(source: string, start: number, limit: number) {
  let depth = 0;
  for (let cursor = start; cursor < limit - 1; cursor += 1) {
    if (source.startsWith("[[", cursor)) {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (source.startsWith("]]", cursor)) {
      depth -= 1;
      if (depth === 0) return cursor + 2;
      cursor += 1;
    }
  }
  return -1;
}

function findSingleBracketEnd(source: string, start: number, limit: number) {
  let depth = 0;
  for (let cursor = start; cursor < limit; cursor += 1) {
    if (source.startsWith("[[", cursor)) {
      const close = findDoubleSquareEnd(source, cursor, limit);
      if (close < 0) return -1;
      cursor = close - 1;
      continue;
    }
    if (source[cursor] === "[") depth += 1;
    else if (source[cursor] === "]") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

type Segment = { start: number; end: number; delimiterStart: number };

function splitTopLevel(source: string, start: number, end: number, delimiter: "|" | ",") {
  const segments: Segment[] = [];
  let segmentStart = start;
  let delimiterStart = start;
  let squareDepth = 0;
  let curlyDepth = 0;
  let parenDepth = 0;

  for (let cursor = start; cursor < end; cursor += 1) {
    if (source.startsWith("[[", cursor)) {
      squareDepth += 1;
      cursor += 1;
      continue;
    }
    if (source.startsWith("]]", cursor) && squareDepth > 0) {
      squareDepth -= 1;
      cursor += 1;
      continue;
    }
    if (source.startsWith("{{{", cursor)) {
      curlyDepth += 1;
      cursor += 2;
      continue;
    }
    if (source.startsWith("}}}", cursor) && curlyDepth > 0) {
      curlyDepth -= 1;
      cursor += 2;
      continue;
    }
    if (source[cursor] === "(") parenDepth += 1;
    else if (source[cursor] === ")" && parenDepth > 0) parenDepth -= 1;

    if (source[cursor] === delimiter && squareDepth === 0 && curlyDepth === 0 && parenDepth === 0) {
      segments.push({ start: segmentStart, end: cursor, delimiterStart });
      delimiterStart = cursor;
      segmentStart = cursor + 1;
    }
  }
  segments.push({ start: segmentStart, end, delimiterStart });
  return segments;
}

function topLevelEquals(source: string, start: number, end: number) {
  let squareDepth = 0;
  let curlyDepth = 0;
  let parenDepth = 0;
  for (let cursor = start; cursor < end; cursor += 1) {
    if (source.startsWith("[[", cursor)) { squareDepth += 1; cursor += 1; continue; }
    if (source.startsWith("]]", cursor) && squareDepth > 0) { squareDepth -= 1; cursor += 1; continue; }
    if (source.startsWith("{{{", cursor)) { curlyDepth += 1; cursor += 2; continue; }
    if (source.startsWith("}}}", cursor) && curlyDepth > 0) { curlyDepth -= 1; cursor += 2; continue; }
    if (source[cursor] === "(") parenDepth += 1;
    else if (source[cursor] === ")" && parenDepth > 0) parenDepth -= 1;
    else if (source[cursor] === "=" && squareDepth === 0 && curlyDepth === 0 && parenDepth === 0) return cursor;
  }
  return -1;
}

function mediaParam(source: string, segment: Segment, index: number, kind: NamuMediaKind): NamuMediaParam {
  const trimmed = trimRange(source, segment.start, segment.end);
  const equals = topLevelEquals(source, trimmed.start, trimmed.end);
  let name: string | null = null;
  let valueStart = trimmed.start;
  let valueEnd = trimmed.end;
  if (equals >= 0) {
    const nameRange = trimRange(source, trimmed.start, equals);
    const valueRange = trimRange(source, equals + 1, trimmed.end);
    name = source.slice(nameRange.start, nameRange.end);
    valueStart = valueRange.start;
    valueEnd = valueRange.end;
  }
  const valueRaw = source.slice(valueStart, valueEnd);
  let lockedReason: string | null = null;
  if (!name) lockedReason = "Positional or flag-style media option is preserved as source";
  else if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(name)) lockedReason = "Complex media option name";
  else if (/\r|\n/.test(valueRaw)) lockedReason = "Multiline media option";
  else if (kind === "file" && /\||\]\]/.test(valueRaw)) lockedReason = "Nested file option syntax";
  else if (kind !== "file" && /,|\)\]/.test(valueRaw)) lockedReason = "Nested macro option syntax";

  return {
    id: `media-param:${index}:${trimmed.start}:${trimmed.end}:${tinyHash(source.slice(trimmed.start, trimmed.end))}`,
    index,
    name,
    positional: !name,
    sourceStart: trimmed.start,
    sourceEnd: trimmed.end,
    valueStart,
    valueEnd,
    delimiterStart: segment.delimiterStart,
    raw: source.slice(trimmed.start, trimmed.end),
    valueRaw,
    editable: !lockedReason,
    lockedReason,
  };
}

function parseFile(source: string, open: number): NamuMediaModel | null {
  if (!source.startsWith("[[", open)) return null;
  const close = findDoubleSquareEnd(source, open, source.length);
  if (close < 0) bad("Unclosed file link");
  const innerStart = open + 2;
  const innerEnd = close - 2;
  const segments = splitTopLevel(source, innerStart, innerEnd, "|");
  const first = trimRange(source, segments[0].start, segments[0].end);
  const targetRaw = source.slice(first.start, first.end);
  const match = targetRaw.match(/^((?:파일|File):)([\s\S]*)$/i);
  if (!match) return null;
  const prefixLength = match[1].length;
  const targetRegion = trimRange(source, first.start + prefixLength, first.end);
  const target = source.slice(targetRegion.start, targetRegion.end);
  if (!target) bad("File target is empty");
  const params = segments.slice(1).map((segment, index) => mediaParam(source, segment, index + 1, "file"));
  return {
    kind: "file",
    macroName: match[1].slice(0, -1),
    raw: source,
    sourceStart: open,
    sourceEnd: close,
    target,
    targetStart: targetRegion.start,
    targetEnd: targetRegion.end,
    params,
    paramCount: params.length,
    editableParamCount: params.filter((param) => param.editable).length,
    insertAt: innerEnd,
    appendSeparator: "|",
  };
}

function parseVideoMacro(source: string, open: number): NamuMediaModel | null {
  const head = source.slice(open).match(/^\[(youtube|kakaotv|nicovideo|vimeo)\(/i);
  if (!head) return null;
  const close = findSingleBracketEnd(source, open, source.length);
  if (close < 0) bad("Unclosed video macro");
  let parenClose = close - 2;
  while (parenClose > open && /\s/.test(source[parenClose])) parenClose -= 1;
  if (source[parenClose] !== ")") bad("Video macro is missing a closing parenthesis");
  const argsStart = open + head[0].length;
  const argsEnd = parenClose;
  const segments = splitTopLevel(source, argsStart, argsEnd, ",");
  const targetRegion = trimRange(source, segments[0].start, segments[0].end);
  const target = source.slice(targetRegion.start, targetRegion.end);
  if (!target) bad("Video target is empty");
  const macroName = head[1];
  const kind: NamuMediaKind = macroName.toLowerCase() === "youtube" ? "youtube" : "video-macro";
  const params = segments.slice(1).map((segment, index) => mediaParam(source, segment, index + 1, kind));
  const afterTarget = source.slice(targetRegion.end, argsEnd);
  const appendSeparator = /,\s/.test(afterTarget) ? ", " : ",";
  return {
    kind,
    macroName,
    raw: source,
    sourceStart: open,
    sourceEnd: close,
    target,
    targetStart: targetRegion.start,
    targetEnd: targetRegion.end,
    params,
    paramCount: params.length,
    editableParamCount: params.filter((param) => param.editable).length,
    insertAt: argsEnd,
    appendSeparator,
  };
}

export function parseNamuMediaAst(raw: string): NamuMediaModel {
  const start = raw.search(/\S/);
  if (start < 0) bad("Media source is empty");
  const file = parseFile(raw, start);
  if (file) return file;
  const video = parseVideoMacro(raw, start);
  if (video) return video;
  bad("Unsupported NamuMark media source");
}

function cleanTarget(kind: NamuMediaKind, value: unknown) {
  const target = String(value ?? "").normalize("NFKC").trim();
  if (!target || target.length > 4000 || /\r|\n/.test(target)) bad("Media target is invalid");
  if (kind === "file" && /\||\]\]/.test(target)) bad("File target contains NamuMark control syntax");
  if (kind !== "file" && /,|\)\]/.test(target)) bad("Video target contains macro control syntax");
  return target;
}

function cleanParamName(value: unknown) {
  const name = String(value ?? "").trim();
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(name)) bad("Media option name is invalid");
  return name;
}

function cleanParamValue(kind: NamuMediaKind, value: unknown) {
  const text = String(value ?? "").trim();
  if (text.length > 4000 || /\r|\n/.test(text)) bad("Media option value is invalid");
  if (kind === "file" && /\||\]\]/.test(text)) bad("File option contains NamuMark control syntax");
  if (kind !== "file" && /,|\)\]/.test(text)) bad("Video option contains macro control syntax");
  return text;
}

type Patch = { start: number; end: number; value: string };

function applyPatches(source: string, patches: Patch[]) {
  const sorted = [...patches].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) bad("Overlapping media edits are not allowed");
  }
  let output = source;
  for (const patch of [...sorted].sort((a, b) => b.start - a.start || b.end - a.end)) {
    output = `${output.slice(0, patch.start)}${patch.value}${output.slice(patch.end)}`;
  }
  return output;
}

export function applyNamuMediaChanges(raw: string, changes: NamuMediaChanges) {
  const model = parseNamuMediaAst(raw);
  const patches: Patch[] = [];
  const removed = new Set(Array.isArray(changes.removeParamIds) ? changes.removeParamIds : []);

  if (changes.target !== undefined) {
    const target = cleanTarget(model.kind, changes.target);
    if (target !== model.target) patches.push({ start: model.targetStart, end: model.targetEnd, value: target });
  }

  for (const change of Array.isArray(changes.params) ? changes.params : []) {
    const param = model.params.find((item) => item.id === change.paramId);
    if (!param) bad(`Media option ${change.paramId} no longer exists`);
    if (removed.has(param.id)) bad("A media option cannot be edited and removed in the same operation");
    if (!param.editable) bad(param.lockedReason || "This media option is protected");
    const value = cleanParamValue(model.kind, change.proposedValue);
    if (value !== param.valueRaw) patches.push({ start: param.valueStart, end: param.valueEnd, value });
  }

  for (const id of removed) {
    const param = model.params.find((item) => item.id === id);
    if (!param) bad(`Media option ${id} no longer exists`);
    patches.push({ start: param.delimiterStart, end: param.sourceEnd, value: "" });
  }

  const append = Array.isArray(changes.appendParams) ? changes.appendParams : [];
  if (append.length > 20) bad("Too many media options were added at once");
  if (append.length) {
    const serialized = append.map((item) => `${cleanParamName(item.name)}=${cleanParamValue(model.kind, item.value)}`).join(model.appendSeparator);
    patches.push({ start: model.insertAt, end: model.insertAt, value: `${model.appendSeparator}${serialized}` });
  }

  const proposed = applyPatches(raw, patches);
  const after = parseNamuMediaAst(proposed);
  if (after.kind !== model.kind || after.macroName.toLowerCase() !== model.macroName.toLowerCase()) {
    bad("Media edit changed the structural media type");
  }
  return { proposed, before: model, after };
}
