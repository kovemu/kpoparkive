export type WikiInfoboxInputKind = "visual" | "text" | "date" | "color";

export type WikiInfoboxField = {
  key: string;
  label: string;
  group: string;
  inputKind: WikiInfoboxInputKind;
  valueWikitext: string;
  plainText: string;
  editable: boolean;
  lockedReason: string | null;
  lineIndex: number;
};

export type WikiInfoboxModel = {
  key: "lead-infobox";
  originalWikitext: string;
  fields: WikiInfoboxField[];
  editableCount: number;
  lockedCount: number;
  startLine: number;
  endLine: number;
};

type DateMacroSpan = {
  start: number;
  end: number;
  deltaDays: number;
};

type ParsedEditableField = WikiInfoboxField & {
  replaceStart: number;
  replaceEnd: number;
  mode: "literal" | "date";
  templateParam: boolean;
  dateMacroSpans?: DateMacroSpan[];
  dateLinked?: boolean;
};

type InternalInfoboxModel = Omit<WikiInfoboxModel, "fields"> & {
  fields: ParsedEditableField[];
};

type CellSpan = {
  text: string;
  start: number;
  end: number;
};

const HEADING_RE = /^(={2,6})\s*(.*?)\s*\1\s*$/;
const LEAD_END_RE = /^\s*(?:\[목차\]|\[clearfix\])\s*$/i;

