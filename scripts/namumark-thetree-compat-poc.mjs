// Renderer compatibility layer for current NamuWiki source syntax.
//
// Canonical source_wikitext is never mutated. This wrapper normalizes only
// renderer input and asks namumark-thetree-poc.mjs to patch the locally cloned
// The Tree cache at runtime. No modified The Tree source is stored in this repo.

process.env.KPOPARKIVE_THETREE_PATCHSET = process.env.KPOPARKIVE_THETREE_PATCHSET || "modern-namu-v2";

const originalFetch = globalThis.fetch.bind(globalThis);
const compatibilityStats = {
  version: "modern-namu-compat-v8",
  documentsSeen: 0,
  documentsChanged: 0,
  commentLinesRemoved: 0,
  commentContinuationLinesRemoved: 0,
  multilineWikiHeaderLinesJoined: 0,
  multilineIfHeaderLinesJoined: 0,
  fileLinkTargetsNormalized: 0,
  templateIncludeTitlesNormalized: 0,
  structuralNbspNormalized: 0,
  colorWhitespaceNormalized: 0,
  missingYouTubeIconIncludesExpanded: 0,
  parentDocumentIncludesExpanded: 0,
  importedDocumentIncludesExpanded: 0,
  songDetailIncludesExpanded: 0,
  youtubeIconTemplateAvailable: false,
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

function normalizeTemplateIncludeTitles(source, local) {
  return source.replace(
    /\[include\(\s*((?:틀|Template)\s*:\s*[^,\)\]\r\n]+)(?=\s*(?:,|\)\]))/gi,
    (full, rawTitle) => {
      const normalized = normalizeWikiTitleFragment(rawTitle)
        .replace(/^(틀|Template)\s*:\s*/i, (_match, namespace) => `${namespace}:`);
      if (!normalized || normalized === rawTitle) return full;
      local.templateIncludeTitlesNormalized += 1;
      return full.replace(rawTitle, normalized);
    },
  );
}

function parseSimpleIncludeParams(raw) {
  const params = new Map();
  for (const piece of String(raw || "").split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 0) continue;
    const name = normalizeWikiTitleFragment(trimmed.slice(0, equals));
    const value = trimmed.slice(equals + 1).trim();
    if (name) params.set(name, value);
  }
  return params;
}


function safeInlineWikiText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "／")
    .replace(/\]\]/g, "］］")
    .trim();
}

function englishUtilityLabel(value) {
  const normalized = normalizeWikiTitleFragment(value);
  const labels = new Map([
    ["선공개", "Pre-release"],
    ["타이틀", "TITLE"],
    ["타이틀곡", "TITLE"],
  ]);
  return labels.get(normalized) || safeInlineWikiText(value);
}

function expandKnownUtilityIncludes(source, title, local, options = {}) {
  const availableTemplates = options.availableTemplateTitles instanceof Set
    ? options.availableTemplateTitles
    : new Set();
  const english = Boolean(options.renderContent);
  const currentTitle = normalizeWikiTitleFragment(title);

  return String(source || "").replace(
    /\[include\(\s*((?:틀|Template)\s*:\s*[^,\)\]\r\n]+)((?:,[^\]\r\n]*?)?)\)\]/gi,
    (full, rawTitle, rawParams) => {
      const template = normalizeWikiTitleFragment(rawTitle)
        .replace(/^(틀|Template)\s*:\s*/i, (_match, namespace) => `${namespace}:`);
      if (availableTemplates.has(template)) return full;

      const params = parseSimpleIncludeParams(rawParams);
      const lower = template.toLowerCase();

      if (lower === "틀:상위 문서" || lower === "template:상위 문서") {
        const explicit = safeInlineWikiText(params.get("문서명1") || "");
        const slash = currentTitle.lastIndexOf("/");
        const inferred = slash > 0 ? currentTitle.slice(0, slash) : "";
        const parent = explicit || inferred;
        if (!parent) return full;
        local.parentDocumentIncludesExpanded += 1;
        const prefix = english ? "Parent document" : "상위 문서";
        return `{{{-2 ↑ '''${prefix}:''' [[${parent}]]}}}`;
      }

      if (lower === "틀:문서 가져옴" || lower === "template:문서 가져옴") {
        const sourceTitle = safeInlineWikiText(params.get("title") || params.get("문서명") || "");
        const version = safeInlineWikiText(params.get("version") || "");
        const uuid = safeInlineWikiText(params.get("uuid") || "");
        if (!sourceTitle) return full;
        local.importedDocumentIncludesExpanded += 1;

        const revision = version ? ` r${version}` : "";
        const historyUrl = uuid
          ? `https://namu.wiki/history/${encodeURIComponent(sourceTitle)}?commit=${encodeURIComponent(uuid)}`
          : "";
        if (english) {
          const history = historyUrl ? ` [${historyUrl} View earlier history]` : "";
          return `{{{-2 This document incorporates material from [[${sourceTitle}]] revision${revision} on NamuWiki.${history}}}}`;
        }
        const history = historyUrl ? ` [${historyUrl} 이전 역사 보러 가기]` : "";
        return `{{{-2 이 문서는 [[${sourceTitle}]] 문서의${revision} 판에서 가져왔습니다.${history}}}}`;
      }

      if (lower === "틀:노래 세부사항" || lower === "template:노래 세부사항" ||
          lower === "틀:노래 세부사항2" || lower === "template:노래 세부사항2") {
        const documentTitle = safeInlineWikiText(params.get("문서명") || currentTitle);
        const titleAnchor = safeInlineWikiText(params.get("앵커_타이틀") || "");
        const anchor = titleAnchor || safeInlineWikiText(params.get("앵커") || params.get("곡명") || "");
        const track = safeInlineWikiText(params.get("트랙번호") || "");
        const duration = safeInlineWikiText(params.get("재생시간") || "");
        const info = safeInlineWikiText(params.get("정보") || "");
        const info2 = safeInlineWikiText(params.get("정보2") || "");
        if (!anchor && !track && !duration) return full;

        local.songDetailIncludesExpanded += 1;
        const visibleTitle = titleAnchor ? `'''${anchor}'''` : anchor;
        const target = documentTitle && anchor ? `${documentTitle}#${anchor}` : documentTitle;
        const firstLine = target && visibleTitle ? `[[${target}|${visibleTitle}]]` : visibleTitle;
        const badges = [info, info2]
          .filter(Boolean)
          .map((value) => english ? englishUtilityLabel(value) : value);
        const detail = [
          track ? `'''${track}'''` : "",
          duration,
          ...badges,
        ].filter(Boolean).join("　");
        return [firstLine, detail ? `[br]{{{-4 ${detail}}}}` : ""].join("");
      }

      return full;
    },
  );
}

