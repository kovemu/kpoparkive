#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_SUPABASE_URL = "https://hukrrzhltiyirtkxmotj.supabase.co";
const DEFAULT_MODEL = "gpt-5.6-luna";
const TRANSLATION_VERSION = "kpoparkive-openai-v1";
const DEFAULT_CHUNK_CHARS = 24000;
const DEFAULT_STALE_MINUTES = 60;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT, ".env.local"));
loadEnv(path.join(ROOT, ".env"));

const args = process.argv.slice(2);
const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? found.slice(name.length + 3) : "";
};

const selfTest = args.includes("--self-test");
const once = args.includes("--once");
const runId = valueArg("run");
const workerId =
  valueArg("worker-id") ||
  "translate-" + process.pid + "-" + crypto.randomBytes(3).toString("hex");
const forcedModel =
  valueArg("model") ||
  process.env.KPOPARKIVE_TRANSLATION_MODEL ||
  "";

function modelForAttempt(attempt) {
  if (forcedModel) return forcedModel;
  const value = Number(attempt || 1);
  if (value <= 1) return "gpt-5.6-luna";
  if (value === 2) return "gpt-5.6-terra";
  return "gpt-5.6-sol";
}
const chunkChars = Math.max(
  4000,
  Number(valueArg("chunk-chars") || process.env.KPOPARKIVE_TRANSLATION_CHUNK_CHARS || DEFAULT_CHUNK_CHARS) ||
    DEFAULT_CHUNK_CHARS,
);
const staleMinutes = Math.max(
  15,
  Number(valueArg("stale-minutes") || DEFAULT_STALE_MINUTES) ||
    DEFAULT_STALE_MINUTES,
);

