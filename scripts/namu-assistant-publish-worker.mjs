import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { findVisibleKoreanLinkLabels, findVisibleKoreanText } from "./namu-english-link-localizer.mjs";

const ROOT = process.cwd();
const POLL_MS = Math.max(3000, Number(process.env.KPOPARKIVE_ASSISTANT_PUBLISH_POLL_MS || 5000) || 5000);
const DOM_RECOVERY_TARGET_VERSION = "dom-to-namumark-v3.1";
const FALLBACK_EXTRACTOR_TARGET_VERSION = 4;
const DOM_FALLBACK_NORMALIZER_TARGET_VERSION = 2;

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT, ".env.local"));
loadEnv(path.join(ROOT, ".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!SERVICE_ROLE_KEY) {
  console.error("Assistant publish worker: SUPABASE_SERVICE_ROLE_KEY is missing.");
  process.exit(1);
}

function headers(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const delays = [1000, 2500, 5000, 10000, 20000];
  let lastError = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
        ...init,
        headers: { ...headers(), ...(init.headers || {}) },
        cache: "no-store",
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;

      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 502 ||
        (response.status === 500 && /(?:57014|statement timeout|canceling statement|PGRST002|Bad Gateway|Gateway Time-out)/i.test(text));

      const error = new Error(`Supabase ${response.status}: ${text}`);
      error.kpopRetryable = retryable;
      lastError = error;
      if (!retryable || attempt >= delays.length) throw error;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      const retryable =
        error?.kpopRetryable === true ||
        /(?:fetch failed|network|ECONN|ETIMEDOUT|ECONNRESET|57014|statement timeout|canceling statement|PGRST002|502|503|504|429|408)/i.test(message);
      if (!retryable || attempt >= delays.length) throw error;
    }

    const delay = delays[attempt] + Math.floor(Math.random() * 300);
    console.warn(
      `SUPABASE ASSISTANT RETRY: attempt ${attempt + 1}/${delays.length} in ${Math.round(delay / 1000)}s`
    );
    await sleep(delay);
  }

  throw lastError || new Error("Supabase assistant request failed after retries");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runRenderer(title) {
  return new Promise((resolve, reject) => {
    console.log(`ASSISTANT RENDER: rendering ${title} with local The Tree...`);
    const child = spawn(
      process.execPath,
      ["--no-node-snapshot", path.resolve("scripts/namumark-thetree-content.mjs"), title],
      {
        cwd: ROOT,
        env: { ...process.env, KPOPARKIVE_RENDER_LANGUAGE: "en" },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`The Tree content renderer exited code=${code ?? "null"} signal=${signal || "none"}`));
    });
  });
}

function runSourceRenderer(title) {
  return new Promise((resolve, reject) => {
    console.log(`SOURCE RENDER: ${title} with local The Tree...`);
    const child = spawn(
      process.execPath,
      ["--no-node-snapshot", path.resolve("scripts/namumark-thetree-compat-poc.mjs"), title],
      {
        cwd: ROOT,
        env: { ...process.env, KPOPARKIVE_RENDER_LANGUAGE: "ko" },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`The Tree source renderer exited code=${code ?? "null"} signal=${signal || "none"}`));
    });
  });
}

function runDomVideoRecovery(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve("scripts/namu-dom-video-recover.mjs"), title],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(true);
      else if (code === 3) resolve(false);
      else reject(new Error(`DOM video recovery exited code=${code ?? "null"} signal=${signal || "none"}`));
    });
  });
}

function runDomRecovery(ownerTitle, templateTitle) {
  return new Promise((resolve, reject) => {
    console.log(`DOM RECOVERY: ${ownerTitle} -> ${templateTitle}`);
    const child = spawn(
      process.execPath,
      [path.resolve("scripts/namu-dom-template-recover.mjs"), ownerTitle, templateTitle],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(true);
      else if (code === 2) {
        console.warn(`DOM RECOVERY NEEDS REVIEW ${templateTitle}; keeping captured HTML fallback active.`);
        resolve(false);
      } else {
        reject(new Error(`DOM recovery exited code=${code ?? "null"} signal=${signal || "none"}`));
      }
    });
  });
}

