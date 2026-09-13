#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DEFAULT_SUPABASE_URL = "https://hukrrzhltiyirtkxmotj.supabase.co";

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

const args = process.argv.slice(2);
const runArg = args.find((arg) => arg.startsWith("--run="));
const jobArg = args.find((arg) => arg.startsWith("--job="));
const statusArg = args.find((arg) => arg.startsWith("--status="));
const currentArg = args.find((arg) => arg.startsWith("--chunk-current="));
const totalArg = args.find((arg) => arg.startsWith("--chunk-total="));
const errorArg = args.find((arg) => arg.startsWith("--error="));
const checkpointArg = args.find((arg) => arg.startsWith("--checkpoint="));

const runId = runArg ? runArg.slice("--run=".length).trim() : "";
const jobId = jobArg ? jobArg.slice("--job=".length).trim() : "";

const supabaseUrl = String(
  process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
).replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

if (!serviceRoleKey) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is required.");
  process.exit(2);
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
    throw new Error("Supabase " + response.status + ": " + body.slice(0, 1000));
  }
  return body ? JSON.parse(body) : null;
}

function parseCheckpoint(raw) {
  if (!raw) return undefined;
  try {
    return JSON.parse(decodeURIComponent(raw));
  } catch {
    throw new Error("--checkpoint must be URL-encoded JSON");
  }
}

if (jobId && (statusArg || currentArg || totalArg || errorArg || checkpointArg)) {
  const patch = { updated_at: new Date().toISOString() };
  if (statusArg) patch.status = statusArg.slice("--status=".length);
  if (currentArg) patch.chunk_current = Number(currentArg.slice("--chunk-current=".length));
  if (totalArg) patch.chunk_total = Number(totalArg.slice("--chunk-total=".length));
  if (errorArg) patch.last_error = decodeURIComponent(errorArg.slice("--error=".length));
  if (checkpointArg) patch.checkpoint = parseCheckpoint(checkpointArg.slice("--checkpoint=".length));

  if (["pass", "failed", "needs_review", "skipped"].includes(patch.status)) {
    patch.finished_at = new Date().toISOString();
    patch.locked_by = null;
    patch.locked_at = null;
  }

  const rows = await db(
    "pipeline_jobs?id=eq." + encodeURIComponent(jobId),
    {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(patch),
    },
  );

  const updated = rows?.[0] || null;
  if (!updated) {
    console.error("Pipeline job not found: " + jobId);
    process.exit(1);
  }

  console.log(
    "CHECKPOINT " +
      updated.source_title +
      " · " +
      updated.stage +
      " · " +
      updated.status +
      " · chunk " +
      updated.chunk_current +
      "/" +
      updated.chunk_total,
  );
}

if (runId) {
  const runs = await db(
    "pipeline_runs?id=eq." +
      encodeURIComponent(runId) +
      "&select=id,root_title,status,scope_count,completed_count,failed_count,review_count,created_at,started_at,updated_at,finished_at&limit=1",
  );
  const run = runs?.[0] || null;
  if (!run) {
    console.error("Pipeline run not found: " + runId);
    process.exit(1);
  }

  const jobs = await db(
    "pipeline_jobs?run_id=eq." +
      encodeURIComponent(runId) +
      "&select=id,source_title,stage,status,attempt,max_attempts,chunk_current,chunk_total,last_error,locked_by,updated_at" +
      "&order=source_title.asc,stage.asc",
  );

  const counts = {};
  for (const job of jobs || []) {
    const key = job.stage + ":" + job.status;
    counts[key] = (counts[key] || 0) + 1;
  }

  console.log("");
  console.log("Kpoparkive Pipeline Queue");
  console.log(
    run.root_title +
      " · " +
      run.status +
      " · scope=" +
      run.scope_count +
      " · jobs=" +
      (jobs || []).length,
  );
  for (const [key, value] of Object.entries(counts).sort()) {
    console.log(key.padEnd(28) + value);
  }

  const active = (jobs || []).filter(
    (job) => !["pass", "skipped"].includes(job.status),
  );
  if (active.length) {
    console.log("");
    for (const job of active) {
      console.log(
        job.status.toUpperCase().padEnd(12) +
          job.stage.padEnd(16) +
          job.source_title +
          " · attempt=" +
          job.attempt +
          " · chunk=" +
          job.chunk_current +
          "/" +
          job.chunk_total +
          (job.last_error ? " · " + job.last_error : ""),
      );
    }
  }
}

if (!runId && !jobId) {
  console.error("Usage:");
  console.error("  npm run namu:pipeline:queue -- --run=<run-id>");
  console.error("  npm run namu:pipeline:queue -- --job=<job-id> --chunk-current=18 --chunk-total=43 --status=running");
  process.exit(2);
}
