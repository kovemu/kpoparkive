#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import {
  pipelineDb,
  requireServiceRole,
} from "./lib/pipeline-db.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);

const valueArg = (name) => {
  const found = args.find((arg) => arg.startsWith("--" + name + "="));
  return found ? decodeURIComponent(found.slice(name.length + 3)) : "";
};

const rootTitle = (
  valueArg("root") ||
  args.find((arg) => !arg.startsWith("--")) ||
  ""
).normalize("NFKC").trim();

const resumeRunId = valueArg("resume");
const dryRun = args.includes("--dry-run");
const skipHttp = args.includes("--skip-http");
const retryReview = args.includes("--retry-review");
const runnerId =
  valueArg("runner-id") ||
  "runner-" + process.pid + "-" + Date.now().toString(36);

const maxCore = Math.max(
  5,
  Math.min(60, Number(valueArg("max-core") || 40) || 40),
);
const translateWorkers = Math.max(
  1,
  Math.min(20, Number(valueArg("translate-workers") || 5) || 5),
);
const renderWorkers = Math.max(
  1,
  Math.min(6, Number(valueArg("render-workers") || 2) || 2),
);
const sourceWorkers = Math.max(
  1,
  Math.min(4, Number(valueArg("source-workers") || 1) || 1),
);
const integrationWorkers = Math.max(
  1,
  Math.min(4, Number(valueArg("integration-workers") || 1) || 1),
);

if (!rootTitle && !resumeRunId) {
  console.error(
    'Usage: npm run namu:pipeline:start -- --root="BLACKPINK"',
  );
  console.error(
    "   or: npm run namu:pipeline:start -- --resume=<pipeline-run-id>",
  );
  process.exit(2);
}

requireServiceRole();

const children = new Map();
let stopping = false;
let activeRunId = resumeRunId || "";
let activeRootTitle = rootTitle || "";
let lastProgressLine = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnNode(label, script, scriptArgs = []) {
  const child = spawn(
    process.execPath,
    [path.resolve(ROOT, script), ...scriptArgs],
    {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  children.set(label, child);

  child.on("exit", (code, signal) => {
    if (children.get(label) === child) children.delete(label);
    if (stopping) return;

    console.warn(
      "WORKER EXIT " +
        label +
        " code=" +
        String(code ?? "null") +
        " signal=" +
        String(signal || "none"),
    );

    if ((code ?? 0) !== 0) {
      setTimeout(() => {
        if (!stopping && activeRunId) startManagedWorker(label);
      }, 3000).unref();
    }
  });

  return child;
}

function workerSpec(label) {
  if (label.startsWith("source-")) {
    return ["scripts/namu-source-worker.mjs", ["--run=" + activeRunId]];
  }
  if (label.startsWith("translate-")) {
    return ["scripts/namu-translation-worker.mjs", ["--run=" + activeRunId]];
  }
  if (label.startsWith("render-")) {
    return ["scripts/namu-render-worker.mjs", ["--run=" + activeRunId]];
  }
  if (label === "publish-1") {
    return ["scripts/namu-publish-worker.mjs", ["--run=" + activeRunId]];
  }
  if (label.startsWith("integration-")) {
    const workerArgs = ["--run=" + activeRunId];
    if (skipHttp) workerArgs.push("--skip-http");
    return ["scripts/namu-integration-worker.mjs", workerArgs];
  }
  return null;
}

function startManagedWorker(label) {
  const spec = workerSpec(label);
  if (!spec) return null;
  if (children.has(label)) return children.get(label);
  return spawnNode(label, spec[0], spec[1]);
}

function runNodeCapture(script, scriptArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.resolve(ROOT, script), ...scriptArgs],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );

    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else {
        reject(
          new Error(
            script +
              " exited code=" +
              String(code ?? "null") +
              " signal=" +
              String(signal || "none") +
              "\n" +
              stdout.slice(-3000),
          ),
        );
      }
    });
  });
}

