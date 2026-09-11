const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.NAMU_TRANSLATION_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";

const TRANSLATION_VERSION = "namumark-en-v1";
const DEFAULT_CHUNK_CHARS = 18000;
const MAX_ATTEMPTS = 3;

type ProtectedToken = { placeholder: string; value: string; kind: string };

export type NamuMarkTranslationResult = {
  wikitext: string;
  model: string;
  version: string;
  chunks: number;
  sourceChars: number;
  translatedChars: number;
};

function countOccurrences(value: string, needle: string) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function placeholder(index: number) {
  return "@@KPA_" + String(index).padStart(6, "0") + "@@";
}

function protectMatches(source: string, pattern: RegExp, kind: string, tokens: ProtectedToken[]) {
  return source.replace(pattern, (value) => {
    const key = placeholder(tokens.length + 1);
    tokens.push({ placeholder: key, value, kind });
    return key;
  });
}

function maskInternalLinkTargets(source: string, tokens: ProtectedToken[]) {
  return source.replace(/\[\[([^\[\]\r\n]+?)\]\]/g, (full, rawInner: string) => {
    const inner = String(rawInner || "");
    const trimmed = inner.trim();
    if (!trimmed) return full;
    if (/^(?:파일|File|분류|Category):/i.test(trimmed)) {
      const key = placeholder(tokens.length + 1);
      tokens.push({ placeholder: key, value: full, kind: "whole-link" });
      return key;
    }
    const pipe = inner.indexOf("|");
    const rawTarget = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const target = rawTarget.trim();
    if (!target) return full;
    const key = placeholder(tokens.length + 1);
    tokens.push({ placeholder: key, value: target, kind: "link-target" });
    if (pipe >= 0) return "[[" + key + "|" + inner.slice(pipe + 1) + "]]";
    return "[[" + key + "|" + target + "]]";
  });
}

function maskNamuMark(source: string) {
  const tokens: ProtectedToken[] = [];
  let masked = source;
  masked = protectMatches(masked, /\[\[(?:파일|File):[^\]\r\n]+\]\]/gi, "file-link", tokens);
  masked = protectMatches(masked, /\[\[(?:분류|Category):[^\]\r\n]+\]\]/gi, "category-link", tokens);
  masked = protectMatches(masked, /\[include\([^\]\r\n]*\)\]/gi, "include", tokens);
  masked = protectMatches(masked, /\[(?:br|clearfix|목차|toc|각주|footnote)\]/gi, "macro", tokens);
  masked = protectMatches(masked, /\[(?:dday|age|date|youtube|nicovideo|kakaotv|navertv)\([^\]\r\n]*\)\]/gi, "macro", tokens);
  masked = maskInternalLinkTargets(masked, tokens);
  masked = protectMatches(masked, /https?:\/\/[^\s\]|}<>"\']+/gi, "url", tokens);
  return { masked, tokens };
}

function restoreProtectedTokens(masked: string, tokens: ProtectedToken[]) {
  let output = masked;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const occurrences = countOccurrences(output, token.placeholder);
    if (occurrences !== 1) throw new Error("Translation changed protected " + token.kind + " token " + token.placeholder + " (found " + occurrences + ")");
    output = output.replace(token.placeholder, token.value);
  }
  return output;
}

