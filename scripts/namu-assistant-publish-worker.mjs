import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const POLL_MS = Math.max(3000, Number(process.env.KPOPARKIVE_ASSISTANT_PUBLISH_POLL_MS || 5000) || 5000);

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
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
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
      "&synthetic_document_id=is.null" +
      "&select=id,template_title,recovery_status,synthetic_document_id" +
      "&order=updated_at.asc&limit=20",
  );

  let attempted = 0;
  let verified = 0;
  for (const row of rows || []) {
    const templateTitle = String(row?.template_title || "").normalize("NFKC").trim();
    if (!templateTitle) continue;
    attempted += 1;
    if (await runDomRecovery(ownerTitle, templateTitle)) verified += 1;
  }
  return { attempted, verified };
}

async function fetchSourceRenderPending() {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
      "&translation_status=eq.pending_chatgpt" +
      "&source_wikitext=not.is.null" +
      "&select=id,source_title,raw_extracted_at,source_namumark_rendered_at,source_namumark_meta" +
      "&order=updated_at.desc&limit=30",
  );

  return (rows || []).filter((row) => {
    const title = String(row?.source_title || "");
    if (!title || /^틀:/i.test(title)) return false;
    const rawAt = Date.parse(row?.raw_extracted_at || "");
    const renderedAt = Date.parse(row?.source_namumark_rendered_at || "");
    const staleByTime = !Number.isFinite(renderedAt) || (Number.isFinite(rawAt) && renderedAt < rawAt);
    const needsFallbackExtractorUpgrade =
      Number(row?.source_namumark_meta?.missingTemplateCount || 0) > 0 &&
      Number(row?.source_namumark_meta?.fallbackExtractorVersion || 0) < 2;
    const needsStagingAssetReconcile =
      Number(row?.source_namumark_meta?.missingFileCount || 0) > 0 &&
      Number(row?.source_namumark_meta?.fallbackExtractorVersion || 0) < 2;
    return staleByTime || needsFallbackExtractorUpgrade || needsStagingAssetReconcile;
  });
}

async function fetchPending() {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
      "&translation_status=eq.translated_by_chatgpt" +
      "&content_language=eq.en" +
      "&content_wikitext=not.is.null" +
      "&select=id,source_title,content_revision_no,translation_version,translated_at,content_namumark_rendered_at,content_namumark_meta" +
      "&order=translated_at.asc.nullsfirst,updated_at.asc&limit=30",
  );

  return (rows || []).filter((row) => {
    const revision = Number(row?.content_revision_no || 0) || 0;
    const renderedRevision = Number(row?.content_namumark_meta?.editableContent?.revisionNo || 0) || 0;
    return revision > 0 && renderedRevision !== revision;
  }).slice(0, 10);
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
      "&select=id,source_title,translation_status,translation_version,content_wikitext,content_language,content_status,content_revision_no,content_namumark_html,content_namumark_meta,content_namumark_engine,content_namumark_engine_version,content_namumark_rendered_at&limit=1",
  );
  return rows?.[0] || null;
}

async function validateRenderedDraft(row, expectedRevision) {
  if (!row) throw new Error("Rendered document disappeared");
  if (row.translation_status !== "translated_by_chatgpt") {
    console.log(`ASSISTANT RENDER: ${row.source_title} status changed to ${row.translation_status}; skipping.`);
    return false;
  }
  if (Number(row.content_revision_no || 0) !== Number(expectedRevision || 0)) {
    console.log(`ASSISTANT RENDER: ${row.source_title} changed from r${expectedRevision} to r${row.content_revision_no}; rerender deferred.`);
    return false;
  }
  if (row.content_language !== "en") throw new Error("content_language is not en");
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
        const recovery = await recoverFreshDomFallbacks(title);
        if (recovery.attempted > 0) {
          console.log(
            `DOM RECOVERY COMPLETE ${title}: ${recovery.verified}/${recovery.attempted} verified; refreshing source render.`,
          );
          await runSourceRenderer(title);
        }
      } catch (error) {
        console.error(
          `SOURCE RENDER FAILED ${title}:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }

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