const supabaseUrl = String(
  process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
).replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const openaiApiKey = process.env.OPENAI_API_KEY || "";
const dataRoot = path.resolve(
  process.env.KPOPARKIVE_DATA_DIR || path.join(ROOT, ".kpoparkive-data"),
);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dbHeaders(extra = {}) {
  if (!serviceRoleKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
  return {
    apikey: serviceRoleKey,
    Authorization: "Bearer " + serviceRoleKey,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(supabaseUrl + "/rest/v1/" + pathname, {
    ...init,
    headers: { ...dbHeaders(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("Supabase " + response.status + ": " + body.slice(0, 1200));
  }
  return body ? JSON.parse(body) : null;
}

function safeSegment(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 120);
}

function jobDir(job) {
  return path.join(
    dataRoot,
    "pipeline",
    safeSegment(job.run_id),
    safeSegment(job.id),
  );
}

function makeChunks(source, targetChars = DEFAULT_CHUNK_CHARS) {
  const lines = String(source || "").split(/(?<=\n)/);
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if (current && current.length + line.length > targetChars) {
      chunks.push(current);
      current = "";
    }
    current += line;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [String(source || "")];
}

function extractLinkTargets(text) {
  const targets = [];
  for (const match of String(text).matchAll(/\[\[([^\]\n]+?)\]\]/g)) {
    const inside = String(match[1] || "");
    const target = inside.split("|", 1)[0].trim();
    if (target) targets.push(target);
  }
  return targets;
}

function extractUrls(text) {
  return [...String(text).matchAll(/https?:\/\/[^\s\]}|<>"]+/g)].map(
    (match) => match[0],
  );
}

function extractIncludeNames(text) {
  return [...String(text).matchAll(/\[include\(\s*([^,\)\n]+)/gi)].map(
    (match) => String(match[1] || "").trim(),
  );
}

function extractYoutubeIds(text) {
  return [
    ...String(text).matchAll(
      /\[(?:youtube|youtu\.be)\(\s*([A-Za-z0-9_-]{6,})/gi,
    ),
  ].map((match) => match[1]);
}

function headingSignature(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^\s*(={1,6})\s*.*?\s*\1\s*$/);
      return match ? match[1].length : 0;
    })
    .filter(Boolean);
}

function structuralSignature(text) {
  const value = String(text || "");
  return {
    links: extractLinkTargets(value),
    urls: extractUrls(value),
    includes: extractIncludeNames(value),
    youtube: extractYoutubeIds(value),
    headings: headingSignature(value),
    tableDelimiters: (value.match(/\|\|/g) || []).length,
    tripleOpen: (value.match(/\{\{\{/g) || []).length,
    tripleClose: (value.match(/\}\}\}/g) || []).length,
    footnoteOpen: (value.match(/\[\*/g) || []).length,
  };
}

function sameArray(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function validateStructure(source, translated) {
  const before = structuralSignature(source);
  const after = structuralSignature(translated);
  const errors = [];

  for (const key of ["links", "urls", "includes", "youtube", "headings"]) {
    if (!sameArray(before[key], after[key])) {
      errors.push(
        key +
          "_changed:" +
          before[key].length +
          "->" +
          after[key].length,
      );
    }
  }

  for (const key of [
    "tableDelimiters",
    "tripleOpen",
    "tripleClose",
    "footnoteOpen",
  ]) {
    if (before[key] !== after[key]) {
      errors.push(key + "_changed:" + before[key] + "->" + after[key]);
    }
  }

  return { ok: errors.length === 0, errors, before, after };
}

function responseOutputText(response) {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const content of item.content || []) {
      if (content?.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  return "";
}

async function translateChunk({
  sourceTitle,
  chunk,
  chunkIndex,
  chunkTotal,
  currentTranslatedTitle,
  requestModel,
  retryFeedback = "",
}) {
  if (!openaiApiKey) throw new Error("OPENAI_API_KEY is required.");

  const instructions = [
    "You are the production translation engine for Kpoparkive.",
    "Translate Korean NamuMark wiki content into natural, factual English.",
    "Do not summarize, omit, reorder, add, or editorialize any information.",
    "Preserve NamuMark structure exactly.",
    "Never change internal-link targets. You may translate only the visible label after |.",
    "Never change file/image targets, URLs, template/include names, YouTube IDs, CSS, HTML attributes, table delimiters, folding syntax, anchors, or control syntax.",
    "Never change template parameter names or placeholders such as @name@, @1@, {{{#...}}}, or other substitution tokens. Translate only their user-visible values when appropriate.",
    "Translate all user-visible Korean text, including headings, tables, folding content, footnotes, captions, labels, program/place/person display values, and visible template parameter values.",
    "If an internal link has a Korean target with no explicit label and would render Korean visibly, preserve the target and add an English visible label using [[target|English label]].",
    "Use established official English names and romanizations for K-pop artists, releases, companies, broadcasts, venues, and fandoms when known.",
    "Return only the requested structured JSON.",
  ].join("\n");

  const input = [
    "Document title: " + sourceTitle,
    "Chunk: " + (chunkIndex + 1) + "/" + chunkTotal,
    currentTranslatedTitle
      ? "Preferred translated document title: " + currentTranslatedTitle
      : "Provide a concise English document title preserving official artist names.",
    retryFeedback ? "Previous validation failure: " + retryFeedback : "",
    "",
    "SOURCE NAMUMARK:",
    chunk,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + openaiApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: requestModel,
      instructions,
      input,
      store: false,
      reasoning: { effort: "low" },
      text: {
        verbosity: "low",
        format: {
          type: "json_schema",
          name: "kpoparkive_translation_chunk",
          strict: true,
          schema: {
            type: "object",
            properties: {
              translated_title: { type: "string" },
              translated_wikitext: { type: "string" },
            },
            required: ["translated_title", "translated_wikitext"],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: 32768,
    }),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      "OpenAI " + response.status + ": " + body.slice(0, 1600),
    );
  }

  const parsedResponse = JSON.parse(body);
  const output = responseOutputText(parsedResponse);
  if (!output) throw new Error("OpenAI response contained no output_text");

  let result;
  try {
    result = JSON.parse(output);
  } catch {
    throw new Error("OpenAI structured output was not valid JSON");
  }

  if (
    typeof result?.translated_wikitext !== "string" ||
    !result.translated_wikitext
  ) {
    throw new Error("translated_wikitext is missing");
  }

  return {
    translatedTitle: String(result.translated_title || "").trim(),
    translatedWikitext: result.translated_wikitext,
    usage: parsedResponse.usage || {},
    responseId: parsedResponse.id || null,
  };
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const rows = await db(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&stage=eq.translation" +
      "&status=eq.running" +
      "&locked_at=lt." +
      encodeURIComponent(cutoff) +
      "&select=id,source_title,locked_by,locked_at",
  );

  for (const row of rows || []) {
    await db("pipeline_jobs?id=eq." + encodeURIComponent(row.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "retry",
        locked_by: null,
        locked_at: null,
        last_error:
          "Recovered stale translation lease from " +
          (row.locked_by || "unknown"),
        updated_at: new Date().toISOString(),
      }),
    });
  }

  return (rows || []).length;
}

async function claimJob() {
  const rows = await db("rpc/claim_pipeline_job", {
    method: "POST",
    body: JSON.stringify({
      p_run_id: runId,
      p_worker_id: workerId,
      p_stage: "translation",
    }),
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function fetchDocument(id) {
  const rows = await db(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,source_title,source_hash,source_wikitext,translated_title,content_revision_no,translation_status" +
      "&limit=1",
  );
  return rows?.[0] || null;
}

async function updateJob(jobId, patch) {
  await db("pipeline_jobs?id=eq." + encodeURIComponent(jobId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function enqueueStage(job, stage) {
  await db(
    "pipeline_jobs?on_conflict=run_id,source_document_id,stage",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        run_id: job.run_id,
        source_document_id: job.source_document_id,
        source_title: job.source_title,
        stage,
        status: "queued",
        attempt: 0,
        max_attempts: 3,
        chunk_current: 0,
        chunk_total: 0,
        checkpoint: {},
        last_error: null,
        locked_by: null,
        locked_at: null,
        started_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

async function markRetry(job, error, checkpoint = null) {
  const nextStatus =
    Number(job.attempt || 0) >= Number(job.max_attempts || 3)
      ? "needs_review"
      : "retry";

  await updateJob(job.id, {
    status: nextStatus,
    locked_by: null,
    locked_at: null,
    last_error: String(error?.message || error || "translation failed").slice(
      0,
      4000,
    ),
    ...(checkpoint ? { checkpoint } : {}),
    ...(nextStatus === "needs_review"
      ? { finished_at: new Date().toISOString() }
      : {}),
  });
}

async function saveRevision({
  document,
  translatedTitle,
  translatedWikitext,
  translationModelLabel,
}) {
  const latest = await fetchDocument(document.id);
  if (!latest) throw new Error("source document disappeared");

  const expectedSourceHash =
    document.source_hash || sha256(document.source_wikitext || "");
  const latestSourceHash =
    latest.source_hash || sha256(latest.source_wikitext || "");

  if (expectedSourceHash !== latestSourceHash) {
    throw new Error(
      "source_changed_during_translation:" +
        expectedSourceHash.slice(0, 8) +
        "->" +
        latestSourceHash.slice(0, 8),
    );
  }

  const revisionRows = await db("rpc/save_source_document_revision", {
    method: "POST",
    body: JSON.stringify({
      p_document_id: document.id,
      p_content_wikitext: translatedWikitext,
      p_content_language: "en",
      p_summary: "Automated English translation from canonical NamuMark",
      p_editor_label: "pipeline:" + translationModelLabel,
    }),
  });

  const revision = Array.isArray(revisionRows)
    ? revisionRows[0]?.revision_no
    : revisionRows?.revision_no;

  if (!revision) throw new Error("revision save returned no revision number");

  const now = new Date().toISOString();
  await db("source_documents?id=eq." + encodeURIComponent(document.id), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      translated_title: translatedTitle || document.source_title,
      translation_status: "translated_by_chatgpt",
      translation_version: TRANSLATION_VERSION + ":" + translationModelLabel,
      translated_at: now,
      translation_source_hash: latestSourceHash,
      updated_at: now,
    }),
  });

  return Number(revision);
}

async function processJob(job) {
  const requestModel = modelForAttempt(job.attempt);
  const document = await fetchDocument(job.source_document_id);
  if (!document) throw new Error("source_document_not_found");
  if (!document.source_wikitext) throw new Error("missing_canonical_raw");

  const templateDocument = /^(?:틀|Template):/i.test(
    String(document.source_title || ""),
  );
  const sourceHash = document.source_hash || sha256(document.source_wikitext);
  const chunks = makeChunks(document.source_wikitext, chunkChars);
  const dir = jobDir(job);
  const chunksDir = path.join(dir, "chunks");
  fs.mkdirSync(chunksDir, { recursive: true });

  let checkpoint =
    job.checkpoint && typeof job.checkpoint === "object" ? job.checkpoint : {};

  if (checkpoint.forceRetranslate === true) {
    for (const name of fs.readdirSync(chunksDir)) {
      if (name.endsWith(".txt")) {
        fs.unlinkSync(path.join(chunksDir, name));
      }
    }

    checkpoint = {
      ...checkpoint,
      completedChunks: 0,
      forceRetranslate: false,
      forcedAt: new Date().toISOString(),
    };
  }

  if (
    checkpoint.sourceHash &&
    checkpoint.sourceHash !== sourceHash
  ) {
    for (const name of fs.readdirSync(chunksDir)) {
      if (name.endsWith(".txt")) fs.unlinkSync(path.join(chunksDir, name));
    }
    checkpoint = {};
  }

  let translatedTitle = templateDocument
    ? String(document.source_title || "").trim()
    : String(
        checkpoint.translatedTitle ||
          document.translated_title ||
          "",
      ).trim();

  const downstreamFeedback = Array.isArray(checkpoint.renderFeedback)
    ? checkpoint.renderFeedback.join(", ")
    : String(checkpoint.renderFeedback || "").trim();
  let inputTokens = Number(checkpoint.inputTokens || 0);
  let outputTokens = Number(checkpoint.outputTokens || 0);
  let modelsUsed = [
    ...new Set([
      ...(Array.isArray(checkpoint.modelsUsed)
        ? checkpoint.modelsUsed
        : checkpoint.model
          ? [checkpoint.model]
          : []),
      requestModel,
    ]),
  ];

  await updateJob(job.id, {
    chunk_total: chunks.length,
    chunk_current: Number(checkpoint.completedChunks || 0),
    checkpoint: {
      ...checkpoint,
      sourceHash,
      model: requestModel,
      modelsUsed,
      chunkChars,
      chunkTotal: chunks.length,
      workspace: path.relative(dataRoot, dir),
    },
    locked_by: workerId,
    locked_at: new Date().toISOString(),
  });

  for (let index = 0; index < chunks.length; index += 1) {
    const outputPath = path.join(
      chunksDir,
      String(index + 1).padStart(4, "0") + ".txt",
    );

    if (fs.existsSync(outputPath)) {
      const existing = fs.readFileSync(outputPath, "utf8");
      const validation = validateStructure(chunks[index], existing);
      if (validation.ok) {
        await updateJob(job.id, {
          chunk_current: index + 1,
          locked_by: workerId,
          locked_at: new Date().toISOString(),
        });
        continue;
      }
      fs.unlinkSync(outputPath);
    }

    let translated = null;
    let lastValidation = null;

    for (let localAttempt = 1; localAttempt <= 2; localAttempt += 1) {
      const result = await translateChunk({
        sourceTitle: document.source_title,
        chunk: chunks[index],
        chunkIndex: index,
        chunkTotal: chunks.length,
        currentTranslatedTitle: translatedTitle,
        requestModel,
        retryFeedback: lastValidation
          ? lastValidation.errors.join(", ")
          : downstreamFeedback,
      });

      const validation = validateStructure(
        chunks[index],
        result.translatedWikitext,
      );

      inputTokens += Number(result.usage?.input_tokens || 0);
      outputTokens += Number(result.usage?.output_tokens || 0);

      if (validation.ok) {
        translated = result.translatedWikitext;
        if (!translatedTitle && result.translatedTitle) {
          translatedTitle = result.translatedTitle;
        }
        break;
      }

      lastValidation = validation;
    }

    if (translated == null) {
      throw new Error(
        "chunk_structure_validation_failed:" +
          (lastValidation?.errors || []).join("|"),
      );
    }

    fs.writeFileSync(outputPath, translated, "utf8");

    checkpoint = {
      sourceHash,
      model: requestModel,
      modelsUsed,
      chunkChars,
      chunkTotal: chunks.length,
      completedChunks: index + 1,
      translatedTitle,
      inputTokens,
      outputTokens,
      workspace: path.relative(dataRoot, dir),
    };

    await updateJob(job.id, {
      chunk_current: index + 1,
      chunk_total: chunks.length,
      checkpoint,
      locked_by: workerId,
      locked_at: new Date().toISOString(),
      last_error: null,
    });
  }

  const translatedWikitext = chunks
    .map((_, index) =>
      fs.readFileSync(
        path.join(chunksDir, String(index + 1).padStart(4, "0") + ".txt"),
        "utf8",
      ),
    )
    .join("");

  const finalValidation = validateStructure(
    document.source_wikitext,
    translatedWikitext,
  );

  if (!finalValidation.ok) {
    throw new Error(
      "document_structure_validation_failed:" +
        finalValidation.errors.join("|"),
    );
  }

  fs.writeFileSync(
    path.join(dir, "translated.namu"),
    translatedWikitext,
    "utf8",
  );

  modelsUsed = [...new Set([...modelsUsed, requestModel])];

  const revision = await saveRevision({
    document,
    translatedTitle: templateDocument
      ? document.source_title
      : translatedTitle,
    translatedWikitext,
    translationModelLabel:
      modelsUsed.length === 1 ? modelsUsed[0] : "mixed(" + modelsUsed.join(",") + ")",
  });

  await enqueueStage(job, "en_render");

  await updateJob(job.id, {
    status: "pass",
    chunk_current: chunks.length,
    chunk_total: chunks.length,
    checkpoint: {
      ...checkpoint,
      completedChunks: chunks.length,
      translatedTitle,
      inputTokens,
      outputTokens,
      modelsUsed,
      revision,
      completedAt: new Date().toISOString(),
    },
    locked_by: null,
    locked_at: null,
    last_error: null,
    finished_at: new Date().toISOString(),
  });

  console.log(
    "TRANSLATED " +
      document.source_title +
      " · r" +
      revision +
      " · chunks=" +
      chunks.length +
      " · model=" +
      (modelsUsed.length === 1 ? modelsUsed[0] : modelsUsed.join("+")) +
      " · tokens=" +
      inputTokens +
      "/" +
      outputTokens,
  );
}

function runSelfTest() {
  const sample = [
    "== 개요 ==\n",
    "[[방탄소년단|방탄소년단]]은 대한민국의 보이 그룹이다.\n",
    "||<bgcolor=#000> 이름 || 값 ||\n",
    "[[파일:테스트 이미지.png|width=100]]\n",
    "[include(틀:테스트, 값=한국어)]\n",
    "https://example.com/a?x=1\n",
    "[* 주석 내용]\n",
  ].join("");

  const translated = [
    "== Overview ==\n",
    "[[방탄소년단|BTS]] is a South Korean boy group.\n",
    "||<bgcolor=#000> Name || Value ||\n",
    "[[파일:테스트 이미지.png|width=100]]\n",
    "[include(틀:테스트, 값=English)]\n",
    "https://example.com/a?x=1\n",
    "[* Footnote text]\n",
  ].join("");

  const chunks = makeChunks(sample, 50);
  const validation = validateStructure(sample, translated);

  if (chunks.length < 2) throw new Error("chunker self-test failed");
  if (!validation.ok) {
    throw new Error(
      "structure self-test failed: " + validation.errors.join(","),
    );
  }

  const broken = translated.replace(
    "[[방탄소년단|BTS]]",
    "[[BTS|BTS]]",
  );
  const brokenValidation = validateStructure(sample, broken);
  if (brokenValidation.ok) {
    throw new Error("validator failed to detect changed link target");
  }

  console.log(
    "TRANSLATION WORKER SELF-TEST PASS · chunks=" +
      chunks.length +
      " · protected-link mutation detected",
  );
}

if (selfTest) {
  runSelfTest();
  process.exit(0);
}

if (!runId) {
  console.error(
    "Usage: npm run namu:translate-worker -- --run=<pipeline-run-id> [--once]",
  );
  process.exit(2);
}
if (!serviceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(2);
}
if (!openaiApiKey) {
  console.error("OPENAI_API_KEY is required.");
  process.exit(2);
}

const recovered = await recoverStaleJobs();
if (recovered > 0) {
  console.log("Recovered " + recovered + " stale translation job(s).");
}

console.log(
  "Kpoparkive Translation Worker · " +
    workerId +
    " · model-policy=" +
    (forcedModel || "Luna->Terra->Sol") +
    " · run=" +
    runId,
);

while (true) {
  const job = await claimJob();
  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }

  console.log(
    "CLAIMED " +
      job.source_title +
      " · attempt=" +
      job.attempt +
      "/" +
      job.max_attempts,
  );

  try {
    await processJob(job);
  } catch (error) {
    console.error(
      "TRANSLATION FAILED " +
        job.source_title +
        " · " +
        String(error?.message || error),
    );
    await markRetry(job, error);
  }

  if (once) break;
}
