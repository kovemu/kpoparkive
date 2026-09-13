import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROOT = process.cwd();
const SUPABASE_URL = String(
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
    "https://hukrrzhltiyirtkxmotj.supabase.co",
).replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY || "";
const DATA_ROOT = path.resolve(
  process.env.KPOPARKIVE_DATA_DIR ||
    path.join(ROOT, ".kpoparkive-data"),
);
const CONTROL_DIR = path.join(DATA_ROOT, "pipeline-control");

function isLocalRequest(request: Request) {
  if (process.env.KPOPARKIVE_ALLOW_LOCAL_PIPELINE === "1") return true;
  const host = String(
    request.headers.get("x-forwarded-host") ||
      request.headers.get("host") ||
      "",
  ).toLowerCase();

  return (
    host.startsWith("localhost:") ||
    host === "localhost" ||
    host.startsWith("127.0.0.1:") ||
    host === "127.0.0.1"
  );
}

function unauthorized(request: Request) {
  if (!isLocalRequest(request)) {
    return NextResponse.json(
      {
        error:
          "Pipeline control is local-only. Open this page from localhost.",
      },
      { status: 403 },
    );
  }

  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!SERVICE_ROLE_KEY) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is not configured." },
      { status: 500 },
    );
  }

  return null;
}

function headers(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: "Bearer " + SERVICE_ROLE_KEY,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname: string, init: RequestInit = {}) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/" + pathname, {
    ...init,
    headers: {
      ...headers(),
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      "Supabase " + response.status + ": " + text.slice(0, 1200),
    );
  }

  return text ? JSON.parse(text) : null;
}

function normalizeRoot(value: unknown) {
  return String(value || "").normalize("NFKC").trim();
}

function rootKey(rootTitle: string) {
  return Buffer.from(rootTitle, "utf8").toString("base64url").slice(0, 100);
}

function controlPath(rootTitle: string) {
  return path.join(CONTROL_DIR, rootKey(rootTitle) + ".json");
}

function logPath(rootTitle: string) {
  return path.join(CONTROL_DIR, rootKey(rootTitle) + ".log");
}

function readJson(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function tailFile(filePath: string, maxChars = 24000) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const value = fs.readFileSync(filePath, "utf8");
    return value.slice(-maxChars);
  } catch {
    return "";
  }
}

function normalizeRoots(value: unknown) {
  const raw = Array.isArray(value)
    ? value
    : String(value || "").split(/[\n,]+/);

  return [
    ...new Set(
      raw.map(normalizeRoot).filter(Boolean),
    ),
  ];
}

function batchKey(roots: string[]) {
  return Buffer.from(roots.join("\n"), "utf8")
    .toString("base64url")
    .slice(0, 32);
}

function batchControlPath() {
  return path.join(CONTROL_DIR, "batch-current.json");
}

function batchLogPath(key: string) {
  return path.join(CONTROL_DIR, "batch-" + key + ".log");
}

function batchStatePath(roots: string[]) {
  return path.join(
    DATA_ROOT,
    "batches",
    "batch-" + batchKey(roots) + ".json",
  );
}

function readBatchStatus() {
  const control = readJson(batchControlPath());

  if (!control) {
    return {
      control: null,
      state: null,
      logTail: "",
    };
  }

  return {
    control,
    state: readJson(
      control.statePath ||
        batchStatePath(
          Array.isArray(control.roots) ? control.roots : [],
        ),
    ),
    logTail: tailFile(
      control.logPath ||
        batchLogPath(String(control.batchKey || "current")),
    ),
  };
}

