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
const skipImport = args.includes("--skip-import");
const skipHttp = args.includes("--skip-http");
const refreshImport = args.includes("--refresh-import");

const maxDepth = Math.max(0, Math.min(4, Number(valueArg("max-depth") || 2) || 2));
const maxDocuments = Math.max(
  10,
  Math.min(200, Number(valueArg("max-documents") || 80) || 80),
);
const maxCore = Math.max(5, Math.min(60, Number(valueArg("max-core") || 40) || 40));

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
    'Usage: npm run namu:pipeline:start -- --root="BLACKPINK" [--dry-run]',
  );
  console.error(
    "   or: npm run namu:pipeline:start -- --resume=<pipeline-run-id>",
  );
  process.exit(2);
}

requireServiceRole();

const children = new Map();
let stopping = false;
let ownedNext = null;
let ownedCaptureHelper = null;
let activeRunId = resumeRunId || "";
let activeRootTitle = rootTitle || "";
let lastProgressLine = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    cache: "no-store",
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(
      "HTTP " +
        response.status +
        " " +
        url +
        ": " +
        String(body?.error || body?.raw || text).slice(0, 1200),
    );
  }
  return body;
}

function spawnNode(label, script, scriptArgs = [], env = {}) {
  const child = spawn(
    process.execPath,
    [path.resolve(ROOT, script), ...scriptArgs],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
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
        if (!stopping && activeRunId) {
          startManagedWorker(label);
        }
      }, 3000).unref();
    }
  });

  return child;
}

function workerSpec(label) {
  if (label === "raw-1") {
    return ["scripts/namu-raw-worker.mjs", ["--run=" + activeRunId]];
  }
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

async function helperAlive() {
  try {
    const response = await fetch("http://127.0.0.1:43117/clone/status", {
      cache: "no-store",
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureCaptureHelper() {
  if (await helperAlive()) {
    console.log("Capture helper: already running");
    return;
  }

  console.log("Capture helper: starting");
  ownedCaptureHelper = spawnNode(
    "__capture-helper__",
    "scripts/namu-capture-helper-all.mjs",
    [],
  );

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await helperAlive()) return;
    await sleep(500);
  }
  throw new Error("capture helper did not become ready on 127.0.0.1:43117");
}

async function nextAlive() {
  try {
    const response = await fetch("http://127.0.0.1:3000/", {
      redirect: "manual",
      cache: "no-store",
    });
    return response.status >= 200 && response.status < 500;
  } catch {
    return false;
  }
}

async function ensureNextDev() {
  if (await nextAlive()) {
    console.log("Next.js: already running on :3000");
    return;
  }

  const nextBin = path.resolve(
    ROOT,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next",
  );

  console.log("Next.js: starting local dev server for admin import");
  ownedNext = spawnNode("__next-dev__", nextBin, ["dev"]);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await nextAlive()) return;
    await sleep(500);
  }

  throw new Error("local Next.js did not become ready on :3000");
}

async function rootDocuments() {
  if (!activeRootTitle) return [];
  return (
    (await pipelineDb(
      "source_documents?root_title=eq." +
        encodeURIComponent(activeRootTitle) +
        "&select=id,source_title,crawl_depth,source_wikitext,raw_extracted_at" +
        "&order=crawl_depth.asc,source_title.asc",
    )) || []
  );
}

async function bootstrapImport() {
  const existing = await rootDocuments();
  if (existing.length > 0 && !refreshImport) {
    console.log(
      "Initial import: reuse " +
        existing.length +
        " existing source document(s) for " +
        activeRootTitle,
    );
    return;
  }

  if (skipImport) {
    if (!existing.length) {
      throw new Error(
        "No source_documents exist for " +
          activeRootTitle +
          " and --skip-import was supplied.",
      );
    }
    return;
  }

  const adminKey = process.env.KPOPARKIVE_ADMIN_KEY || "";
  if (!adminKey) {
    throw new Error(
      "KPOPARKIVE_ADMIN_KEY is required for automatic initial import.",
    );
  }

  await ensureNextDev();

  console.log(
    "Initial import: " +
      activeRootTitle +
      " depth=" +
      maxDepth +
      " maxDocs=" +
      maxDocuments,
  );

  const result = await fetchJson(
    "http://127.0.0.1:3000/api/admin/namu-import",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-key": adminKey,
      },
      body: JSON.stringify({
        rootTitle: activeRootTitle,
        maxDepth,
        maxDocuments,
      }),
    },
  );

  console.log(
    "Initial import complete: fetched=" +
      Number(result?.fetched || 0) +
      " errors=" +
      Number(result?.errors || 0) +
      " queuedImages=" +
      Number(result?.queuedImages || 0),
  );

  const after = await rootDocuments();
  if (!after.length) {
    throw new Error("Initial import returned but no source documents exist.");
  }
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
  console.log("Core scope: generating deterministic release scope");
  const stdout = await runNodeCapture("scripts/namu-scope.mjs", [
    "--root=" + encodeURIComponent(activeRootTitle),
    "--max-core=" + maxCore,
    "--apply",
    "--json",
  ]);

  const parsed = JSON.parse(stdout);
  console.log(
    "Core scope: " +
      parsed.coreCount +
      " article(s), template dependencies=" +
      parsed.templateDependencyCount +
      ", needsRaw=" +
      parsed.needsRawCount,
  );
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
  if (!runId) throw new Error("Pipeline controller did not return persistedRunId");
  return { runId, snapshot: parsed };
}

