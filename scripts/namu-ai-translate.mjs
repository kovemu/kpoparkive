import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnv(path.resolve(".env.local"));
loadEnv(path.resolve(".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const AUTO_PUBLISH = process.env.KPOPARKIVE_AUTO_PUBLISH_TRANSLATION !== "0";
const TRANSLATION_VERSION = "namumark-ai-en-v1";
const MAX_CHUNK_CHARS = Math.max(8000, Number(process.env.KPOPARKIVE_TRANSLATION_CHUNK_CHARS || 24000) || 24000);
const sourceTitle = decodeURIComponent(process.argv[2] || "").normalize("NFKC").trim();

if (!sourceTitle) throw new Error("Usage: node scripts/namu-ai-translate.mjs <source-title>");
if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is missing");
if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY or GOOGLE_AI_API_KEY is missing");

function headers(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + pathname, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error("Supabase " + response.status + ": " + text);
  return text ? JSON.parse(text) : null;
}

async function patchDocument(id, payload) {
  await db("source_documents?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...payload, updated_at: new Date().toISOString() }),
  });
}

function countToken(text, token) {
  let count = 0;
  let from = 0;
  while ((from = text.indexOf(token, from)) !== -1) {
    count += 1;
    from += token.length;
  }
  return count;
}

function stripOperationalSource(source) {
  return String(source || "").replace(
    /^\s*\[include\(\s*틀\s*:\s*접근\s*제한(?:\s*,[^\]\r\n]*)?\)\]\s*$/gim,
    "",
  );
}

function extractIncludes(text) {
  return [...text.matchAll(/\[include\([^\]\r\n]*\)\]/gi)].map((m) => m[0]);
}

function extractUrls(text) {
  return [...text.matchAll(/https?:\/\/[^\s\]|}<>"']+/gi)].map((m) => m[0]);
}

function extractLinks(text) {
  return [...text.matchAll(/\[\[([^\[\]]+?)\]\]/g)].map((m) => {
    const body = m[1];
    const pipe = body.indexOf("|");
    return {
      target: (pipe >= 0 ? body.slice(0, pipe) : body).trim(),
      label: pipe >= 0 ? body.slice(pipe + 1) : null,
    };
  });
}

function replaceByOrder(text, regex, replacements) {
  let index = 0;
  return text.replace(regex, (full) => {
    const value = replacements[index];
    index += 1;
    return value === undefined ? full : value;
  });
}

function restoreProtected(source, translated) {
  const sourceIncludes = extractIncludes(source);
  const translatedIncludes = extractIncludes(translated);
  if (sourceIncludes.length !== translatedIncludes.length) {
    throw new Error("include count changed " + sourceIncludes.length + " -> " + translatedIncludes.length);
  }
  translated = replaceByOrder(translated, /\[include\([^\]\r\n]*\)\]/gi, sourceIncludes);

  const sourceUrls = extractUrls(source);
  const translatedUrls = extractUrls(translated);
  if (sourceUrls.length !== translatedUrls.length) {
    throw new Error("URL count changed " + sourceUrls.length + " -> " + translatedUrls.length);
  }
  translated = replaceByOrder(translated, /https?:\/\/[^\s\]|}<>"']+/gi, sourceUrls);

  const sourceLinks = extractLinks(source);
  const translatedLinks = extractLinks(translated);
  if (sourceLinks.length !== translatedLinks.length) {
    throw new Error("link count changed " + sourceLinks.length + " -> " + translatedLinks.length);
  }

  let linkIndex = 0;
  translated = translated.replace(/\[\[([^\[\]]+?)\]\]/g, (_full, body) => {
    const sourceLink = sourceLinks[linkIndex++];
    const pipe = String(body).indexOf("|");
    const label = pipe >= 0 ? String(body).slice(pipe + 1) : null;
    if (label !== null) return "[[" + sourceLink.target + "|" + label + "]]";
    if (sourceLink.label !== null) return "[[" + sourceLink.target + "|" + sourceLink.label + "]]";
    return "[[" + sourceLink.target + "]]";
  });

  return translated;
}