async function generateScope() {
  console.log("Collection check: building core scope from captured documents");

  const stdout = await runNodeCapture("scripts/namu-scope.mjs", [
    "--root=" + encodeURIComponent(activeRootTitle),
    "--max-core=" + maxCore,
    "--apply",
    "--json",
  ]);

  const parsed = JSON.parse(stdout);

  console.log(
    "Collection check: core=" +
      parsed.coreCount +
      " templates=" +
      parsed.templateDependencyCount +
      " missingRAW=" +
      parsed.needsRawCount,
  );

  if (Number(parsed.needsRawCount || 0) > 0) {
    const missing = (
      await pipelineDb(
        "namu_raw_requirements?root_title=eq." +
          encodeURIComponent(activeRootTitle) +
          "&status=eq.needs_raw" +
          "&select=source_title,priority,reason_codes" +
          "&order=priority.desc,source_title.asc" +
          "&limit=100",
      )
    ) || [];

    console.error("");
    console.error(
      "COLLECTION_REQUIRED " +
        activeRootTitle +
        " · missing RAW=" +
        parsed.needsRawCount,
    );

    for (const row of missing.slice(0, 30)) {
      console.error("- " + row.source_title);
    }

    const error = new Error("manual_extension_collection_incomplete");
    error.exitCode = 4;
    throw error;
  }

  return parsed;
}

async function createPersistentRun() {
  const stdout = await runNodeCapture("scripts/namu-pipeline.mjs", [
    "--root=" + encodeURIComponent(activeRootTitle),
    "--persist",
    "--json",
  ]);

  const parsed = JSON.parse(stdout);
  const runId = parsed?.summary?.persistedRunId || "";
  if (!runId) {
    throw new Error("Pipeline controller did not return persistedRunId");
  }

  const rawJobs = (
    await pipelineDb(
      "pipeline_jobs?run_id=eq." +
        encodeURIComponent(runId) +
        "&stage=eq.raw&status=eq.queued&select=id,source_title&limit=100",
    )
  ) || [];

  if (rawJobs.length > 0) {
    await pipelineDb(
      "pipeline_runs?id=eq." + encodeURIComponent(runId),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "cancelled",
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }),
      },
    );

    const error = new Error(
      "manual_extension_collection_incomplete_after_scope",
    );
    error.exitCode = 4;
    throw error;
  }

  return { runId, snapshot: parsed };
}

async function fetchRun(runId) {
  const rows = await pipelineDb(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&select=id,root_title,status,scope_count,completed_count,failed_count,review_count,runner_id,heartbeat_at,created_at,started_at,updated_at,finished_at&limit=1",
  );
  return rows?.[0] || null;
}

async function findActiveRun(root) {
  const rows = await pipelineDb(
    "pipeline_runs?root_title=eq." +
      encodeURIComponent(root) +
      "&status=in.(queued,running,paused)" +
      "&select=id,root_title,status,scope_count,completed_count,failed_count,review_count,runner_id,heartbeat_at,created_at,started_at,updated_at,finished_at" +
      "&order=created_at.desc&limit=1",
  );
  return rows?.[0] || null;
}

async function claimRunLease(runId) {
  const result = await pipelineDb("rpc/claim_pipeline_run", {
    method: "POST",
    body: JSON.stringify({
      p_run_id: runId,
      p_runner_id: runnerId,
      p_stale_seconds: 120,
    }),
  });

  if (typeof result === "boolean") return result;
  if (Array.isArray(result)) return Boolean(result[0]);
  return Boolean(result);
}

async function heartbeatRun(runId) {
  await pipelineDb(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&runner_id=eq." +
      encodeURIComponent(runnerId),
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        heartbeat_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

async function releaseRunLease(runId) {
  if (!runId) return;

  await pipelineDb(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&runner_id=eq." +
      encodeURIComponent(runnerId),
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        runner_id: null,
        heartbeat_at: null,
        updated_at: new Date().toISOString(),
      }),
    },
  ).catch(() => {});
}

