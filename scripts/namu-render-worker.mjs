#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  findVisibleKoreanLinkLabels,
  findVisibleKoreanText,
} from "./namu-english-link-localizer.mjs";

const ROOT = process.cwd();
const DEFAULT_SUPABASE_URL = "https://hukrrzhltiyirtkxmotj.supabase.co";
const args = process.argv.slice(2);

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

const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? found.slice(name.length + 3) : "";
};

const runId = valueArg("run");
const once = args.includes("--once");
const workerId =
  valueArg("worker-id") || "render-" + process.pid + "-" + Date.now().toString(36);
const staleMinutes = Math.max(
  15,
  Number(valueArg("stale-minutes") || 60) || 60,
);

const supabaseUrl = String(
  process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
).replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!runId) {
  console.error(
    "Usage: npm run namu:render-worker -- --run=<pipeline-run-id> [--once]",
  );
  process.exit(2);
}
if (!serviceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(2);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function headers(extra = {}) {
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
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("Supabase " + response.status + ": " + body.slice(0, 1200));
  }
  return body ? JSON.parse(body) : null;
}

function metaCount(meta, countKey, arrayKey = countKey) {
  if (!meta || typeof meta !== "object") return 0;
  const numeric = Number(meta[countKey]);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Array.isArray(meta[arrayKey]) ? meta[arrayKey].length : 0;
}

