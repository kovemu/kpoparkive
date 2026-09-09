// Renderer compatibility layer for current NamuWiki source syntax.
//
// Canonical source_wikitext is never mutated. This wrapper normalizes only
// renderer input and asks namumark-thetree-poc.mjs to patch the locally cloned
// The Tree cache at runtime. No modified The Tree source is stored in this repo.

process.env.KPOPARKIVE_THETREE_PATCHSET = process.env.KPOPARKIVE_THETREE_PATCHSET || "modern-namu-v1";

const originalFetch = globalThis.fetch.bind(globalThis);
const compatibilityStats = {
  version: "modern-namu-compat-v5",
  documentsSeen: 0,
  documentsChanged: 0,
  commentLinesRemoved: 0,
  commentContinuationLinesRemoved: 0,
  multilineWikiHeaderLinesJoined: 0,
  multilineIfHeaderLinesJoined: 0,
  fileLinkTargetsNormalized: 0,
  structuralNbspNormalized: 0,
  colorWhitespaceNormalized: 0,
  charsBefore: 0,
  charsAfter: 0,
  changedDocuments: [],
};

function normalizeNewlines(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n");
}

function normalizeWikiTitleFragment(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeFileLinkTargets(source, local) {
  return source.replace(/\[\[((?:파일|File):)([^\]|]+)(?=[\]|])/gi, (full, prefix, target) => {
    const normalized = normalizeWikiTitleFragment(target);
    if (!normalized || normalized === target) return full;
    local.fileLinkTargetsNormalized += 1;
    return `[[${prefix}${normalized}`;
  });
}

function isSyntaxBearingLine(line) {
  // Current NamuWiki edit source frequently uses NBSP around syntax tokens.
  // The seed treats it as structural whitespace, while the pinned The Tree
  // parser only recognizes ordinary spaces in several lexers. Keep prose-only
  // lines untouched and normalize NBSP only on lines that carry wiki syntax.
  return /(\|\||\{\{\{|\}\}\}|\[\[|\]\]|\[(?:include|Include)\(|#!|<[^>]+>|\[목차\]|\[clearfix\]|\[br\])/i.test(line);
}

function normalizeModernColorSyntax(line, local) {
  let normalized = line.replace(/\{\{\{#\s+([0-9A-Za-z])/g, (_full, first) => {
    local.colorWhitespaceNormalized += 1;
    return `{{{#${first}`;
  });
  normalized = normalized.replace(/,\s*#\s+([0-9A-Za-z])/g, (_full, first) => {
    local.colorWhitespaceNormalized += 1;
    return `,#${first}`;
  });
  return normalized;
}

function normalizeStructuralNbsp(source, local) {
  return source
    .split("\n")
    .map((line) => {
      if (!isSyntaxBearingLine(line)) return line;
      let normalized = line;
      if (normalized.includes("\u00a0")) {
        const count = (normalized.match(/\u00a0/g) || []).length;
        local.structuralNbspNormalized += count;
        normalized = normalized.replace(/\u00a0/g, " ");
      }
      return normalizeModernColorSyntax(normalized, local);
    })
    .join("\n");
}

function startsStructuralSyntax(line) {
  const text = String(line ?? "").trimStart();
  if (!text) return true;
  return /^(?:##|\{\{\{|\[\[|\[include\(|\|\||={1,6}(?:#)?\s|----(?:-|$)|>|\s*[1aAiI]\.\s|\s*\*\s)/i.test(text);
}

function countUnescaped(text, needle) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== needle) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

function delimiterBalance(text) {
  let square = 0;
  let round = 0;
  let braces = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("{{{", i)) {
      braces += 1;
      i += 2;
      continue;
    }
    if (text.startsWith("}}}", i)) {
      braces = Math.max(0, braces - 1);
      i += 2;
      continue;
    }
    const ch = text[i];
    if (ch === "[") square += 1;
    else if (ch === "]") square = Math.max(0, square - 1);
    else if (ch === "(") round += 1;
    else if (ch === ")") round = Math.max(0, round - 1);
  }
  return { square, round, braces };
}

function stripModernCommentBlocks(lines, local) {
  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("##")) {
      output.push(line);
      continue;
    }

    local.commentLinesRemoved += 1;
    const body = trimmed.slice(2);
    const balance = delimiterBalance(body);
    const hasOpenStructure = balance.square > 0 || balance.round > 0 || balance.braces > 0;
    const wrappedProse = /\s$/.test(line);
    if (!hasOpenStructure && !wrappedProse) continue;

    let aggregate = body;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trimStart().startsWith("##")) break;
      if (startsStructuralSyntax(next)) break;

      local.commentContinuationLinesRemoved += 1;
      aggregate += `\n${next}`;
      i = j;

      const nextBalance = delimiterBalance(aggregate);
      const stillStructured = nextBalance.square > 0 || nextBalance.round > 0 || nextBalance.braces > 0;
      if (!stillStructured && !/\s$/.test(next)) break;
    }
  }
  return output;
}

