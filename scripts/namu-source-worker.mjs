#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import {
  claimPipelineJob,
  enqueuePipelineStage,
  nextRetryStatus,
  pipelineDb,
  requireServiceRole,
  updatePipelineJob,
} from "./lib/pipeline-db.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? found.slice(name.length + 3) : "";
};

const runId = valueArg("run");
const once = args.includes("--once");
const workerId =
  valueArg("worker-id") || "source-" + process.pid + "-" + Date.now().toString(36);
const helperBase = String(
  process.env.KPOPARKIVE_CAPTURE_HELPER_URL || "http://127.0.0.1:43117",
).replace(/\/$/, "");

if (!runId) {
  console.error("Usage: npm run namu:source-worker -- --run=<pipeline-run-id> [--once]");
  process.exit(2);
}
requireServiceRole();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function metaCount(meta, countKey, arrayKey = countKey) {
  const numeric = Number(meta?.[countKey]);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  return Array.isArray(meta?.[arrayKey]) ? meta[arrayKey].length : 0;
}

function publicNamuUrl(title) {
  return (
    "https://namu.wiki/w/" +
    String(title)
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")
  );
}

async function captureHelper(pathname, init = {}) {
  const response = await fetch(helperBase + pathname, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text }; }
  if (!response.ok) {
    throw new Error(
      "capture helper " +
        response.status +
        ": " +
        String(body?.error || text || "").slice(0, 1000),
    );
  }
  return body;
}

async function captureRawDependency(rootTitle, sourceTitle) {
  const started = Date.now();

  while (Date.now() - started < 15 * 60_000) {
    const state = await captureHelper("/clone/status");
    if (!state?.job?.running) break;
    await sleep(2000);
  }

  const state = await captureHelper("/clone/status");
  if (state?.job?.running) {
    throw new Error("capture_helper_busy_timeout");
  }

  await captureHelper("/clone/start", {
    method: "POST",
    body: JSON.stringify({
      rootTitle,
      rootUrl: publicNamuUrl(sourceTitle),
      maxDepth: 0,
      maxDocs: 1,
      captureMode: "raw",
      crawlProfile: "essential",
      refreshExisting: true,
    }),
  });

  const deadline = Date.now() + 30 * 60_000;
  while (Date.now() < deadline) {
    const progress = await captureHelper("/clone/status");
    const job = progress?.job || {};
    if (job.done || job.status === "done") {
      if (Number(job.failed || 0) > 0) {
        throw new Error(
          "dependency_raw_capture_failed:" +
            Number(job.failed || 0),
        );
      }
      return;
    }
    if (job.status === "cancelled") {
      throw new Error("dependency_raw_capture_cancelled");
    }
    await sleep(2000);
  }

  throw new Error("dependency_raw_capture_timeout");
}

async function fetchDocument(id) {
  const rows = await pipelineDb(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,root_title,source_title,source_wikitext,source_namumark_meta,source_namumark_rendered_at&limit=1",
  );
  return rows?.[0] || null;
}

function runNodeScript(script, scriptArgs = [], acceptableCodes = [0]) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(ROOT, script), ...scriptArgs],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (acceptableCodes.includes(Number(code ?? 0))) resolve(Number(code ?? 0));
      else reject(new Error(
        script + " exited code=" + String(code) + " signal=" + String(signal || "none")
      ));
    });
  });
}

function runSourceRenderer(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-node-snapshot", path.resolve(ROOT, "scripts/namumark-thetree-compat-poc.mjs"), title],
      {
        cwd: ROOT,
        env: { ...process.env, KPOPARKIVE_RENDER_LANGUAGE: "ko" },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error("source renderer exited code=" + String(code) + " signal=" + String(signal || "none")));
    });
  });
}