async function recoverFreshDomFallbacks(ownerTitle) {
  const rows = await db(
    "template_dom_fallbacks?source_title=eq." + encodeURIComponent(ownerTitle) +
      "&source_html=not.is.null" +
      "&select=id,template_title,recovery_status,recovery_version,recovery_meta,translation_status,synthetic_document_id,en_html,source_browser_captured_at" +
      "&order=updated_at.asc&limit=50",
  );

  let attempted = 0;
  let verified = 0;
  for (const row of rows || []) {
    const templateTitle = String(row?.template_title || "").normalize("NFKC").trim();
    if (!templateTitle) continue;

    const needsFidelityComparatorRetry =
      String(row?.recovery_status || "") !== "verified" &&
      Number(row?.recovery_meta?.fidelityComparatorVersion || 0) < 2;

    let shouldRecover =
      !row?.synthetic_document_id ||
      String(row?.recovery_version || "") !== DOM_RECOVERY_TARGET_VERSION ||
      needsFidelityComparatorRetry;
    if (!shouldRecover) {
      const syntheticRows = await db(
        "source_documents?id=eq." + encodeURIComponent(row.synthetic_document_id) +
          "&select=id,source_render_manifest,source_fidelity_meta,content_language,content_wikitext,content_revision_no,translation_status,content_status&limit=1",
      );
      const synthetic = syntheticRows?.[0] || null;
      const captureAt = Date.parse(row?.source_browser_captured_at || "");
      const generatedAt = Date.parse(synthetic?.source_render_manifest?.generatedAt || "");
      const sourceRecoveryStale =
        Number.isFinite(captureAt) &&
        (!Number.isFinite(generatedAt) || captureAt > generatedAt);

      const hasEnglishSynthetic =
        synthetic?.content_language === "en" &&
        typeof synthetic?.content_wikitext === "string" &&
        synthetic.content_wikitext.length > 0 &&
        Number(synthetic?.content_revision_no || 0) > 0 &&
        ["reviewed", "translated_by_chatgpt"].includes(String(synthetic?.translation_status || ""));

      // When DOM -> NamuMark promotion is intentionally blocked for a complex
      // interactive/tabbed template, the translated captured HTML fallback is
      // the authoritative English representation. Do not keep retrying merely
      // because the synthetic document has no English content; it is expected
      // to remain source-only in html-fallback-only mode.
      const htmlFallbackAuthoritative =
        Boolean(row?.recovery_meta?.htmlFallbackRequired) &&
        row?.recovery_meta?.promotionGate?.eligible === false &&
        Boolean(row?.en_html) &&
        row?.translation_status === "reviewed";

      const needsEnglishSynthetic =
        row?.translation_status === "reviewed" &&
        Boolean(row?.en_html) &&
        !hasEnglishSynthetic &&
        !htmlFallbackAuthoritative;

      shouldRecover = sourceRecoveryStale || needsEnglishSynthetic;
    }

    if (!shouldRecover) continue;
    attempted += 1;
    if (await runDomRecovery(ownerTitle, templateTitle)) verified += 1;
  }
  return { attempted, verified };
}