function expandMissingYouTubeIconIncludes(source, local) {
  return source.replace(
    /\[include\(\s*틀:유튜브\s+아이콘\s*((?:,[^\]\r\n]*)?)\)\]/gi,
    (full, rawParams) => {
      const params = parseSimpleIncludeParams(rawParams);
      const link = String(params.get("링크") || "").trim();
      if (!link) return full;

      let href = "";
      if (/^https?:\/\//i.test(link)) href = link;
      else if (/^[A-Za-z0-9_-]{6,}$/.test(link)) href = `https://www.youtube.com/watch?v=${link}`;
      else return full;

      const requestedWidth = String(params.get("크기") || "22").trim();
      const width = /^\d{1,3}$/.test(requestedWidth) && Number(requestedWidth) > 0
        ? requestedWidth
        : "22";

      local.missingYouTubeIconIncludesExpanded += 1;
      return `[[${href}|[[파일:유튜브 아이콘.svg|width=${width}]]]]`;
    },
  );
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

function applyCompatibility(raw, title, options = {}) {
  const source = normalizeNewlines(raw).replace(
    /^\s*\[include\(\s*틀\s*:\s*접근\s*제한(?:\s*,[^\]\r\n]*)?\)\]\s*$/gim,
    "",
  );
  const local = {
    commentLinesRemoved: 0,
    commentContinuationLinesRemoved: 0,
    multilineWikiHeaderLinesJoined: 0,
    multilineIfHeaderLinesJoined: 0,
    fileLinkTargetsNormalized: 0,
    templateIncludeTitlesNormalized: 0,
    structuralNbspNormalized: 0,
    colorWhitespaceNormalized: 0,
    missingYouTubeIconIncludesExpanded: 0,
    parentDocumentIncludesExpanded: 0,
    importedDocumentIncludesExpanded: 0,
    songDetailIncludesExpanded: 0,
  };

  const whitespaceNormalizedSource = normalizeStructuralNbsp(source, local);
  const titleNormalizedSource = normalizeFileLinkTargets(whitespaceNormalizedSource, local);
  const includeNormalizedSource = normalizeTemplateIncludeTitles(titleNormalizedSource, local);
  let lines = includeNormalizedSource.split("\n");
  lines = stripModernCommentBlocks(lines, local);
  lines = joinMultilineDirectiveHeaders(lines, local);
  let result = lines.join("\n");

  // A multiline #!wiki / #!if header can carry NBSP only on continuation
  // lines. Those lines are not syntax-bearing until they are joined, so run
  // structural whitespace normalization once more after the join.
  result = normalizeStructuralNbsp(result, local);

  if (options.expandMissingYouTubeIconTemplate) {
    result = expandMissingYouTubeIconIncludes(result, local);
  }

  result = expandKnownUtilityIncludes(result, title, local, options);

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

    const availableTemplateTitles = new Set(
      rows
        .map((row) => normalizeWikiTitleFragment(row?.source_title || ""))
        .filter((value) => /^(?:틀|Template):/i.test(value)),
    );
    const hasYouTubeIconTemplate = availableTemplateTitles.has("틀:유튜브 아이콘");
    compatibilityStats.youtubeIconTemplateAvailable = hasYouTubeIconTemplate;

    const transformed = rows.map((row) => ({
      ...row,
      source_wikitext: typeof row?.source_wikitext === "string"
        ? applyCompatibility(row.source_wikitext, row.source_title || "", {
          expandMissingYouTubeIconTemplate: !hasYouTubeIconTemplate,
          availableTemplateTitles,
          renderContent: Boolean(process.env.KPOPARKIVE_RENDER_CONTENT),
        })
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
          note: "Canonical source_wikitext unchanged; renderer input normalized. Missing reusable utility templates (parent-document, imported-document attribution, song-detail cells, and the standard YouTube icon) are expanded only when no canonical template RAW is available. Local cached The Tree is patched at runtime.",
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
