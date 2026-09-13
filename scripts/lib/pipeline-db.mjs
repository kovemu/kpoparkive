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

const supabaseUrl = String(
  process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
).replace(/\/$/, "");
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export function requireServiceRole() {
  if (!serviceRoleKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is required.");
  }
}

export async function pipelineDb(pathname, init = {}) {
  requireServiceRole();
  const response = await fetch(supabaseUrl + "/rest/v1/" + pathname, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: "Bearer " + serviceRoleKey,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error("Supabase " + response.status + ": " + body.slice(0, 1200));
  }
  return body ? JSON.parse(body) : null;
}

export async function claimPipelineJob(runId, workerId, stage) {
  const rows = await pipelineDb("rpc/claim_pipeline_job", {
    method: "POST",
    body: JSON.stringify({
      p_run_id: runId,
      p_worker_id: workerId,
      p_stage: stage,
    }),
  });
  return Array.isArray(rows) ? rows[0] || null : rows || null;
}

export async function updatePipelineJob(jobId, patch) {
  await pipelineDb("pipeline_jobs?id=eq." + encodeURIComponent(jobId), {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      ...patch,
      updated_at: new Date().toISOString(),
    }),
  });
}

export async function enqueuePipelineStage(job, stage, maxAttempts = 3) {
  await pipelineDb(
    "pipeline_jobs?on_conflict=run_id,source_document_id,stage",
    {
      method: "POST",
      headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
      body: JSON.stringify({
        run_id: job.run_id,
        source_document_id: job.source_document_id,
        source_title: job.source_title,
        stage,
        status: "queued",
        attempt: 0,
        max_attempts: maxAttempts,
        checkpoint: {},
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

export function nextRetryStatus(job) {
  return Number(job?.attempt || 0) >= Number(job?.max_attempts || 3)
    ? "needs_review"
    : "retry";
}