function headingSignature(source: string) {
  const signature: string[] = [];
  for (const line of source.split("\n")) {
    const match = line.match(/^(={1,6})(#?)\s*.*?\s*(#?)\1\s*$/);
    if (!match) continue;
    signature.push(String(match[1].length) + ":" + (match[2] === "#" || match[3] === "#" ? "fold" : "open"));
  }
  return signature.join(",");
}

function structuralSignature(source: string) {
  return {
    lines: source.split("\n").length,
    linksOpen: countOccurrences(source, "[["),
    linksClose: countOccurrences(source, "]]"),
    bracesOpen: countOccurrences(source, "{{{"),
    bracesClose: countOccurrences(source, "}}}"),
    tablePipes: countOccurrences(source, "||"),
    wikiDirectives: countOccurrences(source, "#!wiki"),
    foldingDirectives: countOccurrences(source, "#!folding"),
    ifDirectives: countOccurrences(source, "#!if"),
    syntaxDirectives: countOccurrences(source, "#!syntax"),
    headings: headingSignature(source),
  };
}

function validateMaskedTranslation(source: string, translated: string, tokens: ProtectedToken[]) {
  if (!translated.trim()) throw new Error("Translator returned empty NamuMark");
  if (/^\s*```/.test(translated) || /```\s*$/.test(translated)) throw new Error("Translator wrapped NamuMark in a Markdown code fence");
  for (const token of tokens) {
    const occurrences = countOccurrences(translated, token.placeholder);
    if (occurrences !== 1) throw new Error("Translator changed protected " + token.kind + " token " + token.placeholder + " (found " + occurrences + ")");
  }
  const before = structuralSignature(source);
  const after = structuralSignature(translated);
  const keys = Object.keys(before) as Array<keyof typeof before>;
  const mismatches = keys.filter((key) => before[key] !== after[key]);
  if (mismatches.length) {
    const detail = mismatches.map((key) => String(key) + ": " + String(before[key]) + " -> " + String(after[key])).join("; ");
    throw new Error("NamuMark structure changed during translation: " + detail);
  }
}

function splitIntoChunks(source: string, maxChars = DEFAULT_CHUNK_CHARS) {
  if (source.length <= maxChars) return [source];
  const lines = source.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const line of lines) {
    const addition = line.length + (current.length ? 1 : 0);
    if (current.length && currentChars + addition > maxChars) {
      chunks.push(current.join("\n"));
      current = [];
      currentChars = 0;
    }
    current.push(line);
    currentChars += line.length + (current.length > 1 ? 1 : 0);
  }
  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function translationPrompt(sourceTitle: string, chunk: string, chunkIndex: number, chunkCount: number, retryReason?: string) {
  const retry = retryReason ? "\nPrevious attempt failed validation: " + retryReason + "\nFix that structural problem without changing meaning.\n" : "";
  return [
    "You are the translation engine for Kpoparkive, an English K-pop wiki.",
    "",
    "Translate Korean natural-language text in the NamuMark below into clear, factual English for global K-pop readers.",
    "",
    "NON-NEGOTIABLE FORMAT RULES:",
    "1. Return ONLY NamuMark source. No explanation and no code fence.",
    "2. Preserve EVERY line break. Output must have exactly the same number of lines.",
    "3. Preserve all NamuMark syntax and structure exactly: [[ ]], {{{ }}}, ||, heading markers, list markers, #! directives, table/style directives, colors and dimensions.",
    "4. @@KPA_000001@@-style tokens are immutable placeholders. Copy each exactly once; never change, remove, duplicate or reorder them.",
    "5. In [[@@KPA_xxxxxx@@|text]], translate only the visible text after | when appropriate.",
    "6. Keep official group/artist/stage/fandom/song/album/company/brand names, dates, numbers, handles and identifiers unless an established official English form is clear.",
    "7. Translate prose, headings, table labels/cells, captions, lists and explanatory notes. Never summarize, omit, censor or invent facts.",
    "8. Keep encyclopedic meaning, uncertainty, criticism, quotations and attribution intact.",
    "9. Never convert NamuMark to HTML or Markdown.",
    retry,
    "Document title: " + sourceTitle,
    "Chunk: " + String(chunkIndex + 1) + " of " + String(chunkCount),
    "",
    "<NAMUMARK>",
    chunk,
    "</NAMUMARK>",
  ].join("\n");
}

async function geminiTranslate(prompt: string) {
  if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODEL) + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 16384 },
    }),
    cache: "no-store",
  });
  if (!response.ok) throw new Error("Gemini NamuMark translation failed " + response.status + ": " + (await response.text()));
  const payload = (await response.json()) as { candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string }> } }> };
  const candidate = payload.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini returned no translation (finishReason=" + (candidate?.finishReason || "unknown") + ")");
  if (candidate?.finishReason === "MAX_TOKENS") throw new Error("Gemini translation was truncated at max output tokens");
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trimEnd();
}

async function translateChunk(sourceTitle: string, chunk: string, chunkIndex: number, chunkCount: number) {
  const { masked, tokens } = maskNamuMark(chunk);
  let lastError = "";
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const prompt = translationPrompt(sourceTitle, masked, chunkIndex, chunkCount, attempt ? lastError : undefined);
      const translatedMasked = await geminiTranslate(prompt);
      validateMaskedTranslation(masked, translatedMasked, tokens);
      return restoreProtectedTokens(translatedMasked, tokens);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt === MAX_ATTEMPTS - 1) throw new Error("NamuMark translation failed for chunk " + String(chunkIndex + 1) + "/" + String(chunkCount) + " after " + String(MAX_ATTEMPTS) + " attempts: " + lastError);
    }
  }
  throw new Error("NamuMark translation failed unexpectedly");
}

export async function translateNamuMarkToEnglish(sourceTitle: string, sourceWikitext: string): Promise<NamuMarkTranslationResult> {
  const title = String(sourceTitle || "").normalize("NFKC").trim();
  const source = String(sourceWikitext || "").replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  if (!title) throw new Error("sourceTitle is required");
  if (!source.trim()) throw new Error("sourceWikitext is empty");
  const chunks = splitIntoChunks(source);
  const translated: string[] = [];
  for (let index = 0; index < chunks.length; index += 1) translated.push(await translateChunk(title, chunks[index], index, chunks.length));
  const wikitext = translated.join("\n");
  if (structuralSignature(source).lines !== structuralSignature(wikitext).lines) throw new Error("Combined translation changed the document line count");
  return {
    wikitext,
    model: GEMINI_MODEL,
    version: TRANSLATION_VERSION,
    chunks: chunks.length,
    sourceChars: source.length,
    translatedChars: wikitext.length,
  };
}

export const namuMarkTranslationVersion = TRANSLATION_VERSION;