async function fetchSourceRenderPending() {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
      "&translation_status=in.(pending_chatgpt,failed,translated_by_chatgpt,reviewed)" +
      "&source_wikitext=not.is.null" +
      "&select=id,source_title,translation_status,raw_extracted_at,source_namumark_rendered_at,source_namumark_meta,content_language,content_revision_no,content_wikitext" +
      "&order=updated_at.desc&limit=30",
  );

  return (rows || []).filter((row) => {
    const title = String(row?.source_title || "");
    if (!title || /^틀:/i.test(title)) return false;
    const rawAt = Date.parse(row?.raw_extracted_at || "");
    const renderedAt = Date.parse(row?.source_namumark_rendered_at || "");
    const staleByTime =
      !Number.isFinite(renderedAt) ||
      (Number.isFinite(rawAt) && renderedAt < rawAt);
    const meta = row?.source_namumark_meta || {};
    const missingTemplates = Number(meta?.missingTemplateCount || 0) > 0;
    const missingFiles = Number(meta?.missingFileCount || 0) > 0;
    const needsFallbackExtractorUpgrade =
      missingTemplates && Number(meta?.fallbackExtractorVersion || 0) < FALLBACK_EXTRACTOR_TARGET_VERSION;
    const needsStagingAssetReconcile =
      missingFiles && Number(meta?.assetReconcilerVersion || 0) < 2;
    const needsDomVideoRecovery =
      missingFiles && Number(meta?.domVideoRecoveryVersion || 0) < 1;

    // Do not spin forever on an unresolved dependency. A missing template/file
    // by itself is not a reason to rerender the same source every five seconds.
    // Failed English drafts re-enter source repair only when the source render
    // was explicitly invalidated/stale or an actual repair-version upgrade is
    // still pending. Capturing a missing RAW template invalidates the owner
    // render, which makes this condition true on the next poll.
    const hasEnglishDraft =
      row?.content_language === "en" &&
      Number(row?.content_revision_no || 0) > 0 &&
      typeof row?.content_wikitext === "string" &&
      row.content_wikitext.length > 0;
    const repairableFailedDraftNeedsRender =
      row?.translation_status === "failed" &&
      hasEnglishDraft &&
      (
        !Number.isFinite(renderedAt) ||
        (Number.isFinite(rawAt) && renderedAt < rawAt) ||
        needsFallbackExtractorUpgrade ||
        needsStagingAssetReconcile ||
        needsDomVideoRecovery
      );

    return staleByTime ||
      needsFallbackExtractorUpgrade ||
      needsStagingAssetReconcile ||
      needsDomVideoRecovery ||
      repairableFailedDraftNeedsRender;
  });
}

async function fetchPending() {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
      "&translation_status=in.(translated_by_chatgpt,reviewed)" +
      "&content_language=eq.en" +
      "&content_wikitext=not.is.null" +
      "&select=id,source_title,content_revision_no,translation_version,translated_at,source_namumark_rendered_at,content_namumark_rendered_at,content_namumark_meta" +
      "&order=translated_at.asc.nullsfirst,updated_at.asc&limit=30",
  );

  return (rows || []).filter((row) => {
    const revision = Number(row?.content_revision_no || 0) || 0;
    if (revision <= 0) return false;
    const meta = row?.content_namumark_meta || {};
    const renderedRevision = Number(meta?.editableContent?.revisionNo || 0) || 0;
    const sourceRenderedAt = Date.parse(row?.source_namumark_rendered_at || "");
    const contentRenderedAt = Date.parse(row?.content_namumark_rendered_at || "");
    const sourceNewer =
      Number.isFinite(sourceRenderedAt) &&
      (!Number.isFinite(contentRenderedAt) || contentRenderedAt < sourceRenderedAt);
    const fallbackNormalizerOutdated =
      Number(meta?.domFallbackTemplateCount || 0) > 0 &&
      Number(meta?.domFallbackNormalizerVersion || 0) < DOM_FALLBACK_NORMALIZER_TARGET_VERSION;

    // Missing renderer dependencies are a WAIT state, not a render-loop state.
    // Once RAW/media capture repairs the source, source_namumark_rendered_at
    // advances and sourceNewer schedules exactly one fresh English render.
    return renderedRevision !== revision ||
      sourceNewer ||
      fallbackNormalizerOutdated;
  }).slice(0, 10);
}