async function fetchRun(runId) {
  const rows = await pipelineDb(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&select=id,root_title,status,scope_count,completed_count,failed_count,review_count,created_at,started_at,updated_at,finished_at&limit=1",
  );
  return rows?.[0] || null;
}

async function setRunRunning(runId) {
  await pipelineDb("pipeline_runs?id=eq." + encodeURIComponent(runId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "running",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
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
  startManagedWorker("raw-1");

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
    await pipelineDb("pipeline_runs?id=eq." + encodeURIComponent(run.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "paused",
        review_count: reviewDocs.size,
        failed_count: failedDocs.size,
        updated_at: new Date().toISOString(),
      }),
    });
    return true;
  }

  return false;
}

async function monitorRun() {
  while (!stopping) {
    const run = await fetchRun(activeRunId);
    if (!run) throw new Error("pipeline run disappeared: " + activeRunId);

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

  for (const [label, child] of children.entries()) {
    if (label === "__next-dev__" && child !== ownedNext) continue;
    if (label === "__capture-helper__" && child !== ownedCaptureHelper) continue;
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
  if (resumeRunId) {
    const run = await fetchRun(resumeRunId);
    if (!run) throw new Error("Pipeline run not found: " + resumeRunId);
    activeRunId = run.id;
    activeRootTitle = run.root_title;
    console.log(
      "RESUME " +
        activeRootTitle +
        " · run=" +
        activeRunId +
        " · status=" +
        run.status,
    );
  } else {
    if (dryRun) {
      console.log("Kpoparkive Pipeline Plan · DRY RUN");
      console.log("root=" + activeRootTitle);
      console.log(
        "import depth=" +
          maxDepth +
          " maxDocs=" +
          maxDocuments +
          " maxCore=" +
          maxCore,
      );
      console.log(
        "workers raw=1 source=" +
          sourceWorkers +
          " translate=" +
          translateWorkers +
          " render=" +
          renderWorkers +
          " publish=1 integration=" +
          integrationWorkers,
      );
      console.log("No database rows or source documents were modified.");
      process.exit(0);
    }

    await bootstrapImport();
    await generateScope();

    const created = await createPersistentRun();
    activeRunId = created.runId;

    console.log(
      "Pipeline run created: " +
        activeRunId +
        " · root=" +
        activeRootTitle,
    );
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is required before production translation workers can start.",
    );
  }

  await setRunRunning(activeRunId);
  await ensureCaptureHelper();
  startWorkers();

  const exitCode = await monitorRun();
  stopAll();
  process.exitCode = exitCode;
} catch (error) {
  console.error(
    "PIPELINE FATAL · " + String(error?.stack || error?.message || error),
  );
  stopAll();
  process.exitCode = 1;
}