function validateStructure(source, translated) {
  const beforeLines = source.split("\n").length;
  const afterLines = translated.split("\n").length;
  if (beforeLines !== afterLines) throw new Error("line count changed " + beforeLines + " -> " + afterLines);

  for (const token of ["[[", "]]", "{{{", "}}}", "||", "[*", "[br]", "[clearfix]"]) {
    const before = countToken(source, token);
    const after = countToken(translated, token);
    if (before !== after) throw new Error("syntax token " + token + " changed " + before + " -> " + after);
  }

  const heading = /^={1,6}(?:#)?\s*.+?\s*(?:#)?={1,6}\s*$/;
  const beforeHeadings = source.split("\n").filter((line) => heading.test(line)).length;
  const afterHeadings = translated.split("\n").filter((line) => heading.test(line)).length;
  if (beforeHeadings !== afterHeadings) throw new Error("heading count changed " + beforeHeadings + " -> " + afterHeadings);
}

function splitSource(source) {
  const lines = source.split("\n");
  const chunks = [];
  let current = [];
  let chars = 0;
  let braceDepth = 0;

  for (const line of lines) {
    const added = line.length + (current.length ? 1 : 0);
    if (current.length && chars + added > MAX_CHUNK_CHARS && braceDepth <= 0) {
      chunks.push(current.join("\n"));
      current = [];
      chars = 0;
    }
    current.push(line);
    chars += line.length + (current.length > 1 ? 1 : 0);
    braceDepth = Math.max(0, braceDepth + countToken(line, "{{{") - countToken(line, "}}}"));
  }

  if (current.length) chunks.push(current.join("\n"));
  return chunks;
}

function stripFence(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\x60\x60\x60(?:text|markdown|namumark)?\s*\n([\s\S]*?)\n\x60\x60\x60$/i);
  return match ? match[1] : trimmed;
}

async function gemini(prompt, maxOutputTokens = 32768) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(GEMINI_MODEL) + ":generateContent?key=" + encodeURIComponent(GEMINI_API_KEY);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error("Gemini " + response.status + ": " + raw.slice(0, 1000));
  const payload = JSON.parse(raw);
  const text = payload?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("") || "";
  if (!text.trim()) throw new Error("Gemini returned empty output");
  return text;
}

async function translateTitle(title) {
  const prompt = [
    "Translate this Korean K-pop wiki document title into the natural English title used by international K-pop fans.",
    "Keep established artist, group, member, song, album, label and fandom names unchanged when they already have an official English or romanized form.",
    "For slash-separated subpages preserve the slash hierarchy and translate only descriptive Korean segments.",
    "Return one line only. No explanation or markdown.",
    "",
    title,
  ].join("\n");
  return stripFence(await gemini(prompt, 512)).split("\n")[0].trim() || title;
}

async function translateChunk(chunk, index, total) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const retry = lastError ? "Previous output failed validation: " + lastError.message + ". Correct it exactly." : "";
    const prompt = [
      "Translate Korean NamuMark K-pop wiki source into natural encyclopedic English for Kpoparkive.",
      "Do not summarize, omit, add, censor or invent facts.",
      "Return ONLY NamuMark source. No code fence or commentary.",
      "Keep EXACTLY the same number of lines and the same line order.",
      "Preserve all NamuMark syntax: headings, tables, triple braces, directives, colors, widths, styles, macros, footnotes and list markers.",
      "Never change [include(...)] calls, URLs, file targets, category targets, dates, numbers, IDs, colors, style values or YouTube IDs.",
      "For [[target|label]], target must remain unchanged and only the visible label may be translated.",
      "For bare [[Korean target]], you may use [[same Korean target|English label]] so the link target stays valid.",
      "Keep official K-pop proper names and official song/album titles in their established English or romanized form.",
      "Translate headings, prose, table labels/cells, lists and footnote prose.",
      retry,
      "Chunk " + (index + 1) + " of " + total + ":",
      "-----BEGIN NAMUMARK-----",
      chunk,
      "-----END NAMUMARK-----",
    ].join("\n");

    try {
      let result = stripFence(await gemini(prompt));
      const beginToken = "-----BEGIN NAMUMARK-----";
      const endToken = "-----END NAMUMARK-----";
      const begin = result.indexOf(beginToken);
      const end = result.lastIndexOf(endToken);
      if (begin >= 0 && end > begin) {
        result = result.slice(begin + beginToken.length, end).replace(/^\s*\n|\n\s*$/g, "");
      }
      result = restoreProtected(chunk, result);
      validateStructure(chunk, result);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.warn("TRANSLATION RETRY chunk=" + (index + 1) + "/" + total + " attempt=" + attempt + ": " + lastError.message);
    }
  }
  throw lastError || new Error("translation failed");
}