async function markSourceRepairVersions(id, { videoAttempted = false } = {}) {
  if (!id) return;
  const rows = await db(
    `source_documents?id=eq.${encodeURIComponent(id)}&select=source_namumark_meta&limit=1`,
  );
  const meta = rows?.[0]?.source_namumark_meta || {};
  await db(`source_documents?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_namumark_meta: {
        ...meta,
        fallbackExtractorVersion: Math.max(FALLBACK_EXTRACTOR_TARGET_VERSION, Number(meta?.fallbackExtractorVersion || 0)),
        assetReconcilerVersion: Math.max(2, Number(meta?.assetReconcilerVersion || 0)),
        domVideoRecoveryVersion: videoAttempted
          ? Math.max(1, Number(meta?.domVideoRecoveryVersion || 0))
          : Number(meta?.domVideoRecoveryVersion || 0),
      },
      updated_at: new Date().toISOString(),
    }),
  });
}

async function resumeRepairableFailedDraft(id) {
  if (!id) return false;
  const rows = await db(
    `source_documents?id=eq.${encodeURIComponent(id)}` +
      "&select=id,source_title,source_hash,translation_source_hash,translation_status,content_language,content_revision_no,content_wikitext,source_namumark_meta&limit=1",
  );
  const row = rows?.[0] || null;
  if (!row || row.translation_status !== "failed") return false;

  const meta = row.source_namumark_meta || {};
  const sourceClean =
    !meta?.hasError &&
    Number(meta?.missingTemplateCount || 0) === 0 &&
    Number(meta?.missingFileCount || 0) === 0 &&
    (!Array.isArray(meta?.missingYouTubeEmbeds) || meta.missingYouTubeEmbeds.length === 0);
  const sourceHash = String(row.source_hash || "");
  const translationSourceHash = String(row.translation_source_hash || "");
  const translationStillMatchesSource =
    Boolean(sourceHash) && sourceHash === translationSourceHash;
  const hasEnglishDraft =
    row.content_language === "en" &&
    Number(row.content_revision_no || 0) > 0 &&
    typeof row.content_wikitext === "string" &&
    row.content_wikitext.length > 0;

  if (!sourceClean || !hasEnglishDraft || !translationStillMatchesSource) return false;

  const pendingFallbacks = await db(
    `template_dom_fallbacks?source_document_id=eq.${encodeURIComponent(id)}` +
      "&translation_status=eq.pending_chatgpt&select=id,template_title&limit=1",
  );
  if (Array.isArray(pendingFallbacks) && pendingFallbacks.length) return false;

  await db(`source_documents?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      translation_status: "translated_by_chatgpt",
      updated_at: new Date().toISOString(),
    }),
  });
  console.log(
    `ASSISTANT SOURCE REPAIR RESUMED ${row.source_title}: source is clean; re-queueing existing English draft r${row.content_revision_no}.`,
  );
  return true;
}

async function refreshOutdatedHtmlFallbackFrames() {
  const fallbacks = await db(
    "template_dom_fallbacks?source_html=not.is.null" +
      "&select=id,source_title,template_title,recovery_meta,updated_at" +
      "&order=updated_at.asc&limit=200",
  );

  const owners = [...new Set(
    (fallbacks || [])
      .filter((row) => Boolean(row?.recovery_meta?.htmlFallbackRequired))
      .map((row) => String(row?.source_title || "").normalize("NFKC").trim())
      .filter(Boolean)
  )];

  let refreshed = 0;
  for (const ownerTitle of owners) {
    const docs = await db(
      "source_documents?source=eq.namu_mirror" +
        `&source_title=eq.${encodeURIComponent(ownerTitle)}` +
        "&select=id,source_title,source_namumark_meta&limit=1",
    );
    const doc = docs?.[0] || null;
    if (!doc?.id) continue;
    const version = Number(doc?.source_namumark_meta?.fallbackExtractorVersion || 0) || 0;
    if (version >= FALLBACK_EXTRACTOR_TARGET_VERSION) continue;

    console.log(
      `DOM FALLBACK FRAME REFRESH ${ownerTitle}: extractor v${version || 0} -> v${FALLBACK_EXTRACTOR_TARGET_VERSION}`,
    );
    await runSourceRenderer(ownerTitle);
    refreshed += 1;
  }

  return refreshed;
}

async function recoverOutdatedDomFallbacks() {
  const rows = await db(
    "template_dom_fallbacks?source_html=not.is.null" +
      "&select=id,source_title,template_title,recovery_version,synthetic_document_id,updated_at" +
      "&order=updated_at.asc&limit=100",
  );

  const owners = [...new Set(
    (rows || [])
      .filter((row) =>
        !row?.synthetic_document_id ||
        String(row?.recovery_version || "") !== DOM_RECOVERY_TARGET_VERSION
      )
      .map((row) => String(row?.source_title || "").normalize("NFKC").trim())
      .filter(Boolean)
  )];

  let attempted = 0;
  let verified = 0;
  for (const ownerTitle of owners) {
    const result = await recoverFreshDomFallbacks(ownerTitle);
    attempted += Number(result?.attempted || 0);
    verified += Number(result?.verified || 0);
  }

  if (attempted > 0) {
    console.log(
      `DOM RECOVERY UPGRADE COMPLETE: ${verified}/${attempted} verified with ${DOM_RECOVERY_TARGET_VERSION}.`,
    );
  }
  return { attempted, verified };
}

