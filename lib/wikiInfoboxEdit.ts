export type WikiInfoboxField = {
  key: string;
  label: string;
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

type ParsedEditableField = WikiInfoboxField & {
  linePrefix: string;
  lineSuffix: string;
};

type InternalInfoboxModel = Omit<WikiInfoboxModel, "fields"> & {
  fields: ParsedEditableField[];
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

function parseTwoCellRow(line: string, lineIndex: number): ParsedEditableField | null {
  if (!line.trimStart().startsWith("||") || !line.trimEnd().endsWith("||")) return null;

  const trimmedStart = line.indexOf("||");
  const trimmedEnd = line.lastIndexOf("||");
  if (trimmedStart < 0 || trimmedEnd <= trimmedStart + 1) return null;

  const inner = line.slice(trimmedStart + 2, trimmedEnd);
  const divider = inner.indexOf("||");
  if (divider < 0 || inner.indexOf("||", divider + 2) >= 0) return null;

  const leftCell = inner.slice(0, divider);
  const rightCell = inner.slice(divider + 2);

  // The common NamuWiki infobox shape for a simple value is:
  // || label ||<-2>value ||
  // Multi-row / country-specific / nested rows are deliberately left protected.
  if (!/^\s*<-2>/.test(rightCell)) return null;

  const label = stripInlineMarkup(stripCellOptions(leftCell));
  if (!label || label.length > 80) return null;

  const optionMatch = rightCell.match(/^(\s*(?:<[^>\n]*>\s*)+)/);
  const optionPrefix = optionMatch?.[1] || "";
  const afterOptions = rightCell.slice(optionPrefix.length);
  const leadingMatch = afterOptions.match(/^\s*/)?.[0] || "";
  const trailingMatch = afterOptions.match(/\s*$/)?.[0] || "";
  const valueEnd = Math.max(leadingMatch.length, afterOptions.length - trailingMatch.length);
  const valueWikitext = afterOptions.slice(leadingMatch.length, valueEnd);
  const lockedReason = unsafeReason(valueWikitext);

  return {
    key: `${safeKeyPart(label)}:${lineIndex}`,
    label,
    valueWikitext,
    plainText: stripInlineMarkup(valueWikitext),
    editable: !lockedReason,
    lockedReason,
    lineIndex,
    linePrefix: `${line.slice(0, trimmedStart + 2)}${leftCell}||${optionPrefix}${leadingMatch}`,
    lineSuffix: `${trailingMatch}${line.slice(trimmedEnd)}`,
  };
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

  // Remove trailing blank lines, but never trim lines inside the table itself.
  while (endLine > startLine + 1 && !lines[endLine - 1].trim()) endLine -= 1;
  const originalWikitext = lines.slice(startLine, endLine).join("\n");

  const fields: ParsedEditableField[] = [];
  for (let index = startLine; index < endLine; index += 1) {
    const field = parseTwoCellRow(lines[index], index);
    if (field) fields.push(field);
  }

  if (!fields.length) return null;

  return {
    key: "lead-infobox",
    originalWikitext,
    fields,
    editableCount: fields.filter((field) => field.editable).length,
    lockedCount: fields.filter((field) => !field.editable).length,
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
    fields: parsed.fields.map(({ linePrefix: _linePrefix, lineSuffix: _lineSuffix, ...field }) => field),
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
  const replacements = new Map<number, string>();
  const changedFields: Array<{ label: string; original: string; proposed: string }> = [];

  for (const change of changes) {
    const field = byKey.get(change.key);
    if (!field) throw new Error("An infobox field no longer exists");
    if (!field.editable) throw new Error(`${field.label} is protected from visual editing`);

    const proposed = normalizeSource(change.proposedWikitext || "").trim();
    if (!proposed) throw new Error(`${field.label} cannot be empty`);
    if (proposed.length > 2000) throw new Error(`${field.label} is too long`);
    const reason = unsafeReason(proposed);
    if (reason) throw new Error(`${field.label} contains unsupported wiki syntax (${reason})`);
    if (proposed === field.valueWikitext.trim()) continue;

    replacements.set(field.lineIndex, `${field.linePrefix}${proposed}${field.lineSuffix}`);
    changedFields.push({ label: field.label, original: field.valueWikitext, proposed });
  }

  if (!changedFields.length) throw new Error("No changes were made");

  const sourceLines = normalizeSource(source).split("\n");
  for (const [lineIndex, replacement] of replacements) sourceLines[lineIndex] = replacement;

  const proposedInfobox = sourceLines.slice(parsed.startLine, parsed.endLine).join("\n");
  return {
    parsed,
    proposedInfobox,
    changedFields,
  };
}
