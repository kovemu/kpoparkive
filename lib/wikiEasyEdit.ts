export type EasyEditBlock = {
  key: string;
  blockIndex: number;
  plainText: string;
  originalWikitext: string;
  editable: boolean;
  lockedReason: string | null;
};

export type EasyEditSection = {
  key: string;
  sectionIndex: number;
  level: number;
  heading: string;
  headingRaw: string;
  blocks: EasyEditBlock[];
};

const HEADING_RE = /^(={2,6})\s*(.*?)\s*\1\s*$/;
const STRUCTURAL_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*\|\|/, "Complex table"],
  [/\{\{\{#!/, "Styled wiki block"],
  [/\{\{\{[-+]?\d?/, "Formatted wiki block"],
  [/\[include\(/i, "Template include"],
  [/\[youtube\(/i, "Embedded media"],
  [/\[clearfix\]/i, "Layout macro"],
  [/\[(?:목차|각주)\]/, "Document macro"],
  [/\[\[(?:파일|File):/i, "File block"],
  [/^\s*----\s*$/, "Structural divider"],
  [/\[(?:age|dday)\(/i, "Dynamic macro"],
];

function countToken(line: string, token: string) {
  if (!line || !token) return 0;
  let count = 0;
  let from = 0;
  while (from < line.length) {
    const found = line.indexOf(token, from);
    if (found < 0) break;
    count += 1;
    from = found + token.length;
  }
  return count;
}

function stripInlineMarkup(value: string) {
  let text = value;
  text = text.replace(/\[br\]/gi, "\n");
  text = text.replace(/\[\*\s*([^\]]*)\]/g, (_match, note: string) => note.trim() ? ` (Note: ${note.trim()})` : "");
  text = text.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_match, _target: string, label: string) => label);
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_match, target: string) => target);
  text = text.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]+)\]/g, (_match, label: string) => label);
  text = text.replace(/\[https?:\/\/[^\]]+\]/g, "");
  text = text.replace(/'''/g, "");
  text = text.replace(/''/g, "");
  text = text.replace(/\^\^/g, "");
  text = text.replace(/~~/g, "");
  text = text.replace(/^\s*\*\s?/gm, "• ");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function lockReasonForBlock(lines: string[], macroDepthAtStart: number) {
  if (macroDepthAtStart > 0) return "Inside a protected wiki block";
  for (const line of lines) {
    for (const [pattern, reason] of STRUCTURAL_PATTERNS) {
      if (pattern.test(line)) return reason;
    }
  }
  const text = lines.join("\n").trim();
  if (!text) return "Empty block";
  if (text.length > 12000) return "Block is too large for Easy Edit";
  return null;
}

export function parseEasyEditSections(source: string): EasyEditSection[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const sections: Array<{ sectionIndex: number; level: number; heading: string; headingRaw: string; body: string[] }> = [];

  let current = {
    sectionIndex: 0,
    level: 1,
    heading: "Document lead",
    headingRaw: "",
    body: [] as string[],
  };

  for (const line of lines) {
    const match = line.match(HEADING_RE);
    if (match) {
      sections.push(current);
      const raw = match[2].trim();
      current = {
        sectionIndex: sections.length,
        level: match[1].length,
        heading: stripInlineMarkup(raw) || raw,
        headingRaw: raw,
        body: [],
      };
      continue;
    }
    current.body.push(line);
  }
  sections.push(current);

  return sections.map((section) => {
    const blocks: EasyEditBlock[] = [];
    let macroDepth = 0;
    let blockLines: string[] = [];
    let blockStartDepth = 0;

    const flush = () => {
      if (!blockLines.length) return;
      const originalWikitext = blockLines.join("\n").trim();
      const lockedReason = lockReasonForBlock(blockLines, blockStartDepth);
      const plainText = stripInlineMarkup(originalWikitext);
      const editable = !lockedReason && plainText.length > 0;
      const blockIndex = blocks.length;
      blocks.push({
        key: `${section.sectionIndex}:${blockIndex}`,
        blockIndex,
        plainText,
        originalWikitext,
        editable,
        lockedReason: editable ? null : (lockedReason || "Unsupported wiki syntax"),
      });
      blockLines = [];
    };

    for (const line of section.body) {
      const isBlank = line.trim() === "";
      if (isBlank && macroDepth === 0) {
        flush();
        continue;
      }

      if (!blockLines.length) blockStartDepth = macroDepth;
      blockLines.push(line);

      macroDepth += countToken(line, "{{{");
      macroDepth -= countToken(line, "}}}");
      if (macroDepth < 0) macroDepth = 0;
    }
    flush();

    return {
      key: `section:${section.sectionIndex}`,
      sectionIndex: section.sectionIndex,
      level: section.level,
      heading: section.heading,
      headingRaw: section.headingRaw,
      blocks,
    };
  }).filter((section) => section.blocks.length > 0);
}

export function findEasyEditBlock(source: string, blockKey: string) {
  for (const section of parseEasyEditSections(source)) {
    const block = section.blocks.find((item) => item.key === blockKey);
    if (block) return { section, block };
  }
  return null;
}
