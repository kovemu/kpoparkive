#!/usr/bin/env node

import {
  claimPipelineJob,
  enqueuePipelineStage,
  nextRetryStatus,
  pipelineDb,
  requireServiceRole,
  updatePipelineJob,
} from "./lib/pipeline-db.mjs";

const args = process.argv.slice(2);
const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? found.slice(name.length + 3) : "";
};

const runId = valueArg("run");
const once = args.includes("--once");
const workerId =
  valueArg("worker-id") || "raw-" + process.pid + "-" + Date.now().toString(36);
const helperBase = String(
  process.env.KPOPARKIVE_CAPTURE_HELPER_URL || "http://127.0.0.1:43117",
).replace(/\/$/, "");
const timeoutMinutes = Math.max(
  10,
  Number(valueArg("timeout-minutes") || 45) || 45,
);

if (!runId) {
  console.error("Usage: npm run namu:raw-worker -- --run=<pipeline-run-id> [--once]");
  process.exit(2);
}
requireServiceRole();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function helper(pathname, init = {}) {
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
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text };
  }
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

async function fetchDocument(id) {
  const rows = await pipelineDb(
    "source_documents?id=eq." +
      encodeURIComponent(id) +
      "&select=id,root_title,source_title,source_wikitext,raw_extracted_at&limit=1",
  );
  return rows?.[0] || null;
}

async function fail(job, error) {
  const status = nextRetryStatus(job);
  await updatePipelineJob(job.id, {
    status,
    locked_by: null,
    locked_at: null,
    last_error: String(error?.message || error).slice(0, 4000),
    ...(status === "needs_review"
      ? { finished_at: new Date().toISOString() }
      : {}),
  });
}

async function waitForHelperIdle() {
  const started = Date.now();
  while (Date.now() - started < 15 * 60_000) {
    const state = await helper("/clone/status");
    const job = state?.job || {};
    if (!job.running) return job;
    await sleep(2000);
  }
  throw new Error("capture_helper_busy_timeout");
}

async function startRawCapture(doc) {
  await waitForHelperIdle();

  return helper("/clone/start", {
    method: "POST",
    body: JSON.stringify({
      rootTitle: doc.root_title,
      rootUrl: publicNamuUrl(doc.source_title),
      maxDepth: 0,
      maxDocs: 1,
      captureMode: "raw",
      crawlProfile: "essential",
      crawlOrder: "smart",
      includeLeaf: true,
      refreshExisting: true,
    }),
  });
}

async function waitForRawCapture(doc, job) {
  const deadline = Date.now() + timeoutMinutes * 60_000;

  while (Date.now() < deadline) {
    await updatePipelineJob(job.id, {
      locked_by: workerId,
      locked_at: new Date().toISOString(),
      checkpoint: {
        captureHelper: helperBase,
        sourceTitle: doc.source_title,
        waitingForRaw: true,
        polledAt: new Date().toISOString(),
      },
    });

    const state = await helper("/clone/status");
    const capture = state?.job || {};

    if (capture.done || capture.status === "done") {
      if (Number(capture.failed || 0) > 0) {
        throw new Error(
          "raw_capture_failed:" +
            Number(capture.failed || 0) +
            ":" +
            (Array.isArray(capture.errors)
              ? capture.errors.slice(-3).join("|")
              : ""),
        );
      }
      break;
    }

    if (capture.status === "cancelled") {
      throw new Error("raw_capture_cancelled");
    }

    await sleep(2000);
  }

  if (Date.now() >= deadline) {
    throw new Error("raw_capture_timeout_" + timeoutMinutes + "m");
  }

  for (let attempt = 0; attempt < 15; attempt += 1) {
    const latest = await fetchDocument(doc.id);
    if (latest?.source_wikitext?.trim()) return latest;
    await sleep(1000);
  }

  throw new Error("raw_capture_completed_but_source_wikitext_missing");
}

console.log("Kpoparkive RAW Worker · " + workerId + " · run=" + runId);

while (true) {
  const job = await claimPipelineJob(runId, workerId, "raw");

  if (!job) {
    if (once) break;
    await sleep(5000);
    continue;
  }

  try {
    const doc = await fetchDocument(job.source_document_id);
    if (!doc) throw new Error("source_document_not_found");

    if (!doc.root_title) {
      throw new Error("source_document_root_title_missing");
    }

    if (doc.source_wikitext?.trim()) {
      await enqueuePipelineStage(job, "source_render");
      await updatePipelineJob(job.id, {
        status: "pass",
        locked_by: null,
        locked_at: null,
        last_error: null,
        checkpoint: {
          rawAlreadyPresent: true,
          completedAt: new Date().toISOString(),
        },
        finished_at: new Date().toISOString(),
      });
      console.log("RAW PASS (already present) " + doc.source_title);
      if (once) break;
      continue;
    }

    console.log("RAW CAPTURE " + doc.source_title);
    await startRawCapture(doc);
    const latest = await waitForRawCapture(doc, job);

    await enqueuePipelineStage(job, "source_render");
    await updatePipelineJob(job.id, {
      status: "pass",
      locked_by: null,
      locked_at: null,
      last_error: null,
      checkpoint: {
        rawCapturedAt: latest.raw_extracted_at || new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
      finished_at: new Date().toISOString(),
    });

    console.log("RAW PASS " + latest.source_title);
  } catch (error) {
    console.error(
      "RAW FAILED " +
        job.source_title +
        " · " +
        String(error?.message || error),
    );
    await fail(job, error);
  }

  if (once) break;
}