async function translateSource(source) {
  const cleaned = stripOperationalSource(source).replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "");
  const chunks = splitSource(cleaned);
  console.log("AI TRANSLATION " + sourceTitle + ": " + cleaned.length.toLocaleString() + " chars, " + chunks.length + " chunk(s)");
  const output = [];
  for (let i = 0; i < chunks.length; i += 1) {
    console.log("  translating chunk " + (i + 1) + "/" + chunks.length);
    output.push(await translateChunk(chunks[i], i, chunks.length));
  }
  const translated = output.join("\n");
  validateStructure(cleaned, translated);
  return translated;
}

function runRenderer(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--no-node-snapshot",
      path.resolve("scripts/namumark-thetree-content.mjs"),
      encodeURIComponent(title),
    ], { env: { ...process.env }, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error("The Tree renderer failed code=" + String(code) + " signal=" + String(signal || "none")));
    });
  });
}

async function publish(documentId) {
  const rows = await db(
    "source_documents?id=eq." + encodeURIComponent(documentId) +
    "&select=content_wikitext,content_language,content_revision_no,content_namumark_html,content_namumark_meta,content_namumark_engine,content_namumark_engine_version,content_namumark_rendered_at&limit=1"
  );
  const row = rows?.[0];
  if (!row?.content_namumark_html || !row?.content_namumark_rendered_at) {
    throw new Error("The Tree renderer did not save translated HTML");
  }
  const now = new Date().toISOString();
  await patchDocument(documentId, {
    content_status: "published",
    published_content_wikitext: row.content_wikitext,
    published_content_language: row.content_language || "en",
    published_revision_no: Number(row.content_revision_no || 0),
    published_namumark_html: row.content_namumark_html,
    published_namumark_meta: row.content_namumark_meta || null,
    published_namumark_engine: row.content_namumark_engine || null,
    published_namumark_engine_version: row.content_namumark_engine_version || null,
    published_at: now,
  });
}

async function main() {
  const rows = await db(
    "source_documents?source=eq.namu_mirror&source_title=eq." + encodeURIComponent(sourceTitle) +
    "&select=id,source_title,source_wikitext,source_hash&limit=1"
  );
  const row = rows?.[0];
  if (!row?.id || !row?.source_wikitext) throw new Error("No captured raw source found for " + sourceTitle);

  const sourceHash = crypto.createHash("sha256").update(row.source_wikitext).digest("hex");
  await patchDocument(row.id, {
    source_hash: sourceHash,
    translation_status: "ready",
    translation_version: TRANSLATION_VERSION,
  });

  try {
    const results = await Promise.all([translateTitle(row.source_title), translateSource(row.source_wikitext)]);
    const translatedTitle = results[0];
    const translatedSource = results[1];

    const revisionRows = await db("rpc/save_source_document_revision", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        p_document_id: row.id,
        p_content_wikitext: translatedSource,
        p_content_language: "en",
        p_summary: "Automatic AI translation from captured NamuWiki source (" + TRANSLATION_VERSION + ")",
        p_editor_label: "ai-translation",
      }),
    });
    const revisionNo = Number(revisionRows?.[0]?.revision_no || 0);

    await patchDocument(row.id, {
      translated_title: translatedTitle,
      translation_status: "translated",
      translation_version: TRANSLATION_VERSION,
      translated_at: new Date().toISOString(),
    });

    console.log("AI TRANSLATION SAVED " + sourceTitle + " -> " + translatedTitle + " r" + revisionNo);
    await runRenderer(sourceTitle);

    if (AUTO_PUBLISH) {
      await publish(row.id);
      console.log("AI TRANSLATION PUBLISHED " + sourceTitle);
    } else {
      console.log("AI TRANSLATION READY AS DRAFT " + sourceTitle);
    }
  } catch (error) {
    await patchDocument(row.id, {
      translation_status: "failed",
      translation_version: TRANSLATION_VERSION,
    }).catch(() => {});
    throw error;
  }
}

main().catch((error) => {
  console.error("AI TRANSLATION FAILED " + sourceTitle + ": " + (error instanceof Error ? error.stack || error.message : String(error)));
  process.exitCode = 1;
});