async function recoverInterruptedJobs(runId) {
  const rows = await pipelineDb(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&status=eq.running" +
      "&select=id",
  );

  if (!rows?.length) return 0;

  await pipelineDb(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&status=eq.running",
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "retry",
        locked_by: null,
        locked_at: null,
        last_error: "Recovered after previous pipeline runner stopped.",
        updated_at: new Date().toISOString(),
      }),
    },
  );

  return rows.length;
}

async function retryReviewJobs(runId) {
  const rows = await pipelineDb(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&status=in.(needs_review,failed)" +
      "&select=id",
  );

  if (!rows?.length) return 0;

  await pipelineDb(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&status=in.(needs_review,failed)",
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "retry",
        locked_by: null,
        locked_at: null,
        finished_at: null,
        updated_at: new Date().toISOString(),
      }),
    },
  );

  return rows.length;
}

async function setRunRunning(runId) {
  const current = await fetchRun(runId);
  const now = new Date().toISOString();

  await pipelineDb(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&runner_id=eq." +
      encodeURIComponent(runnerId),
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "running",
        started_at: current?.started_at || now,
        heartbeat_at: now,
        updated_at: now,
      }),
    },
  );
}

async function jobSummary(runId) {
  const jobs =
    (await pipelineDb(
      "pipeline_jobs?run_id=eq." +
        encodeURIComponent(runId) +
        "&select=stage,status,source_document_id,source_title,attempt,max_attempts,chunk_current,chunk_total,last_error",
    )) || [];

  const counts = {};
  for (const job of jobs) {
    const key = job.stage + ":" + job.status;
    counts[key] = (counts[key] || 0) + 1;
  }

  return { jobs, counts };
}

function startWorkers() {
  for (let index = 1; index <= sourceWorkers; index += 1) {
    startManagedWorker("source-" + index);
  }
  for (let index = 1; index <= translateWorkers; index += 1) {
    startManagedWorker("translate-" + index);
  }
  for (let index = 1; index <= renderWorkers; index += 1) {
    startManagedWorker("render-" + index);
  }

  startManagedWorker("publish-1");

  for (let index = 1; index <= integrationWorkers; index += 1) {
    startManagedWorker("integration-" + index);
  }
}

async function updatePausedIfStalled(run, jobs) {
  const runnable = jobs.filter((job) =>
    ["queued", "running", "retry"].includes(job.status),
  ).length;

  const reviewDocs = new Set(
    jobs
      .filter((job) => job.status === "needs_review")
      .map((job) => job.source_document_id),
  );

  const failedDocs = new Set(
    jobs
      .filter((job) => job.status === "failed")
      .map((job) => job.source_document_id),
  );

  if (
    runnable === 0 &&
    Number(run.completed_count || 0) < Number(run.scope_count || 0) &&
    (reviewDocs.size > 0 || failedDocs.size > 0)
  ) {
    await pipelineDb(
      "pipeline_runs?id=eq." + encodeURIComponent(run.id),
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "paused",
          review_count: reviewDocs.size,
          failed_count: failedDocs.size,
          updated_at: new Date().toISOString(),
        }),
      },
    );

    return true;
  }

  return false;
}

async function monitorRun() {
  while (!stopping) {
    const run = await fetchRun(activeRunId);
    if (!run) {
      throw new Error("pipeline run disappeared: " + activeRunId);
    }

    if (run.runner_id && run.runner_id !== runnerId) {
      throw new Error("pipeline runner lease lost to " + run.runner_id);
    }

    await heartbeatRun(activeRunId);

    const { jobs, counts } = await jobSummary(activeRunId);

    const progressLine =
      "RUN " +
      activeRootTitle +
      " · status=" +
      run.status +
      " · complete=" +
      run.completed_count +
      "/" +
      run.scope_count +
      " · review=" +
      run.review_count +
      " · jobs=" +
      Object.entries(counts)
        .sort()
        .map(([key, value]) => key + "=" + value)
        .join(",");

    if (progressLine !== lastProgressLine) {
      console.log(progressLine);
      lastProgressLine = progressLine;
    }

    if (run.status === "completed") {
      console.log("");
      console.log(
        "PIPELINE COMPLETE " +
          activeRootTitle +
          " · " +
          run.completed_count +
          "/" +
          run.scope_count,
      );
      return 0;
    }

    const paused = await updatePausedIfStalled(run, jobs);
    if (paused || run.status === "paused") {
      const review = jobs.filter((job) =>
        ["needs_review", "failed"].includes(job.status),
      );

      console.log("");
      console.log(
        "PIPELINE PAUSED " +
          activeRootTitle +
          " · human review required=" +
          review.length,
      );

      for (const job of review.slice(0, 30)) {
        console.log(
          job.status.toUpperCase() +
            " " +
            job.stage +
            " " +
            job.source_title +
            (job.last_error ? " · " + job.last_error : ""),
        );
      }

      return 3;
    }

    await sleep(5000);
  }

  return 0;
}