function wikiHeaderNeedsJoin(line) {
  const index = line.lastIndexOf("{{{#!wiki");
  if (index < 0) return false;
  const header = line.slice(index);
  return countUnescaped(header, '"') % 2 === 1;
}

function ifHeaderNeedsJoin(line) {
  const index = line.lastIndexOf("{{{#!if");
  if (index < 0) return false;
  const expression = line.slice(index + "{{{#!if".length).trim();
  if (!expression) return true;
  const balance = delimiterBalance(expression);
  if (balance.round > 0 || balance.square > 0 || balance.braces > 0) return true;
  if (countUnescaped(expression, '"') % 2 === 1 || countUnescaped(expression, "'") % 2 === 1) return true;
  return /(?:&&|\|\||==|!=|<=|>=|[,+\-*/=])\s*$/.test(expression);
}

function joinMultilineDirectiveHeaders(lines, local) {
  const output = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const mode = wikiHeaderNeedsJoin(line) ? "wiki" : ifHeaderNeedsJoin(line) ? "if" : null;
    if (!mode) {
      output.push(line);
      continue;
    }

    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (startsStructuralSyntax(next) && !/^\s*[#@]/.test(next)) break;
      line += next;
      i += 1;
      if (mode === "wiki") local.multilineWikiHeaderLinesJoined += 1;
      else local.multilineIfHeaderLinesJoined += 1;

      const stillNeeds = mode === "wiki" ? wikiHeaderNeedsJoin(line) : ifHeaderNeedsJoin(line);
      if (!stillNeeds) break;
    }
    output.push(line);
  }
  return output;
}

function applyCompatibility(raw, title) {
  const source = normalizeNewlines(raw);
  const local = {
    commentLinesRemoved: 0,
    commentContinuationLinesRemoved: 0,
    multilineWikiHeaderLinesJoined: 0,
    multilineIfHeaderLinesJoined: 0,
    fileLinkTargetsNormalized: 0,
    structuralNbspNormalized: 0,
    colorWhitespaceNormalized: 0,
  };

  const whitespaceNormalizedSource = normalizeStructuralNbsp(source, local);
  const titleNormalizedSource = normalizeFileLinkTargets(whitespaceNormalizedSource, local);
  let lines = titleNormalizedSource.split("\n");
  lines = stripModernCommentBlocks(lines, local);
  lines = joinMultilineDirectiveHeaders(lines, local);
  const result = lines.join("\n");

  compatibilityStats.documentsSeen += 1;
  compatibilityStats.charsBefore += source.length;
  compatibilityStats.charsAfter += result.length;
  for (const key of Object.keys(local)) compatibilityStats[key] += local[key];

  if (result !== source) {
    compatibilityStats.documentsChanged += 1;
    if (compatibilityStats.changedDocuments.length < 80) {
      compatibilityStats.changedDocuments.push({ title, ...local, before: source.length, after: result.length });
    }
  }
  return result;
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url || "";
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || "GET").toUpperCase();
}

function responseWithJson(value, original) {
  const headers = new Headers(original.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(value), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

globalThis.fetch = async (input, init = undefined) => {
  const url = requestUrl(input);
  const method = requestMethod(input, init);

  const isRawDocumentLoad = method === "GET"
    && url.includes("/rest/v1/source_documents?")
    && url.includes("source=eq.namu_mirror")
    && url.includes("source_wikitext=not.is.null");

  if (isRawDocumentLoad) {
    const response = await originalFetch(input, init);
    if (!response.ok) return response;
    const rows = await response.json();
    if (!Array.isArray(rows)) return responseWithJson(rows, response);
    const transformed = rows.map((row) => ({
      ...row,
      source_wikitext: typeof row?.source_wikitext === "string"
        ? applyCompatibility(row.source_wikitext, row.source_title || "")
        : row?.source_wikitext,
    }));
    return responseWithJson(transformed, response);
  }

  const isRenderSave = method === "PATCH" && url.includes("/rest/v1/source_documents?id=eq.");
  if (isRenderSave && typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body);
      const previousMeta = body.source_namumark_meta && typeof body.source_namumark_meta === "object"
        ? body.source_namumark_meta
        : {};
      body.source_namumark_meta = {
        ...previousMeta,
        compatibility: {
          ...compatibilityStats,
          enginePatchset: process.env.KPOPARKIVE_THETREE_PATCHSET,
          note: "Canonical source_wikitext unchanged; renderer input normalized and local cached The Tree patched at runtime.",
        },
      };
      body.source_namumark_engine = "thetree-modern-namu-compat-poc";
      return originalFetch(input, { ...init, body: JSON.stringify(body) });
    } catch {
      // Fall through unchanged if a future renderer changes its PATCH format.
    }
  }

  return originalFetch(input, init);
};

await import("./namumark-thetree-poc.mjs");