async function repairDependencies(doc) {
  let current = doc;
  let meta = current?.source_namumark_meta || {};
  const missingFiles = Array.isArray(meta?.missingFiles) ? meta.missingFiles : [];
  const missingTemplates = Array.isArray(meta?.missingTemplates) ? meta.missingTemplates : [];

  if (missingFiles.length > 0 && current?.root_title) {
    console.log("SOURCE REPAIR files=" + missingFiles.length + " · " + current.source_title);
    await runNodeScript(
      "scripts/namu-browser-image-worker-safe.mjs",
      ["--root", current.root_title, "--renderer-missing"],
      [0],
    ).catch((error) => {
      console.warn("ASSET REPAIR WARN " + String(error?.message || error));
    });

    await runNodeScript(
      "scripts/namu-dom-video-recover.mjs",
      [current.source_title],
      [0, 3],
    ).catch((error) => {
      console.warn("VIDEO REPAIR WARN " + String(error?.message || error));
    });

    await runSourceRenderer(current.source_title);
    current = await fetchDocument(current.id);
    meta = current?.source_namumark_meta || {};
  }

  const unresolvedTemplates = Array.isArray(meta?.missingTemplates)
    ? meta.missingTemplates
    : missingTemplates;

  for (const templateTitle of unresolvedTemplates.slice(0, 30)) {
    console.log("SOURCE REPAIR template=" + templateTitle + " · owner=" + current.source_title);
    await runNodeScript(
      "scripts/namu-dom-template-recover.mjs",
      [current.source_title, String(templateTitle)],
      [0, 2],
    ).catch((error) => {
      console.warn(
        "TEMPLATE REPAIR WARN " +
          String(templateTitle) +
          " · " +
          String(error?.message || error),
      );
    });
  }

  if (unresolvedTemplates.length > 0) {
    await runSourceRenderer(current.source_title);
    current = await fetchDocument(current.id);
  }

  const stillMissing = Array.isArray(current?.source_namumark_meta?.missingTemplates)
    ? current.source_namumark_meta.missingTemplates
    : [];

  if (stillMissing.length > 0 && current?.root_title) {
    for (const templateTitle of stillMissing.slice(0, 20)) {
      try {
        console.log(
          "SOURCE RAW DEPENDENCY " +
            templateTitle +
            " · root=" +
            current.root_title,
        );
        await captureRawDependency(current.root_title, String(templateTitle));
      } catch (error) {
        console.warn(
          "RAW DEPENDENCY WARN " +
            String(templateTitle) +
            " · " +
            String(error?.message || error),
        );
      }
    }

    await runSourceRenderer(current.source_title);
    current = await fetchDocument(current.id);
  }

  return current;
}

function validateSource(doc) {
  const blockers = [];
  if (!doc?.source_wikitext) blockers.push("missing_canonical_raw");
  if (!doc?.source_namumark_rendered_at) blockers.push("missing_source_render");

  const meta = doc?.source_namumark_meta;
  if (!meta || typeof meta !== "object") {
    blockers.push("missing_source_render_meta");
    return blockers;
  }

  if (meta.hasError === true) blockers.push("source_render_error");
  const compat = String(meta?.compatibility?.version || "");
  const patchset = String(meta?.compatibility?.enginePatchset || meta?.enginePatchset || "");
  if (compat !== "modern-namu-compat-v8") blockers.push("source_stale_compat:" + (compat || "none"));
  if (patchset !== "modern-namu-v2") blockers.push("source_stale_patchset:" + (patchset || "none"));

  const files = metaCount(meta, "missingFileCount", "missingFiles");
  const templates = metaCount(meta, "missingTemplateCount", "missingTemplates");
  const youtube = metaCount(meta, "missingYouTubeCount", "missingYouTubeEmbeds");
  if (files) blockers.push("source_missing_files:" + files);
  if (templates) blockers.push("source_missing_templates:" + templates);
  if (youtube) blockers.push("source_missing_youtube:" + youtube);

  return blockers;
}

async function fail(job, error) {
  const status = nextRetryStatus(job);
  await updatePipelineJob(job.id, {
    status,
    locked_by: null,
    locked_at: null,
    last_error: String(error?.message || error).slice(0, 4000),
    ...(status === "needs_review" ? { finished_at: new Date().toISOString() } : {}),
  });
}

console.log("Kpoparkive Source Worker · " + workerId + " · run=" + runId);

while (true) {
  const job = await claimPipelineJob(runId, workerId, "source_render");
  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }

  try {
    const before = await fetchDocument(job.source_document_id);
    if (!before?.source_wikitext) throw new Error("missing_canonical_raw");

    console.log("SOURCE RENDER " + before.source_title + " · attempt=" + job.attempt + "/" + job.max_attempts);
    await runSourceRenderer(before.source_title);

    let after = await fetchDocument(job.source_document_id);
    let blockers = validateSource(after);

    if (
      blockers.some((value) =>
        value.startsWith("source_missing_files:") ||
        value.startsWith("source_missing_templates:")
      )
    ) {
      after = await repairDependencies(after);
      blockers = validateSource(after);
    }

    if (blockers.length) throw new Error("source_qa_failed:" + blockers.join("|"));

    await enqueuePipelineStage(job, "translation");
    await updatePipelineJob(job.id, {
      status: "pass",
      locked_by: null,
      locked_at: null,
      last_error: null,
      checkpoint: { qa: "pass", completedAt: new Date().toISOString() },
      finished_at: new Date().toISOString(),
    });

    console.log("SOURCE PASS " + after.source_title);
  } catch (error) {
    console.error("SOURCE FAILED " + job.source_title + " · " + String(error?.message || error));
    await fail(job, error);
  }

  if (once) break;
}