function stopAll() {
  if (stopping) return;
  stopping = true;

  for (const child of children.values()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

process.on("SIGINT", () => {
  stopAll();
  setTimeout(() => process.exit(130), 200).unref();
});

process.on("SIGTERM", () => {
  stopAll();
  setTimeout(() => process.exit(143), 200).unref();
});

try {
  if (dryRun) {
    console.log("Kpoparkive Post-Collection Pipeline · DRY RUN");
    console.log("root=" + (activeRootTitle || "(resume mode)"));
    console.log(
      "workers source=" +
        sourceWorkers +
        " translate=" +
        translateWorkers +
        " render=" +
        renderWorkers +
        " publish=1 integration=" +
        integrationWorkers,
    );
    console.log("NamuWiki collection is not performed by this command.");
    process.exit(0);
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required before translation workers can start.",
    );
  }

  let resumingExisting = false;

  if (resumeRunId) {
    const run = await fetchRun(resumeRunId);
    if (!run) {
      throw new Error("Pipeline run not found: " + resumeRunId);
    }

    activeRunId = run.id;
    activeRootTitle = run.root_title;
    resumingExisting = true;
  } else {
    const existingRun = await findActiveRun(activeRootTitle);

    if (existingRun) {
      if (existingRun.status === "paused" && !retryReview) {
        console.error(
          "Existing pipeline is paused for review: " +
            existingRun.id +
            ". Re-run with --retry-review after fixing the blocker.",
        );
        process.exitCode = 3;
        process.exit();
      }

      activeRunId = existingRun.id;
      activeRootTitle = existingRun.root_title;
      resumingExisting = true;
    }
  }

  if (!resumingExisting) {
    await generateScope();

    const created = await createPersistentRun();
    activeRunId = created.runId;

    console.log(
      "Pipeline run created: " +
        activeRunId +
        " · root=" +
        activeRootTitle,
    );
  } else {
    const run = await fetchRun(activeRunId);

    console.log(
      "RESUME " +
        activeRootTitle +
        " · run=" +
        activeRunId +
        " · status=" +
        run?.status,
    );
  }

  const leased = await claimRunLease(activeRunId);

  if (!leased) {
    const run = await fetchRun(activeRunId);
    throw new Error(
      "Another pipeline runner is active for this run: " +
        String(run?.runner_id || "unknown"),
    );
  }

  if (resumingExisting) {
    const recovered = await recoverInterruptedJobs(activeRunId);
    if (recovered > 0) {
      console.log("Recovered " + recovered + " interrupted job(s).");
    }

    if (retryReview) {
      const retried = await retryReviewJobs(activeRunId);
      if (retried > 0) {
        console.log("Re-queued " + retried + " review/failed job(s).");
      }
    }
  }

  await setRunRunning(activeRunId);
  startWorkers();

  const exitCode = await monitorRun();

  await releaseRunLease(activeRunId);
  stopAll();
  process.exitCode = exitCode;
} catch (error) {
  console.error(
    "PIPELINE FATAL · " +
      String(error?.stack || error?.message || error),
  );

  await releaseRunLease(activeRunId);
  stopAll();

  process.exitCode = Number(error?.exitCode || 1);
}
