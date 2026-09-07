function findDirectiveMacroEnd(source: string, start: number) {
  let depth = 0;
  for (let cursor = start; cursor < source.length - 2; cursor += 1) {
    if (source.slice(cursor, cursor + 3) === "{{{") {
      depth += 1;
      cursor += 2;
      continue;
    }
    if (source.slice(cursor, cursor + 3) === "}}}") {
      depth -= 1;
      if (depth === 0) return cursor;
      cursor += 2;
    }
  }
  return -1;
}

function normalizeScope(source: string): string {
  let output = "";
  let cursor = 0;
  let squareDepth = 0;

  while (cursor < source.length) {
    const pair = source.slice(cursor, cursor + 2);
    if (pair === "[[") {
      squareDepth += 1;
      output += pair;
      cursor += 2;
      continue;
    }
    if (pair === "]]" && squareDepth > 0) {
      squareDepth -= 1;
      output += pair;
      cursor += 2;
      continue;
    }

    if (squareDepth === 0 && source.slice(cursor, cursor + 4) === "{{{#") {
      const end = findDirectiveMacroEnd(source, cursor);
      if (end >= 0) {
        const macro = source.slice(cursor, end + 3);
        const inner = macro.slice(3, -3);
        const header = inner.match(/^(#![a-z]+\b[^\n]*)(?:\n([\s\S]*))?$/i);
        if (header) {
          const normalizedBody = header[2] !== undefined ? normalizeScope(header[2]) : undefined;
          output += `{{{${header[1]}${normalizedBody !== undefined ? `\n${normalizedBody}` : ""}}}}`;
          cursor = end + 3;
          if (source.slice(cursor, cursor + 4) === "{{{#") output += "\n";
          continue;
        }
      }
    }

    output += source[cursor];
    cursor += 1;
  }

  return output;
}

/**
 * Namu templates frequently place sibling {{{#!wiki ...}}} blocks directly next
 * to each other as `}}}{{{#!wiki`. The raw parser is line-oriented, so without a
 * boundary those siblings can be consumed as one macro. Normalize only directive
 * macros that are top-level in the current scope; macros nested inside [[links]]
 * remain inline. Nested directive bodies are normalized recursively.
 */
export function normalizeNamuRawBlocks(source: string) {
  return normalizeScope(source.replace(/\r\n?/g, "\n"));
}