function startBatchRunner(roots: string[]) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is missing in local .env.local.",
    );
  }

  fs.mkdirSync(CONTROL_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_ROOT, "batches"), {
    recursive: true,
  });

  const key = batchKey(roots);
  const outputPath = batchLogPath(key);
  const statePath = batchStatePath(roots);
  const outFd = fs.openSync(outputPath, "a");

  const child = spawn(
    process.execPath,
    [
      path.join(ROOT, "scripts", "namu-batch.mjs"),
      "--teams=" + encodeURIComponent(roots.join(",")),
      "--team-concurrency=2",
      "--translate-workers=4",
    ],
    {
      cwd: ROOT,
      env: process.env,
      detached: true,
      stdio: ["ignore", outFd, outFd],
    },
  );

  child.unref();
  fs.closeSync(outFd);

  const control = {
    batchKey: key,
    roots,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    logPath: outputPath,
    statePath,
  };

  fs.writeFileSync(
    batchControlPath(),
    JSON.stringify(control, null, 2) + "\n",
    "utf8",
  );

  return control;
}

function stopBatchRunner() {
  const control = readJson(batchControlPath());
  const pid = Number(control?.pid || 0);

  if (!pid) {
    return {
      stopped: false,
      reason: "No local batch runner PID found.",
    };
  }

  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { encoding: "utf8" },
      );

      return {
        stopped: result.status === 0,
        pid,
        output: String(
          result.stdout || result.stderr || "",
        ).trim(),
      };
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    return { stopped: true, pid };
  } catch (error) {
    return {
      stopped: false,
      pid,
      reason:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

function runScopeCheck(rootTitle: string) {
  return new Promise<any>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(ROOT, "scripts", "namu-scope.mjs"),
        "--root=" + encodeURIComponent(rootTitle),
        "--json",
      ],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.once("error", reject);

    child.once("exit", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              "Collection scope check failed.",
          ),
        );
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Scope check returned invalid JSON."));
      }
    });
  });
}

async function latestRun(rootTitle: string) {
  const rows = await db(
    "pipeline_runs?root_title=eq." +
      encodeURIComponent(rootTitle) +
      "&select=id,root_title,status,scope_count,completed_count,failed_count,review_count,config,runner_id,heartbeat_at,created_at,started_at,updated_at,finished_at" +
      "&order=created_at.desc&limit=1",
  );

  return rows?.[0] || null;
}

async function runJobs(runId: string) {
  if (!runId) return [];

  return (
    (await db(
      "pipeline_jobs?run_id=eq." +
        encodeURIComponent(runId) +
        "&select=id,source_title,stage,status,attempt,max_attempts,chunk_current,chunk_total,last_error,updated_at" +
        "&order=source_title.asc,stage.asc",
    )) || []
  );
}

function summarizeJobs(
  jobs: any[],
  dependencyTotal = 0,
) {
  const byStage: Record<string, Record<string, number>> = {};
  const coreByStage: Record<string, Record<string, number>> = {};
  const dependencyByStage: Record<string, Record<string, number>> = {};
  const review: any[] = [];
  const dependencyDocs = new Set<string>();
  const dependencyReadyDocs = new Set<string>();

  function add(
    target: Record<string, Record<string, number>>,
    stage: string,
    status: string,
  ) {
    if (!target[stage]) target[stage] = {};
    target[stage][status] =
      (target[stage][status] || 0) + 1;
  }

  for (const job of jobs) {
    const dependency = /^(?:틀|Template):/i.test(
      String(job.source_title || ""),
    );

    add(byStage, job.stage, job.status);

    if (dependency) {
      add(dependencyByStage, job.stage, job.status);
      dependencyDocs.add(job.source_title);

      if (
        job.stage === "en_render" &&
        job.status === "pass"
      ) {
        dependencyReadyDocs.add(job.source_title);
      }
    } else {
      add(coreByStage, job.stage, job.status);
    }

    if (["needs_review", "failed"].includes(job.status)) {
      review.push({ ...job, dependency });
    }
  }

  const total = Math.max(
    Number(dependencyTotal || 0),
    dependencyDocs.size,
  );
  const alreadyReady = Math.max(
    0,
    total - dependencyDocs.size,
  );
  const dependencyReady =
    alreadyReady + dependencyReadyDocs.size;

  return {
    byStage,
    coreByStage,
    dependencyByStage,
    dependencyProgress: {
      total,
      ready: Math.min(total, dependencyReady),
      waiting: Math.max(0, total - dependencyReady),
    },
    review,
  };
}

