import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { DOM_TO_NAMUMARK_VERSION, compareDomFidelity, convertDomToNamuMark } from "./lib/dom-to-namumark.mjs";

const ROOT_DIR = process.cwd();
const VERIFY_THRESHOLD = 0.88;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");

function normalizeTitle(value) { return String(value || "").normalize("NFKC").trim(); }
function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function eq(value) { return encodeURIComponent(String(value || "")); }

function headers(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: headers(init.headers || {}),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function rpc(name, body) {
  return db(`rpc/${name}`, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(body),
  });
}

async function getFallback(ownerTitle, templateTitle) {
  const rows = await db(
    `template_dom_fallbacks?source_title=eq.${eq(ownerTitle)}` +
    `&template_title=eq.${eq(templateTitle)}` +
    "&select=*&order=updated_at.desc&limit=1"
  );
  return rows?.[0] || null;
}

async function getDocument(templateTitle) {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
    `&source_title=eq.${eq(templateTitle)}` +
    "&select=id,source_title,source_format,source_wikitext,content_wikitext,content_revision_no&limit=1"
  );
  return rows?.[0] || null;
}

async function createOrRefreshSynthetic(ownerTitle, templateTitle, sourceResult, fallback) {
  const now = new Date().toISOString();
  const base = {
    source_url: `synthetic://dom-fallback/${encodeURIComponent(ownerTitle)}/${encodeURIComponent(templateTitle)}`,
    root_title: ownerTitle,
    crawl_depth: 0,
    source_wikitext: sourceResult.namumark,
    source_format: "namumark-synthetic-dom",
    source_extraction_version: DOM_TO_NAMUMARK_VERSION,
    source_hash: sha256(sourceResult.namumark),
    raw_extracted_at: now,
    updated_at: now,
    source_render_manifest: {
      kind: "dom-synthetic-template",
      converterVersion: DOM_TO_NAMUMARK_VERSION,
      fallbackId: fallback.id,
      ownerTitle,
      templateTitle,
      sourceHtmlHash: fallback.source_html_hash || sha256(fallback.source_html),
      generatedAt: now,
      staticFidelity: sourceResult.fidelity,
    },
    source_fidelity_meta: {
      stage: "converted",
      converterVersion: DOM_TO_NAMUMARK_VERSION,
      static: sourceResult.fidelity,
    },
  };

  const existing = await getDocument(templateTitle);
  if (existing) {
    if (!String(existing.source_format || "").startsWith("namumark-synthetic-dom")) {
      throw new Error(`Refusing to overwrite non-synthetic document: ${templateTitle}`);
    }
    await db(`source_documents?id=eq.${eq(existing.id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        ...base,
        source_namumark_html: null,
        source_namumark_meta: null,
        source_namumark_engine: null,
        source_namumark_engine_version: null,
        source_namumark_rendered_at: null,
      }),
    });
    return existing.id;
  }

  const rows = await db("source_documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      source: "namu_mirror",
      source_title: templateTitle,
      fetched_at: now,
      translation_status: "pending_chatgpt",
      ...base,
    }),
  });
  if (!rows?.[0]?.id) throw new Error("Failed to create synthetic source document");
  return rows[0].id;
}

async function saveEnglish(documentId, templateTitle, englishResult) {
  if (!englishResult?.namumark) return null;

  const rows = await db(
    `source_documents?id=eq.${eq(documentId)}&select=id,content_wikitext,content_revision_no&limit=1`
  );
  const existing = rows?.[0] || null;
  const sameContent =
    typeof existing?.content_wikitext === "string" &&
    existing.content_wikitext === englishResult.namumark;

  let rev = null;
  if (sameContent) {
    rev = { revision_no: Number(existing?.content_revision_no || 0) || 0, unchanged: true };
  } else {
    const saved = await rpc("save_source_document_revision", {
      p_document_id: documentId,
      p_content_wikitext: englishResult.namumark,
      p_content_language: "en",
      p_summary: `Synthetic English NamuMark recovered from DOM for ${templateTitle}`,
      p_editor_label: "DOM Recovery",
    });
    rev = saved?.[0] || null;
  }

  await db(`source_documents?id=eq.${eq(documentId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      translation_status: "reviewed",
      translation_version: "dom-synthetic-en-v1",
      translated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  return rev;
}

async function patchFallback(id, patch) {
  await db(`template_dom_fallbacks?id=eq.${eq(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  });
}

function runRenderer(templateTitle) {
  const result = spawnSync(
    process.execPath,
    ["--no-node-snapshot", "scripts/namumark-thetree-compat-poc.mjs", templateTitle],
    { cwd: ROOT_DIR, env: process.env, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`The Tree render exited with ${result.status}`);
}

function runContentRenderer(title) {
  const result = spawnSync(
    process.execPath,
    ["--no-node-snapshot", "scripts/namumark-thetree-content.mjs", title],
    { cwd: ROOT_DIR, env: process.env, stdio: "inherit" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`English The Tree render exited with ${result.status}`);
}

async function publishRenderedContent(title) {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
    `&source_title=eq.${eq(title)}` +
    "&select=id,source_title,content_wikitext,content_language,content_revision_no,content_namumark_html,content_namumark_meta,content_namumark_engine,content_namumark_engine_version&limit=1"
  );
  const row = rows?.[0];
  if (!row?.id || !row?.content_wikitext || !row?.content_namumark_html) {
    throw new Error(`Rendered English content missing for ${title}`);
  }
  const meta = row.content_namumark_meta || {};
  if (meta.hasError) throw new Error(`The Tree content render error for ${title}: ${meta.errorCode || "unknown"}`);
  if (Number(meta.missingFileCount || 0) > 0) throw new Error(`${title} still has ${meta.missingFileCount} missing file(s)`);
  if (Number(meta.missingTemplateCount || 0) > 0) throw new Error(`${title} still has ${meta.missingTemplateCount} missing template(s)`);
  if (Array.isArray(meta.missingYouTubeEmbeds) && meta.missingYouTubeEmbeds.length) {
    throw new Error(`${title} still has ${meta.missingYouTubeEmbeds.length} missing YouTube embed(s)`);
  }
  const now = new Date().toISOString();
  await db(`source_documents?id=eq.${eq(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      content_status: "published",
      published_content_wikitext: row.content_wikitext,
      published_content_language: row.content_language || "en",
      published_revision_no: Number(row.content_revision_no || 0),
      published_namumark_html: row.content_namumark_html,
      published_namumark_meta: meta,
      published_namumark_engine: row.content_namumark_engine,
      published_namumark_engine_version: row.content_namumark_engine_version,
      published_at: now,
      translation_status: "reviewed",
      updated_at: now,
    }),
  });
  return {
    id: row.id,
    revisionNo: Number(row.content_revision_no || 0),
    htmlLength: String(row.content_namumark_html || "").length,
  };
}

async function fetchRendered(documentId) {
  const rows = await db(
    `source_documents?id=eq.${eq(documentId)}` +
    "&select=source_namumark_html,source_namumark_meta,source_fidelity_meta&limit=1"
  );
  return rows?.[0] || null;
}

async function main() {
  const ownerTitle = normalizeTitle(process.argv[2]);
  const templateTitle = normalizeTitle(process.argv[3]);
  const verify = !process.argv.includes("--no-verify");
  if (!ownerTitle || !templateTitle) {
    throw new Error('Usage: npm run namu:recover-template -- "원이" "틀:원이 브랜드 평판"');
  }

  console.log(`DOM → NamuMark recovery`);
  console.log(`Owner: ${ownerTitle}`);
  console.log(`Template: ${templateTitle}`);
  console.log(`Converter: ${DOM_TO_NAMUMARK_VERSION}`);

  const fallback = await getFallback(ownerTitle, templateTitle);
  if (!fallback?.source_html) throw new Error("Captured DOM fallback is missing");

  const sourceResult = convertDomToNamuMark(fallback.source_html, { title: templateTitle, language: "ko" });
  const englishResult = fallback.en_html
    ? convertDomToNamuMark(fallback.en_html, { title: templateTitle, language: "en" })
    : null;

  console.log(`KO synthetic: ${sourceResult.namumark.length.toLocaleString()} chars · static=${sourceResult.fidelity.score}`);
  if (englishResult) console.log(`EN synthetic: ${englishResult.namumark.length.toLocaleString()} chars · static=${englishResult.fidelity.score}`);

  const documentId = await createOrRefreshSynthetic(ownerTitle, templateTitle, sourceResult, fallback);
  console.log(`Synthetic document: ${documentId}`);

  await patchFallback(fallback.id, {
    synthetic_document_id: documentId,
    recovery_status: "converted",
    recovery_version: DOM_TO_NAMUMARK_VERSION,
    recovered_at: new Date().toISOString(),
    recovery_meta: {
      converterVersion: DOM_TO_NAMUMARK_VERSION,
      sourceStaticFidelity: sourceResult.fidelity,
      englishStaticFidelity: englishResult?.fidelity || null,
      sourceChars: sourceResult.namumark.length,
      englishChars: englishResult?.namumark.length || 0,
    },
  });

  console.log("\n--- Synthetic Korean NamuMark (first 5000 chars) ---\n");
  console.log(sourceResult.namumark.slice(0, 5000));
  if (sourceResult.namumark.length > 5000) console.log("\n...[truncated]");

  if (!verify) return;
  console.log("\nRendering synthetic template with local The Tree...");
  runRenderer(templateTitle);

  const rendered = await fetchRendered(documentId);
  if (!rendered?.source_namumark_html) throw new Error("The Tree did not save rendered synthetic HTML");
  const fidelity = compareDomFidelity(fallback.source_html, rendered.source_namumark_html);
  const verified = fidelity.score >= VERIFY_THRESHOLD;

  await db(`source_documents?id=eq.${eq(documentId)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_fidelity_meta: {
        stage: verified ? "verified" : "needs-review",
        converterVersion: DOM_TO_NAMUMARK_VERSION,
        threshold: VERIFY_THRESHOLD,
        score: fidelity.score,
        comparison: fidelity,
        static: sourceResult.fidelity,
        verifiedAt: new Date().toISOString(),
        fidelityComparatorVersion: 2,
      },
      updated_at: new Date().toISOString(),
    }),
  });

  await patchFallback(fallback.id, {
    recovery_status: verified ? "verified" : "converted",
    recovery_meta: {
      converterVersion: DOM_TO_NAMUMARK_VERSION,
      sourceStaticFidelity: sourceResult.fidelity,
      englishStaticFidelity: englishResult?.fidelity || null,
      renderFidelity: fidelity,
      fidelityComparatorVersion: 2,
      threshold: VERIFY_THRESHOLD,
      verified,
      syntheticDocumentId: documentId,
    },
  });

  console.log(`\nVerification score=${fidelity.score} threshold=${VERIFY_THRESHOLD} → ${verified ? "VERIFIED" : "NEEDS REVIEW"}`);
  console.log(`text=${fidelity.textTokenSimilarity.toFixed(3)} links=${fidelity.linkSimilarity.toFixed(3)} images=${fidelity.imageSimilarity.toFixed(3)} tables=${fidelity.tableSimilarity.toFixed(3)} rows=${fidelity.rowSimilarity.toFixed(3)} cells=${fidelity.cellSimilarity.toFixed(3)} folding=${fidelity.foldingSimilarity.toFixed(3)}`);

  if (!verified) {
    console.log("Synthetic RAW was not promoted. Existing HTML fallback remains active.");
    process.exitCode = 2;
    return;
  }

  if (englishResult) {
    const revision = await saveEnglish(documentId, templateTitle, englishResult);
    console.log(`English revision saved after verification: r${revision?.revision_no || "?"}`);

    console.log(`\nRendering English synthetic template draft: ${templateTitle}`);
    runContentRenderer(templateTitle);
    console.log(`Synthetic template draft ready: ${templateTitle}`);

    console.log(`\nRe-rendering owner draft with synthetic template: ${ownerTitle}`);
    runContentRenderer(ownerTitle);
    console.log(`Owner draft refreshed: ${ownerTitle}`);
    console.log("Production publish remains manual after local review.");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