function inspectHtml(html) {
  const value = String(html || "");
  const leaks = [];
  const checks = [
    ["raw-link", /\[\[[^\]]+\]\]/],
    ["include", /\[include\s*\(/i],
    ["wiki-directive", /\{\{\{#!/i],
  ];
  for (const [name, pattern] of checks) {
    if (pattern.test(value)) leaks.push(name);
  }
  return {
    leaks,
    absoluteNamuLinks: (
      value.match(/href=["']https:\/\/namu\.wiki\/w\//gi) || []
    ).length,
  };
}

async function claimJob() {
  const rows = await db("rpc/claim_pipeline_job", {
    method: "POST",
    body: JSON.stringify({
      p_run_id: runId,
      p_worker_id: workerId,
      p_stage: "en_render",
    }),
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

async function recoverStaleJobs() {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
  const rows = await db(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&stage=eq.en_render" +
      "&status=eq.running" +
      "&locked_at=lt." +
      encodeURIComponent(cutoff) +
      "&select=id,source_title,locked_by",
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
          "Recovered stale render lease from " + (row.locked_by || "unknown"),
        updated_at: new Date().toISOString(),
      }),
    });
  }
  return (rows || []).length;
}

async function fetchDocument(id) {
  const rows = await db(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,source_title,content_language,content_revision_no,content_wikitext,content_namumark_html,content_namumark_meta,content_namumark_rendered_at,translation_status" +
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
        Prefer: "resolution=ignore-duplicates,return=minimal",
      },
      body: JSON.stringify({
        run_id: job.run_id,
        source_document_id: job.source_document_id,
        source_title: job.source_title,
        stage,
        status: "queued",
        attempt: 0,
        max_attempts: 3,
        checkpoint: {},
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

function runRenderer(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-node-snapshot",
        path.resolve(ROOT, "scripts/namumark-thetree-content.mjs"),
        title,
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          KPOPARKIVE_RENDER_LANGUAGE: "en",
        },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            "renderer exited code=" +
              String(code ?? "null") +
              " signal=" +
              String(signal || "none"),
          ),
        );
      }
    });
  });
}

function validateRendered(doc, expectedRevision) {
  const blockers = [];
  const html = String(doc?.content_namumark_html || "");

  if (doc?.content_language !== "en") blockers.push("content_language_not_en");
  if (!doc?.content_wikitext) blockers.push("missing_content_wikitext");
  if (html.length < 100) blockers.push("missing_current_render");
  if (!doc?.content_namumark_rendered_at) {
    blockers.push("missing_render_timestamp");
  }

  const meta =
    doc?.content_namumark_meta && typeof doc.content_namumark_meta === "object"
      ? doc.content_namumark_meta
      : null;

  if (!meta) {
    blockers.push("missing_render_meta");
  } else {
    const renderedRevision =
      Number(meta?.editableContent?.revisionNo || 0) || 0;

    if (renderedRevision !== Number(expectedRevision || 0)) {
      blockers.push(
        "stale_render:r" +
          renderedRevision +
          "->r" +
          Number(expectedRevision || 0),
      );
    }

    if (meta.hasError === true) blockers.push("render_error");

    const missingFiles = metaCount(meta, "missingFileCount", "missingFiles");
    const missingTemplates = metaCount(
      meta,
      "missingTemplateCount",
      "missingTemplates",
    );
    const missingYoutube = metaCount(
      meta,
      "missingYouTubeCount",
      "missingYouTubeEmbeds",
    );

    if (missingFiles > 0) blockers.push("missing_files:" + missingFiles);
    if (missingTemplates > 0) {
      blockers.push("missing_templates:" + missingTemplates);
    }
    if (missingYoutube > 0) {
      blockers.push("missing_youtube:" + missingYoutube);
    }
  }

  if (html) {
    const inspected = inspectHtml(html);
    if (inspected.leaks.length > 0) {
      blockers.push("syntax_leak:" + inspected.leaks.join("+"));
    }
    if (inspected.absoluteNamuLinks > 0) {
      blockers.push("absolute_namuwiki_links:" + inspected.absoluteNamuLinks);
    }

    const koreanLinks = findVisibleKoreanLinkLabels(html, { limit: 50 });
    if (koreanLinks.length > 0) {
      blockers.push("visible_korean_links:" + koreanLinks.length);
    }

    const koreanText = findVisibleKoreanText(html, { limit: 50 });
    if (koreanText.length > 0) {
      blockers.push("visible_korean_text:" + koreanText.length);
    }
  }

  return { ok: blockers.length === 0, blockers };
}

async function failOrRetry(job, error) {
  const status =
    Number(job.attempt || 0) >= Number(job.max_attempts || 3)
      ? "needs_review"
      : "retry";

  await updateJob(job.id, {
    status,
    locked_by: null,
    locked_at: null,
    last_error: String(error?.message || error || "render failed").slice(0, 4000),
    ...(status === "needs_review"
      ? { finished_at: new Date().toISOString() }
      : {}),
  });
}

const recovered = await recoverStaleJobs();
if (recovered > 0) {
  console.log("Recovered " + recovered + " stale render job(s).");
}

console.log(
  "Kpoparkive English Render Worker · " + workerId + " · run=" + runId,
);

while (true) {
  const job = await claimJob();
  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }

  const before = await fetchDocument(job.source_document_id);
  if (!before) {
    await failOrRetry(job, new Error("source_document_not_found"));
    if (once) break;
    continue;
  }

  const expectedRevision = Number(before.content_revision_no || 0);
  console.log(
    "RENDER " +
      before.source_title +
      " · r" +
      expectedRevision +
      " · attempt=" +
      job.attempt +
      "/" +
      job.max_attempts,
  );

  try {
    if (
      before.content_language !== "en" ||
      !before.content_wikitext ||
      expectedRevision <= 0
    ) {
      throw new Error("english_revision_not_ready");
    }

    await runRenderer(before.source_title);

    const after = await fetchDocument(job.source_document_id);
    if (!after) throw new Error("document_disappeared_after_render");
    if (Number(after.content_revision_no || 0) !== expectedRevision) {
      throw new Error(
        "content_revision_changed_during_render:r" +
          expectedRevision +
          "->r" +
          Number(after.content_revision_no || 0),
      );
    }

    const qa = validateRendered(after, expectedRevision);
    if (!qa.ok) {
      throw new Error("render_qa_failed:" + qa.blockers.join("|"));
    }

    await enqueueStage(job, "publish");

    await updateJob(job.id, {
      status: "pass",
      locked_by: null,
      locked_at: null,
      last_error: null,
      checkpoint: {
        renderedRevision: expectedRevision,
        qa: "pass",
        completedAt: new Date().toISOString(),
      },
      finished_at: new Date().toISOString(),
    });

    console.log("RENDER PASS " + after.source_title + " · r" + expectedRevision);
  } catch (error) {
    console.error(
      "RENDER FAILED " +
        job.source_title +
        " · " +
        String(error?.message || error),
    );
    await failOrRetry(job, error);
  }

  if (once) break;
}
