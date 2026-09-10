export type WikiTemplateParam = {
  key: string;
  name: string | null;
  value: string;
  positional: boolean;
};

export type WikiTemplateModel = {
  key: string;
  name: string;
  start: number;
  end: number;
  originalWikitext: string;
  params: WikiTemplateParam[];
};

function normalize(value: string) {
  return value.replace(/\r\n?/g, "\n");
}

function splitTopLevel(value: string, delimiter = ",") {
  const out: string[] = [];
  let start = 0;
  let square = 0;
  let curly = 0;
  let paren = 0;
  let quote: string | null = null;

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const next = value[i + 1] || "";
    if (quote) {
      if (char === quote && value[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" && next === "[") { square += 1; i += 1; continue; }
    if (char === "]" && next === "]") { square = Math.max(0, square - 1); i += 1; continue; }
    if (char === "{" && next === "{") { curly += 1; i += 1; continue; }
    if (char === "}" && next === "}") { curly = Math.max(0, curly - 1); i += 1; continue; }
    if (char === "(") { paren += 1; continue; }
    if (char === ")") { paren = Math.max(0, paren - 1); continue; }
    if (char === delimiter && square === 0 && curly === 0 && paren === 0) {
      out.push(value.slice(start, i));
      start = i + 1;
    }
  }
  out.push(value.slice(start));
  return out;
}

function topLevelEquals(value: string) {
  let square = 0;
  let curly = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    const next = value[i + 1] || "";
    if (char === "[" && next === "[") { square += 1; i += 1; continue; }
    if (char === "]" && next === "]") { square = Math.max(0, square - 1); i += 1; continue; }
    if (char === "{" && next === "{") { curly += 1; i += 1; continue; }
    if (char === "}" && next === "}") { curly = Math.max(0, curly - 1); i += 1; continue; }
    if (char === "(") { paren += 1; continue; }
    if (char === ")") { paren = Math.max(0, paren - 1); continue; }
    if (char === "=" && square === 0 && curly === 0 && paren === 0) return i;
  }
  return -1;
}

function findIncludeEnd(source: string, start: number) {
  const open = source.slice(start, start + 9).toLowerCase();
  if (open !== "[include(") return -1;
  let depth = 1;
  let square = 0;
  for (let i = start + 9; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1] || "";
    if (char === "[" && next === "[") { square += 1; i += 1; continue; }
    if (char === "]" && next === "]") { square = Math.max(0, square - 1); i += 1; continue; }
    if (square > 0) continue;
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "]" && depth === 0) return i;
    if (depth === 0 && source[i + 1] === "]") return i + 1;
  }
  return -1;
}

export function parseWikiTemplates(input: string): WikiTemplateModel[] {
  const source = normalize(input);
  const models: WikiTemplateModel[] = [];
  const lower = source.toLowerCase();
  let cursor = 0;

  while (cursor < source.length) {
    const start = lower.indexOf("[include(", cursor);
    if (start < 0) break;
    const end = findIncludeEnd(source, start);
    if (end < 0) { cursor = start + 9; continue; }
    const raw = source.slice(start, end + 1);
    const inner = raw.slice(9, -2);
    const parts = splitTopLevel(inner).map((part) => part.trim()).filter(Boolean);
    const name = parts.shift() || "";
    const params: WikiTemplateParam[] = parts.map((part, index) => {
      const eq = topLevelEquals(part);
      if (eq < 0) {
        return { key: `p:${index + 1}`, name: null, value: part.trim(), positional: true };
      }
      const paramName = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      return { key: `n:${paramName}:${index}`, name: paramName, value, positional: false };
    });
    models.push({
      key: `template:${start}`,
      name,
      start,
      end: end + 1,
      originalWikitext: raw,
      params,
    });
    cursor = end + 1;
  }

  return models;
}

export function buildWikiTemplate(name: string, params: Array<{ name?: string | null; value: string }>) {
  const cleanName = name.trim();
  if (!cleanName) throw new Error("Template name is required");
  const rendered = params
    .map((param) => {
      const value = String(param.value || "").trim();
      if (!value) return "";
      const key = String(param.name || "").trim();
      return key ? `${key}=${value}` : value;
    })
    .filter(Boolean);
  return `[include(${cleanName}${rendered.length ? `, ${rendered.join(", ")}` : ""})]`;
}

export function replaceWikiTemplate(
  sourceInput: string,
  templateKey: string,
  name: string,
  params: Array<{ name?: string | null; value: string }>,
) {
  const source = normalize(sourceInput);
  const model = parseWikiTemplates(source).find((item) => item.key === templateKey);
  if (!model) throw new Error("Template call no longer exists");
  const proposed = buildWikiTemplate(name, params);
  return {
    model,
    proposed,
    source: `${source.slice(0, model.start)}${proposed}${source.slice(model.end)}`,
  };
}
