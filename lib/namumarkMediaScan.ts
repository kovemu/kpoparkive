import { applyNamuMediaChanges, parseNamuMediaAst, type NamuMediaChanges, type NamuMediaModel } from "./namumarkMediaAst";

export type NamuMediaCall = NamuMediaModel & { id: string };
export type NamuMediaCallChange = NamuMediaChanges & { callId: string };

function tinyHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function doubleSquareEnd(source: string, start: number) {
  let depth = 0;
  for (let cursor = start; cursor < source.length - 1; cursor += 1) {
    if (source.startsWith("[[", cursor)) { depth += 1; cursor += 1; continue; }
    if (source.startsWith("]]", cursor)) {
      depth -= 1;
      if (depth === 0) return cursor + 2;
      cursor += 1;
    }
  }
  return -1;
}

function singleBracketEnd(source: string, start: number) {
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    if (source.startsWith("[[", cursor)) {
      const end = doubleSquareEnd(source, cursor);
      if (end < 0) return -1;
      cursor = end - 1;
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

function shifted(callRaw: string, offset: number): NamuMediaCall {
  const model = parseNamuMediaAst(callRaw);
  return {
    ...model,
    id: `nmm:${offset}:${offset + callRaw.length}:${tinyHash(callRaw)}`,
    raw: callRaw,
    sourceStart: offset + model.sourceStart,
    sourceEnd: offset + model.sourceEnd,
    targetStart: offset + model.targetStart,
    targetEnd: offset + model.targetEnd,
    insertAt: offset + model.insertAt,
    params: model.params.map((param) => ({
      ...param,
      sourceStart: offset + param.sourceStart,
      sourceEnd: offset + param.sourceEnd,
      valueStart: offset + param.valueStart,
      valueEnd: offset + param.valueEnd,
      delimiterStart: offset + param.delimiterStart,
    })),
  };
}

export function scanNamuMediaCalls(sourceValue: string) {
  const source = String(sourceValue ?? "");
  const calls: NamuMediaCall[] = [];
  let cursor = 0;
  while (cursor < source.length) {
    if (/^\[\[(?:파일|File):/i.test(source.slice(cursor, cursor + 12))) {
      const end = doubleSquareEnd(source, cursor);
      if (end > cursor) {
        const raw = source.slice(cursor, end);
        try { calls.push(shifted(raw, cursor)); } catch { /* preserve unsupported file syntax */ }
        cursor = end;
        continue;
      }
    }

    if (/^\[(?:youtube|kakaotv|nicovideo|vimeo)\(/i.test(source.slice(cursor, cursor + 24))) {
      const end = singleBracketEnd(source, cursor);
      if (end > cursor) {
        const raw = source.slice(cursor, end);
        try { calls.push(shifted(raw, cursor)); } catch { /* preserve unsupported media macro */ }
        cursor = end;
        continue;
      }
    }
    cursor += 1;
  }
  return calls;
}

export function applyNamuMediaCallChanges(sourceValue: string, changes: NamuMediaCallChange[]) {
  const source = String(sourceValue ?? "");
  const calls = scanNamuMediaCalls(source);
  const callMap = new Map(calls.map((call) => [call.id, call]));
  const replacements: Array<{ start: number; end: number; value: string; callId: string; before: string }> = [];

  for (const change of Array.isArray(changes) ? changes : []) {
    const call = callMap.get(change.callId);
    if (!call) throw new Error(`Media call ${change.callId} no longer exists`);
    const result = applyNamuMediaChanges(call.raw, {
      target: change.target,
      params: change.params,
      removeParamIds: change.removeParamIds,
      appendParams: change.appendParams,
    });
    if (result.proposed === call.raw) continue;
    replacements.push({ start: call.sourceStart, end: call.sourceEnd, value: result.proposed, callId: call.id, before: call.raw });
  }

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let previousStart = Number.POSITIVE_INFINITY;
  let proposed = source;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error("Overlapping media call edits are not supported");
    if (source.slice(replacement.start, replacement.end) !== replacement.before) throw new Error("Media call source range changed during validation");
    proposed = `${proposed.slice(0, replacement.start)}${replacement.value}${proposed.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  return {
    proposed,
    calls,
    changed: replacements.map((replacement) => ({
      callId: replacement.callId,
      sourceStart: replacement.start,
      sourceEnd: replacement.end,
      before: replacement.before,
      after: replacement.value,
    })),
  };
}