const UNSAFE_VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\|\|/, "Nested table syntax"],
  [/\{\{\{|\}\}\}/, "Styled wiki block"],
  [/\[include\(/i, "Template include"],
  [/\[youtube\(/i, "Embedded media"],
  [/\[\[(?:파일|File):/i, "File/media field"],
  [/\[(?:age|dday)\(/i, "Dynamic macro"],
  [/\[clearfix\]/i, "Layout macro"],
  [/\[(?:목차|각주)\]/, "Document macro"],
];

function normalizeSource(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function countToken(value: string, token: string) {
  let count = 0;
  let from = 0;
  while (from < value.length) {
    const found = value.indexOf(token, from);
    if (found < 0) break;
    count += 1;
    from = found + token.length;
  }
  return count;
}

function stripCellOptions(value: string) {
  return value.replace(/^\s*(?:<[^>\n]*>\s*)+/, "").trim();
}

function stripInlineMarkup(value: string) {
  return value
    .replace(/\[br\]/gi, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, _target: string, label: string) => label)
    .replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => target)
    .replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, (_match, label: string) => label)
    .replace(/\[https?:\/\/[^\]]+\]/g, "")
    .replace(/\[\*[^\]]*\]/g, "")
    .replace(/'''|''|~~|\^\^/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function safeKeyPart(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase() || "field";
}

function unsafeReason(value: string) {
  if (!value.trim()) return "Empty value";
  if (value.includes("\n")) return "Multi-line field";
  for (const [pattern, reason] of UNSAFE_VALUE_PATTERNS) {
    if (pattern.test(value)) return reason;
  }
  return null;
}

function unsafeTemplateParamReason(value: string) {
  if (!value.trim()) return "Empty value";
  if (value.includes("\n")) return "Multi-line template parameter";
  if (value.includes(",")) return "Commas in template parameters are not supported yet";
  if (/\|\||\{\{\{|\}\}\}|\[include\(|\[youtube\(/i.test(value)) return "Nested structured wiki syntax";
  return null;
}

function lineOffsets(lines: string[]) {
  const offsets: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    offsets.push(cursor);
    cursor += line.length + 1;
  }
  return offsets;
}

function completeRowCells(line: string, lineStart: number): CellSpan[] | null {
  const first = line.indexOf("||");
  if (first < 0 || line.slice(0, first).trim()) return null;
  const positions: number[] = [];
  let cursor = first;
  while (cursor >= 0 && cursor < line.length) {
    positions.push(cursor);
    cursor = line.indexOf("||", cursor + 2);
  }
  if (positions.length < 2) return null;
  const last = positions[positions.length - 1];
  if (line.slice(last + 2).trim()) return null;

  const cells: CellSpan[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const start = positions[index] + 2;
    const end = positions[index + 1];
    cells.push({ text: line.slice(start, end), start: lineStart + start, end: lineStart + end });
  }
  return cells;
}

function firstCellFromLine(line: string) {
  const first = line.indexOf("||");
  if (first < 0 || line.slice(0, first).trim()) return null;
  const divider = line.indexOf("||", first + 2);
  if (divider < 0) return null;
  return line.slice(first + 2, divider);
}

function valueSpan(cell: CellSpan) {
  const optionMatch = cell.text.match(/^(\s*(?:<[^>\n]*>\s*)+)/);
  const optionPrefix = optionMatch?.[1] || "";
  const afterOptions = cell.text.slice(optionPrefix.length);
  const leading = afterOptions.match(/^\s*/)?.[0] || "";
  const trailing = afterOptions.match(/\s*$/)?.[0] || "";
  const start = cell.start + optionPrefix.length + leading.length;
  const end = cell.end - trailing.length;
  return {
    value: cell.text.slice(optionPrefix.length + leading.length, cell.text.length - trailing.length),
    start,
    end,
  };
}

function rowSpanCount(cellText: string) {
  const match = cellText.match(/<\|(\d+)>/);
  if (!match) return 1;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) && value > 1 ? value : 1;
}

function countryFromCell(cellText: string) {
  const match = cellText.match(/\[include\(\s*틀:국기\s*,[\s\S]*?국명\s*=\s*([^,\)\]]+)/i);
  return match?.[1]?.trim() || "";
}

function plausibleLabel(value: string) {
  const label = stripInlineMarkup(stripCellOptions(value));
  if (!label || label.length > 80) return "";
  if (/[{}\[\]|]/.test(label)) return "";
  return label;
}

function splitTopLevelSegments(value: string, delimiter: string) {
  const result: Array<{ start: number; end: number }> = [];
  let start = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")" && parenDepth > 0) parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
    else if (char === delimiter && parenDepth === 0 && bracketDepth === 0) {
      result.push({ start, end: index });
      start = index + 1;
    }
  }
  result.push({ start, end: value.length });
  return result;
}

function findTopLevelEquals(value: string) {
  let parenDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")" && parenDepth > 0) parenDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]" && bracketDepth > 0) bracketDepth -= 1;
    else if (char === "=" && parenDepth === 0 && bracketDepth === 0) return index;
  }
  return -1;
}

function parseIncludeParameters(
  value: string,
  absoluteStart: number,
  baseLabel: string,
  country: string,
  lineIndex: number,
): ParsedEditableField[] | null {
  const leading = value.match(/^\s*/)?.[0].length || 0;
  const trailing = value.match(/\s*$/)?.[0].length || 0;
  const trimmed = value.slice(leading, value.length - trailing);
  const match = trimmed.match(/^\[include\(([\s\S]*)\)\]$/i);
  if (!match) return null;

  const body = match[1];
  const bodyOffset = leading + trimmed.indexOf(body);
  const segments = splitTopLevelSegments(body, ",");
  if (segments.length < 2) return null;
  const templateName = body.slice(segments[0].start, segments[0].end).trim();
  if (!templateName) return null;

  const fields: ParsedEditableField[] = [];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const raw = body.slice(segment.start, segment.end);
    const equals = findTopLevelEquals(raw);
    if (equals < 0) continue;
    const paramName = raw.slice(0, equals).trim();
    if (!paramName || paramName.length > 80) continue;

    const valuePart = raw.slice(equals + 1);
    const valueLeading = valuePart.match(/^\s*/)?.[0].length || 0;
    const valueTrailing = valuePart.match(/\s*$/)?.[0].length || 0;
    const paramValue = valuePart.slice(valueLeading, valuePart.length - valueTrailing);
    const paramStart = absoluteStart + bodyOffset + segment.start + equals + 1 + valueLeading;
    const paramEnd = absoluteStart + bodyOffset + segment.end - valueTrailing;
    const reason = unsafeTemplateParamReason(paramValue);
    const isColor = /(?:색|color)$/i.test(paramName) && /^#[0-9a-f]{3,8}$/i.test(paramValue);
    const locationLabel = country ? `${baseLabel} · ${country}` : baseLabel;

    fields.push({
      key: `template:${safeKeyPart(baseLabel)}:${safeKeyPart(country || "main")}:${safeKeyPart(paramName)}:${paramStart}`,
      label: `${locationLabel} · ${paramName}`,
      group: locationLabel,
      inputKind: isColor ? "color" : "text",
      valueWikitext: paramValue,
      plainText: stripInlineMarkup(paramValue) || paramValue,
      editable: !reason,
      lockedReason: reason,
      lineIndex,
      replaceStart: paramStart,
      replaceEnd: paramEnd,
      mode: "literal",
      templateParam: true,
    });
  }

  return fields.length ? fields : null;
}

function toIsoDate(year: number, month: number, day: number) {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function parseIsoDate(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

function formatIsoDate(date: Date) {
  return toIsoDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function datePlusDays(value: string, days: number) {
  const date = parseIsoDate(value);
  if (!date) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return formatIsoDate(date);
}

function addLockedField(
  fields: ParsedEditableField[],
  baseLabel: string,
  country: string,
  lineIndex: number,
  reason: string,
  plainText: string,
  marker: number,
) {
  const locationLabel = country ? `${baseLabel} · ${country}` : baseLabel;
  fields.push({
    key: `locked:${safeKeyPart(locationLabel)}:${marker}`,
    label: locationLabel,
    group: locationLabel,
    inputKind: "text",
    valueWikitext: "",
    plainText: plainText || reason,
    editable: false,
    lockedReason: reason,
    lineIndex,
    replaceStart: marker,
    replaceEnd: marker,
    mode: "literal",
    templateParam: false,
  });
}

function parseInternal(sourceValue: string): InternalInfoboxModel | null {
  const source = normalizeSource(sourceValue);
  const lines = source.split("\n");
  const startLine = lines.findIndex((line) => /^\s*\|\|/.test(line) && /<tablealign=right>/i.test(line));
  if (startLine < 0) return null;

  let macroDepth = 0;
  let endLine = lines.length;
  for (let index = startLine; index < lines.length; index += 1) {
    const line = lines[index];
    const depthBefore = macroDepth;
    macroDepth += countToken(line, "{{{");
    macroDepth -= countToken(line, "}}}");
    if (macroDepth < 0) macroDepth = 0;

    if (index > startLine && depthBefore === 0 && (HEADING_RE.test(line) || LEAD_END_RE.test(line))) {
      endLine = index;
      break;
    }
  }

  while (endLine > startLine + 1 && !lines[endLine - 1].trim()) endLine -= 1;
  const originalWikitext = lines.slice(startLine, endLine).join("\n");
  const localLines = originalWikitext.split("\n");
  const offsets = lineOffsets(localLines);
  const fields: ParsedEditableField[] = [];

  let activeGroup: { label: string; remaining: number } | null = null;
  let depth = 0;

  for (let localIndex = 0; localIndex < localLines.length; localIndex += 1) {
    const line = localLines[localIndex];
    const lineStart = offsets[localIndex];
    const depthBefore = depth;
    depth += countToken(line, "{{{");
    depth -= countToken(line, "}}}");
    if (depth < 0) depth = 0;

    if (depthBefore > 0 || !/^\s*\|\|/.test(line)) continue;

    const firstCellText = firstCellFromLine(line);
    const ownSpan = firstCellText ? rowSpanCount(firstCellText) : 1;
    const ownLabel = firstCellText && !countryFromCell(firstCellText) ? plausibleLabel(firstCellText) : "";
    const inheritedLabel = activeGroup?.remaining ? activeGroup.label : "";
    const baseLabel = ownLabel || inheritedLabel;

    const completeCells = completeRowCells(line, lineStart);
    const country = completeCells
      ? (completeCells.map((cell) => countryFromCell(cell.text)).find(Boolean) || "")
      : (countryFromCell(line) || "");

    let parsedSomething = false;

    if (baseLabel === "데뷔일") {
      const linkedMatch = line.match(/\[\[(\d{4})년\]\]\s*\[\[(\d{1,2})월\s*(\d{1,2})일\]\]/);
      const plainMatch = linkedMatch ? null : line.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
      const dateMatch = linkedMatch || plainMatch;
      if (dateMatch && typeof dateMatch.index === "number") {
        const year = Number(dateMatch[1]);
        const month = Number(dateMatch[2]);
        const day = Number(dateMatch[3]);
        const iso = toIsoDate(year, month, day);
        const dateStart = lineStart + dateMatch.index;
        const dateEnd = dateStart + dateMatch[0].length;
        const macroSpans: DateMacroSpan[] = [];
        const originalDate = parseIsoDate(iso);
        if (originalDate) {
          const macroSources = [
            { text: line, start: lineStart },
            { text: localLines[localIndex + 1] || "", start: offsets[localIndex + 1] ?? 0 },
          ];
          for (const macroSource of macroSources) {
            const macroPattern = /\[(?:dday|age)\((\d{4}-\d{2}-\d{2})\)\]/g;
            let macroMatch: RegExpExecArray | null;
            while ((macroMatch = macroPattern.exec(macroSource.text))) {
              const macroDate = parseIsoDate(macroMatch[1]);
              if (!macroDate) continue;
              const deltaDays = Math.round((macroDate.getTime() - originalDate.getTime()) / 86400000);
              const valueOffset = macroMatch.index + macroMatch[0].indexOf(macroMatch[1]);
              macroSpans.push({
                start: macroSource.start + valueOffset,
                end: macroSource.start + valueOffset + macroMatch[1].length,
                deltaDays,
              });
            }
          }
        }
        const locationLabel = country ? `${baseLabel} · ${country}` : baseLabel;
        fields.push({
          key: `date:${safeKeyPart(baseLabel)}:${safeKeyPart(country || "main")}:${dateStart}`,
          label: locationLabel,
          group: baseLabel,
          inputKind: "date",
          valueWikitext: iso,
          plainText: `${year}년 ${month}월 ${day}일`,
          editable: true,
          lockedReason: null,
          lineIndex: startLine + localIndex,
          replaceStart: dateStart,
          replaceEnd: dateEnd,
          mode: "date",
          templateParam: false,
          dateMacroSpans: macroSpans,
          dateLinked: Boolean(linkedMatch),
        });
        parsedSomething = true;
      }
    }

    if (!parsedSomething && completeCells && completeCells.length >= 2 && baseLabel) {
      const valueCell = completeCells[completeCells.length - 1];
      const span = valueSpan(valueCell);
      const locationLabel = country ? `${baseLabel} · ${country}` : baseLabel;

      const templateFields = parseIncludeParameters(
        span.value,
        span.start,
        baseLabel,
        country,
        startLine + localIndex,
      );

      if (templateFields?.length) {
        fields.push(...templateFields);
        parsedSomething = true;
      } else {
        const reason = unsafeReason(span.value);
        if (!reason) {
          fields.push({
            key: `field:${safeKeyPart(baseLabel)}:${safeKeyPart(country || "main")}:${span.start}`,
            label: locationLabel,
            group: baseLabel,
            inputKind: "visual",
            valueWikitext: span.value,
            plainText: stripInlineMarkup(span.value),
            editable: true,
            lockedReason: null,
            lineIndex: startLine + localIndex,
            replaceStart: span.start,
            replaceEnd: span.end,
            mode: "literal",
            templateParam: false,
          });
          parsedSomething = true;
        } else if (ownLabel || completeCells.length <= 3) {
          addLockedField(
            fields,
            baseLabel,
            country,
            startLine + localIndex,
            reason,
            stripInlineMarkup(span.value) || span.value,
            span.start,
          );
          parsedSomething = true;
        }
      }
    }

    if (!parsedSomething && baseLabel && ownLabel && !completeCells) {
      addLockedField(
        fields,
        baseLabel,
        country,
        startLine + localIndex,
        "Multi-line or nested structured field",
        baseLabel,
        lineStart,
      );
    }

    if (ownSpan > 1 && ownLabel) {
      activeGroup = { label: ownLabel, remaining: ownSpan - 1 };
    } else if (activeGroup?.remaining) {
      activeGroup.remaining -= 1;
      if (activeGroup.remaining <= 0) activeGroup = null;
    }
  }

  const deduped: ParsedEditableField[] = [];
  const seen = new Set<string>();
  for (const field of fields) {
    const signature = `${field.key}|${field.replaceStart}|${field.replaceEnd}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    deduped.push(field);
  }

  if (!deduped.length) return null;

  return {
    key: "lead-infobox",
    originalWikitext,
    fields: deduped,
    editableCount: deduped.filter((field) => field.editable).length,
    lockedCount: deduped.filter((field) => !field.editable).length,
    startLine,
    endLine,
  };
}

export function parseWikiInfobox(source: string): WikiInfoboxModel | null {
  const parsed = parseInternal(source);
  if (!parsed) return null;
  return {
    key: parsed.key,
    originalWikitext: parsed.originalWikitext,
    fields: parsed.fields.map(({
      replaceStart: _replaceStart,
      replaceEnd: _replaceEnd,
      mode: _mode,
      templateParam: _templateParam,
      dateMacroSpans: _dateMacroSpans,
      dateLinked: _dateLinked,
      ...field
    }) => field),
    editableCount: parsed.editableCount,
    lockedCount: parsed.lockedCount,
    startLine: parsed.startLine,
    endLine: parsed.endLine,
  };
}

export function applyWikiInfoboxChanges(
  source: string,
  changes: Array<{ key: string; proposedWikitext: string }>,
) {
  const parsed = parseInternal(source);
  if (!parsed) throw new Error("Editable infobox was not found");
  if (!changes.length) throw new Error("No infobox changes were supplied");

  const byKey = new Map(parsed.fields.map((field) => [field.key, field]));
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  const changedFields: Array<{ label: string; original: string; proposed: string }> = [];

  for (const change of changes) {
    const field = byKey.get(change.key);
    if (!field) throw new Error("An infobox field no longer exists");
    if (!field.editable) throw new Error(`${field.label} is protected from visual editing`);

    const proposed = normalizeSource(change.proposedWikitext || "").trim();
    if (!proposed) throw new Error(`${field.label} cannot be empty`);
    if (proposed.length > 2000) throw new Error(`${field.label} is too long`);
    if (proposed === field.valueWikitext.trim()) continue;

    if (field.mode === "date") {
      const parsedDate = parseIsoDate(proposed);
      if (!parsedDate) throw new Error(`${field.label} must be a valid date`);
      const year = parsedDate.getUTCFullYear();
      const month = parsedDate.getUTCMonth() + 1;
      const day = parsedDate.getUTCDate();
      const renderedDate = field.dateLinked
        ? `[[${year}년]] [[${month}월 ${day}일]]`
        : `${year}년 ${month}월 ${day}일`;
      replacements.push({ start: field.replaceStart, end: field.replaceEnd, value: renderedDate });
      for (const macro of field.dateMacroSpans || []) {
        replacements.push({
          start: macro.start,
          end: macro.end,
          value: datePlusDays(proposed, macro.deltaDays),
        });
      }
    } else {
      if (field.inputKind === "color") {
        if (!/^#[0-9a-f]{3,8}$/i.test(proposed)) throw new Error(`${field.label} must be a hex color such as #fc6fcf`);
      } else if (field.templateParam) {
        const reason = unsafeTemplateParamReason(proposed);
        if (reason) throw new Error(`${field.label} contains unsupported template syntax (${reason})`);
      } else {
        const reason = unsafeReason(proposed);
        if (reason) throw new Error(`${field.label} contains unsupported wiki syntax (${reason})`);
      }
      replacements.push({ start: field.replaceStart, end: field.replaceEnd, value: proposed });
    }

    changedFields.push({ label: field.label, original: field.valueWikitext, proposed });
  }

  if (!changedFields.length) throw new Error("No changes were made");

  replacements.sort((a, b) => b.start - a.start || b.end - a.end);
  let proposedInfobox = parsed.originalWikitext;
  let previousStart = Number.POSITIVE_INFINITY;
  for (const replacement of replacements) {
    if (replacement.end > previousStart) throw new Error("Overlapping infobox edits are not supported");
    proposedInfobox = `${proposedInfobox.slice(0, replacement.start)}${replacement.value}${proposedInfobox.slice(replacement.end)}`;
    previousStart = replacement.start;
  }

  return {
    parsed,
    proposedInfobox,
    changedFields,
  };
}