async function recentRoots() {
  const rows =
    (await db(
      "source_documents?select=root_title,source_title,updated_at" +
        "&root_title=not.is.null" +
        "&order=updated_at.desc&limit=1000",
    )) || [];

  const seen = new Set<string>();
  const roots: any[] = [];

  for (const row of rows) {
    const root = normalizeRoot(row.root_title);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    roots.push({
      rootTitle: root,
      sourceTitle: row.source_title,
      updatedAt: row.updated_at,
    });
    if (roots.length >= 80) break;
  }

  return roots;
}

async function captureHelperStatus() {
  try {
    const response = await fetch(
      "http://127.0.0.1:43117/clone/status",
      { cache: "no-store" },
    );

    if (!response.ok) {
      return {
        available: false,
        error: "helper_http_" + response.status,
      };
    }

    const body = await response.json();

    return {
      available: true,
      job: body?.job || body || null,
    };
  } catch (error) {
    return {
      available: false,
      error:
        error instanceof Error
          ? error.message
          : String(error),
    };
  }
}


function startRunner(rootTitle: string, retryReview = false) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "OPENAI_API_KEY is missing in local .env.local.",
    );
  }

  fs.mkdirSync(CONTROL_DIR, { recursive: true });

  const outputPath = logPath(rootTitle);
  const outFd = fs.openSync(outputPath, "a");

  const args = [
    path.join(ROOT, "scripts", "namu-pipeline-start.mjs"),
    "--root=" + encodeURIComponent(rootTitle),
  ];

  if (retryReview) args.push("--retry-review");

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ["ignore", outFd, outFd],
  });

  child.unref();
  fs.closeSync(outFd);

  const control = {
    rootTitle,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    retryReview,
    logPath: outputPath,
  };

  fs.writeFileSync(
    controlPath(rootTitle),
    JSON.stringify(control, null, 2) + "\n",
    "utf8",
  );

  return control;
}

function stopRunner(rootTitle: string) {
  const control = readJson(controlPath(rootTitle));
  const pid = Number(control?.pid || 0);

  if (!pid) {
    return { stopped: false, reason: "No local runner PID found." };
  }

  try {
    if (process.platform === "win32") {
      const result = spawnSync(
        "taskkill",
        ["/PID", String(pid), "/T", "/F"],
        { encoding: "utf8" },
      );

      return {
        stopped: result.status === 0,
        pid,
        output: String(result.stdout || result.stderr || "").trim(),
      };
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      process.kill(pid, "SIGTERM");
    }

    return { stopped: true, pid };
  } catch (error) {
    return {
      stopped: false,
      pid,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

async function markRunPaused(rootTitle: string) {
  const run = await latestRun(rootTitle);
  if (!run?.id || !["queued", "running"].includes(run.status)) return run;

  const now = new Date().toISOString();

  await db(
    "pipeline_runs?id=eq." + encodeURIComponent(run.id),
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "paused",
        runner_id: null,
        heartbeat_at: null,
        updated_at: now,
      }),
    },
  );

  return latestRun(rootTitle);
}

