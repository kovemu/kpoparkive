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
  valueArg("worker-id") || "publish-" + process.pid + "-" + Date.now().toString(36);

if (!runId) {
  console.error("Usage: npm run namu:publish-worker -- --run=<pipeline-run-id> [--once]");
  process.exit(2);
}
requireServiceRole();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDocument(id) {
  const rows = await pipelineDb(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,source_title,content_revision_no,content_language,content_wikitext,content_namumark_html,published_revision_no,published_content_language,published_namumark_html&limit=1",
  );
  return rows?.[0] || null;
}

function runPublish(title) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(ROOT, "scripts/namu-publish-draft.mjs"), title],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error("publish exited code=" + String(code) + " signal=" + String(signal || "none")));
    });
  });
}

function validatePublished(doc, expectedRevision) {
  const blockers = [];
  if (doc?.content_language !== "en") blockers.push("content_language_not_en");
  if (!doc?.content_wikitext) blockers.push("missing_content_wikitext");
  if (!doc?.content_namumark_html) blockers.push("missing_content_render");
  if (Number(doc?.published_revision_no || 0) !== Number(expectedRevision || 0)) {
    blockers.push(
      "published_revision_mismatch:r" +
        Number(doc?.published_revision_no || 0) +
        "->r" +
        Number(expectedRevision || 0),
    );
  }
  if (doc?.published_content_language !== "en") blockers.push("published_language_not_en");
  if (!doc?.published_namumark_html) blockers.push("missing_published_html");
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

console.log("Kpoparkive Publish Worker · " + workerId + " · run=" + runId);

while (true) {
  const job = await claimPipelineJob(runId, workerId, "publish");
  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }

  try {
    const before = await fetchDocument(job.source_document_id);
    if (!before) throw new Error("source_document_not_found");

    const expectedRevision = Number(before.content_revision_no || 0);
    if (
      before.content_language !== "en" ||
      !before.content_wikitext ||
      !before.content_namumark_html ||
      expectedRevision <= 0
    ) {
      throw new Error("publish_prerequisites_not_ready");
    }

    console.log("PUBLISH " + before.source_title + " · r" + expectedRevision);
    await runPublish(before.source_title);

    const after = await fetchDocument(job.source_document_id);
    if (!after) throw new Error("document_disappeared_after_publish");

    const blockers = validatePublished(after, expectedRevision);
    if (blockers.length) {
      throw new Error("publish_qa_failed:" + blockers.join("|"));
    }

    await enqueuePipelineStage(job, "integration_qa");
    await updatePipelineJob(job.id, {
      status: "pass",
      locked_by: null,
      locked_at: null,
      last_error: null,
      checkpoint: {
        publishedRevision: expectedRevision,
        completedAt: new Date().toISOString(),
      },
      finished_at: new Date().toISOString(),
    });

    console.log("PUBLISH PASS " + after.source_title + " · r" + expectedRevision);
  } catch (error) {
    console.error("PUBLISH FAILED " + job.source_title + " · " + String(error?.message || error));
    await fail(job, error);
  }

  if (once) break;
}