async function recoverReviewedSyntheticFallbacks() {
  const rows = await db(
    "template_dom_fallbacks?translation_status=eq.reviewed" +
      "&source_html=not.is.null" +
      "&en_html=not.is.null" +
      "&select=id,source_title,template_title,synthetic_document_id,recovery_status,updated_at" +
      "&order=updated_at.asc&limit=100",
  );

  const owners = [...new Set(
    (rows || [])
      .map((row) => String(row?.source_title || "").normalize("NFKC").trim())
      .filter(Boolean)
  )];

  let attempted = 0;
  let verified = 0;
  for (const ownerTitle of owners) {
    const result = await recoverFreshDomFallbacks(ownerTitle);
    attempted += Number(result?.attempted || 0);
    verified += Number(result?.verified || 0);
  }

  if (attempted > 0) {
    console.log(
      `DOM ENGLISH SYNTHETIC RECOVERY COMPLETE: ${verified}/${attempted} verified.`,
    );
  }
  return { attempted, verified };
}

async function resumeReviewedDomFallbackTranslations() {
  const candidates = await db(
    "source_documents?source=eq.namu_mirror" +
      "&translation_status=eq.pending_chatgpt" +
      "&content_language=eq.en" +
      "&content_wikitext=not.is.null" +
      "&content_revision_no=gt.0" +
      "&select=id,source_title,source_hash,translation_source_hash,content_revision_no" +
      "&order=updated_at.asc&limit=50",
  );

  for (const row of candidates || []) {
    const id = String(row?.id || "");
    const title = String(row?.source_title || "").normalize("NFKC").trim();
    const sourceHash = String(row?.source_hash || "");
    const translationSourceHash = String(row?.translation_source_hash || "");
    if (!id || !title || !sourceHash || sourceHash !== translationSourceHash) continue;

    const fallbacks = await db(
      `template_dom_fallbacks?source_document_id=eq.${encodeURIComponent(id)}` +
        "&select=id,template_title,translation_status&order=updated_at.asc&limit=200",
    );
    if (!Array.isArray(fallbacks) || !fallbacks.length) continue;

    const allReviewed = fallbacks.every((item) => item?.translation_status === "reviewed");
    if (!allReviewed) continue;

    await db(`source_documents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        translation_status: "translated_by_chatgpt",
        updated_at: new Date().toISOString(),
      }),
    });

    console.log(
      `ASSISTANT RENDER RESUMED ${title}: source hash unchanged and ${fallbacks.length} DOM fallback translation(s) reviewed.`,
    );
  }
}

async function pendingDomFallbacks(sourceDocumentId) {
  if (!sourceDocumentId) return [];
  return db(
    `template_dom_fallbacks?source_document_id=eq.${encodeURIComponent(sourceDocumentId)}` +
      "&translation_status=eq.pending_chatgpt" +
      "&select=id,template_title,updated_at&order=updated_at.asc&limit=50",
  );
}

async function fetchRendered(id) {
  const rows = await db(
    `source_documents?id=eq.${encodeURIComponent(id)}` +
      "&select=id,source_title,translated_title,translation_status,translation_version,content_wikitext,content_language,content_status,content_revision_no,content_namumark_html,content_namumark_meta,content_namumark_engine,content_namumark_engine_version,content_namumark_rendered_at&limit=1",
  );
  return rows?.[0] || null;
}

function renderedDependencyGaps(row) {
  const meta = row?.content_namumark_meta && typeof row.content_namumark_meta === "object"
    ? row.content_namumark_meta
    : {};
  const templates = Array.isArray(meta?.missingTemplates) ? meta.missingTemplates : [];
  const files = Array.isArray(meta?.missingFiles) ? meta.missingFiles : [];
  const youtube = Array.isArray(meta?.missingYouTubeEmbeds) ? meta.missingYouTubeEmbeds : [];
  return {
    templateCount: Number(meta?.missingTemplateCount || templates.length || 0),
    fileCount: Number(meta?.missingFileCount || files.length || 0),
    youtubeCount: youtube.length,
    templates,
    files,
    youtube,
  };
}

async function validateRenderedDraft(row, expectedRevision) {
  if (!row) throw new Error("Rendered document disappeared");
  if (!["translated_by_chatgpt", "reviewed"].includes(String(row.translation_status || ""))) {
    console.log(`ASSISTANT RENDER: ${row.source_title} status changed to ${row.translation_status}; skipping.`);
    return false;
  }
  if (Number(row.content_revision_no || 0) !== Number(expectedRevision || 0)) {
    console.log(`ASSISTANT RENDER: ${row.source_title} changed from r${expectedRevision} to r${row.content_revision_no}; rerender deferred.`);
    return false;
  }
  if (row.content_language !== "en") throw new Error("content_language is not en");

  const isTemplateDocument = /^(?:틀|Template):/i.test(String(row.source_title || ""));
  if (!isTemplateDocument) {
    const translatedTitle = String(row.translated_title || "").normalize("NFKC").trim();
    if (!translatedTitle) {
      throw new Error("English title QA: translated_title is missing");
    }
    if (/[가-힣]/.test(translatedTitle)) {
      throw new Error(`English title QA: translated_title still contains Korean: ${translatedTitle}`);
    }
  }

  if (typeof row.content_namumark_html !== "string" || row.content_namumark_html.length < 100) {
    throw new Error("Local The Tree did not save content_namumark_html");
  }
  if (!row.content_namumark_rendered_at) throw new Error("content_namumark_rendered_at is missing");

  const meta = row.content_namumark_meta && typeof row.content_namumark_meta === "object"
    ? row.content_namumark_meta
    : {};
  const renderedRevision = Number(meta?.editableContent?.revisionNo || 0) || 0;
  if (renderedRevision && renderedRevision !== Number(row.content_revision_no)) {
    throw new Error(`Rendered revision mismatch: html=r${renderedRevision}, content=r${row.content_revision_no}`);
  }
  if (meta?.hasError) throw new Error(`The Tree reported render error ${meta?.errorCode || "unknown"}`);
  if (Number(meta?.missingTemplateCount || 0) > 0) throw new Error(`The Tree render still has ${meta.missingTemplateCount} missing template(s)`);
  if (Number(meta?.missingFileCount || 0) > 0) throw new Error(`The Tree render still has ${meta.missingFileCount} missing file(s)`);
  if (Array.isArray(meta?.missingYouTubeEmbeds) && meta.missingYouTubeEmbeds.length > 0) {
    throw new Error(`The Tree render still has ${meta.missingYouTubeEmbeds.length} missing YouTube embed(s)`);
  }

  const unresolvedTemplateLabels = Array.isArray(meta?.englishLinkLocalization?.unresolved)
    ? meta.englishLinkLocalization.unresolved
    : [];
  if (unresolvedTemplateLabels.length > 0) {
    const preview = unresolvedTemplateLabels
      .slice(0, 5)
      .map((item) => `${item?.template || "template"}:${item?.target || "?"}`)
      .join(" | ");
    throw new Error(
      `English link-label QA: ${unresolvedTemplateLabels.length} template-generated label(s) unresolved: ${preview}`,
    );
  }

  const visibleKoreanLinks = findVisibleKoreanLinkLabels(row.content_namumark_html, { limit: 20 });
  if (visibleKoreanLinks.length > 0) {
    const preview = visibleKoreanLinks
      .slice(0, 5)
      .map((item) => `${item.visible} -> ${item.href || "?"}`)
      .join(" | ");
    throw new Error(
      `English link-label QA: ${visibleKoreanLinks.length} visible Korean link label(s) remain: ${preview}`,
    );
  }

  const visibleKoreanText = findVisibleKoreanText(row.content_namumark_html, { limit: 20 });
  if (visibleKoreanText.length > 0) {
    const preview = visibleKoreanText
      .slice(0, 5)
      .map((item) => item.visible)
      .join(" | ");
    throw new Error(
      `English text QA: ${visibleKoreanText.length} visible Korean text fragment(s) remain: ${preview}`,
    );
  }

  console.log(`ASSISTANT DRAFT READY ${row.source_title} r${row.content_revision_no}`);
  console.log(`Local preview: http://localhost:3000/w/${row.source_title.split("/").map(encodeURIComponent).join("/")}`);
  return true;
}

async function markFailed(id, title, error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ASSISTANT RENDER FAILED ${title}: ${message}`);
  try {
    await db(`source_documents?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        translation_status: "failed",
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (patchError) {
    console.error("Could not mark assistant publish failure:", patchError instanceof Error ? patchError.message : String(patchError));
  }
}

let stopping = false;
let busy = false;

async function tick() {
  if (stopping || busy) return;
  busy = true;
  try {
    const sourcePending = await fetchSourceRenderPending();
    for (const item of sourcePending) {
      if (stopping) break;
      const title = String(item?.source_title || "").normalize("NFKC").trim();
      if (!title) continue;
      try {
        await runSourceRenderer(title);

        const mediaRecovered = await runDomVideoRecovery(title);
        const recovery = await recoverFreshDomFallbacks(title);
        if (mediaRecovered || recovery.attempted > 0) {
          if (recovery.attempted > 0) {
            console.log(
              `DOM RECOVERY COMPLETE ${title}: ${recovery.verified}/${recovery.attempted} verified.`,
            );
          }
          if (mediaRecovered) {
            console.log(`DOM MEDIA RECOVERY COMPLETE ${title}; refreshing source render.`);
          }
          await runSourceRenderer(title);
        }

        await markSourceRepairVersions(item.id, { videoAttempted: true });
        await resumeRepairableFailedDraft(item.id);
      } catch (error) {
        console.error(
          `SOURCE RENDER FAILED ${title}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    await refreshOutdatedHtmlFallbackFrames();
    await recoverOutdatedDomFallbacks();
    await recoverReviewedSyntheticFallbacks();
    await resumeReviewedDomFallbackTranslations();

    const pending = await fetchPending();
    for (const item of pending || []) {
      if (stopping) break;
      const title = String(item?.source_title || "").normalize("NFKC").trim();
      const id = String(item?.id || "");
      const revision = Number(item?.content_revision_no || 0) || 0;
      if (!title || !id || !revision) continue;

      try {
        const pendingFallbacks = await pendingDomFallbacks(id);
        if (pendingFallbacks?.length) {
          console.log(
            `ASSISTANT RENDER DEFERRED ${title}: waiting for DOM fallback translation ` +
            pendingFallbacks.map((row) => row.template_title).join(" | "),
          );
          continue;
        }

        await runRenderer(title);
        const rendered = await fetchRendered(id);
        const gaps = renderedDependencyGaps(rendered);
        if (gaps.templateCount || gaps.fileCount || gaps.youtubeCount) {
          const parts = [];
          if (gaps.templateCount) {
            parts.push(
              `${gaps.templateCount} template(s)` +
              (gaps.templates.length ? ` [${gaps.templates.slice(0, 5).join(" | ")}]` : "")
            );
          }
          if (gaps.fileCount) {
            parts.push(
              `${gaps.fileCount} file(s)` +
              (gaps.files.length ? ` [${gaps.files.slice(0, 5).join(" | ")}]` : "")
            );
          }
          if (gaps.youtubeCount) parts.push(`${gaps.youtubeCount} YouTube embed(s)`);
          console.log(
            `ASSISTANT RENDER WAITING ${title}: renderer dependency capture required: ${parts.join(", ")}`,
          );
          continue;
        }
        await validateRenderedDraft(rendered, revision);
      } catch (error) {
        await markFailed(id, title, error);
      }
    }
  } catch (error) {
    console.error("Assistant publish poll failed:", error instanceof Error ? error.message : String(error));
  } finally {
    busy = false;
  }
}

process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

console.log(`Kpoparkive draft-render worker watching every ${Math.round(POLL_MS / 1000)}s; production publish is manual`);
await tick();
while (!stopping) {
  await sleep(POLL_MS);
  await tick();
}