export async function GET(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const url = new URL(request.url);
    const rootTitle = normalizeRoot(url.searchParams.get("root"));

    if (!rootTitle) {
      return NextResponse.json({
        ok: true,
        localOnly: true,
        roots: await recentRoots(),
        capture: await captureHelperStatus(),
        batch: readBatchStatus(),
      });
    }

    const run = await latestRun(rootTitle);
    const jobs = run?.id ? await runJobs(run.id) : [];
    const control = readJson(controlPath(rootTitle));

    return NextResponse.json({
      ok: true,
      localOnly: true,
      rootTitle,
      run,
      jobsSummary: summarizeJobs(
        jobs,
        Number(run?.config?.dependencyCount || 0),
      ),
      control,
      capture: await captureHelperStatus(),
      batch: readBatchStatus(),
      logTail: tailFile(logPath(rootTitle)),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}

export async function POST(request: Request) {
  const denied = unauthorized(request);
  if (denied) return denied;

  try {
    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "");
    const rootTitle = normalizeRoot(body?.rootTitle);

    if (action === "batch_start") {
      const requestedRoots = normalizeRoots(body?.roots);

      if (!requestedRoots.length) {
        return NextResponse.json(
          { error: "At least one team is required." },
          { status: 400 },
        );
      }

      const capture = await captureHelperStatus();
      const collectingRoot =
        capture?.available && capture?.job?.running
          ? normalizeRoot(capture.job.rootTitle)
          : "";

      const roots = requestedRoots.filter(
        (root) => root !== collectingRoot,
      );
      const deferredRoots = requestedRoots.filter(
        (root) => root === collectingRoot,
      );

      if (!roots.length) {
        return NextResponse.json(
          {
            error:
              "Every selected team is still being collected.",
            code: "COLLECTION_RUNNING",
            deferredRoots,
            capture,
          },
          { status: 409 },
        );
      }

      const currentBatch = readBatchStatus();
      const currentState = currentBatch?.state;
      const currentRunning = Object.values(
        currentState?.teams || {},
      ).some(
        (item: any) => item?.status === "running",
      );

      if (currentRunning) {
        return NextResponse.json(
          {
            error: "A batch is already running.",
            code: "BATCH_RUNNING",
            batch: currentBatch,
          },
          { status: 409 },
        );
      }

      const control = startBatchRunner(roots);

      return NextResponse.json({
        ok: true,
        roots,
        deferredRoots,
        control,
        batch: readBatchStatus(),
      });
    }

    if (action === "batch_stop") {
      const stop = stopBatchRunner();

      return NextResponse.json({
        ok: true,
        stop,
        batch: readBatchStatus(),
      });
    }

    if (!rootTitle) {
      return NextResponse.json(
        { error: "rootTitle is required." },
        { status: 400 },
      );
    }

    if (action === "check") {
      const collection = await runScopeCheck(rootTitle);

      return NextResponse.json({
        ok: true,
        rootTitle,
        collection,
        ready: Number(collection?.needsRawCount || 0) === 0,
      });
    }

    if (action === "start" || action === "retry") {
      const capture = await captureHelperStatus();
      const captureJob = capture?.job || null;

      if (
        capture?.available &&
        captureJob?.running === true &&
        normalizeRoot(captureJob?.rootTitle) === rootTitle
      ) {
        return NextResponse.json(
          {
            error:
              "The Chrome extension is still collecting this team. Finish collection first.",
            code: "COLLECTION_RUNNING",
            rootTitle,
            capture,
          },
          { status: 409 },
        );
      }

      const collection = await runScopeCheck(rootTitle);

      if (Number(collection?.needsRawCount || 0) > 0) {
        return NextResponse.json(
          {
            error: "Collection is incomplete.",
            code: "COLLECTION_REQUIRED",
            rootTitle,
            collection,
          },
          { status: 409 },
        );
      }

      const current = await latestRun(rootTitle);

      if (
        current?.status === "running" &&
        current?.heartbeat_at &&
        Date.now() - Date.parse(current.heartbeat_at) < 120000
      ) {
        return NextResponse.json({
          ok: true,
          alreadyRunning: true,
          rootTitle,
          run: current,
        });
      }

      const control = startRunner(rootTitle, action === "retry");

      return NextResponse.json({
        ok: true,
        rootTitle,
        collection,
        control,
      });
    }

    if (action === "stop") {
      const stop = stopRunner(rootTitle);
      const run = await markRunPaused(rootTitle);

      return NextResponse.json({
        ok: true,
        rootTitle,
        stop,
        run,
      });
    }

    return NextResponse.json(
      { error: "Unsupported action." },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
