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

async function fetchDocument(id) {
  const rows = await pipelineDb(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,source_title,source_wikitext,source_namumark_meta,source_namumark_rendered_at&limit=1",
  );
  return rows?.[0] || null;
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

    const after = await fetchDocument(job.source_document_id);
    const blockers = validateSource(after);
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
