#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
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

const fileArg = valueArg("file");
const teamsArg = valueArg("teams");
const concurrency = Math.max(
  1,
  Math.min(4, Number(valueArg("team-concurrency") || 2) || 2),
);
const translateWorkers = Math.max(
  1,
  Math.min(10, Number(valueArg("translate-workers") || 4) || 4),
);
const maxRetries = Math.max(
  0,
  Math.min(5, Number(valueArg("max-retries") || 2) || 2),
);
const retryPaused = args.includes("--retry-paused");
const rebuild = args.includes("--rebuild");
const skipHttp = args.includes("--skip-http");
const dryRun = args.includes("--dry-run");

requireServiceRole();

function normalizeTeam(value) {
  return String(value || "").normalize("NFKC").trim();
}

function loadTeams() {
  const values = [];

  if (fileArg) {
    const filePath = path.resolve(ROOT, fileArg);

    if (!fs.existsSync(filePath)) {
      throw new Error("Team file not found: " + filePath);
    }

    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const value = normalizeTeam(line.replace(/\s+#.*$/, ""));
      if (value && !value.startsWith("#")) values.push(value);
    }
  }

  if (teamsArg) {
    for (const part of teamsArg.split(",")) {
      const value = normalizeTeam(part);
      if (value) values.push(value);
    }
  }

  return [...new Set(values)];
}

const teams = loadTeams();

if (!teams.length) {
  console.error(
    'Usage: npm run namu:batch -- --file=teams.txt [--team-concurrency=2]',
  );
  console.error(
    '   or: npm run namu:batch -- --teams="BLACKPINK,aespa,IVE"',
  );
  process.exit(2);
}

if (!dryRun && !process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required.");
}

const dataRoot = path.resolve(
  process.env.KPOPARKIVE_DATA_DIR || path.join(ROOT, ".kpoparkive-data"),
);
const batchDir = path.join(dataRoot, "batches");

fs.mkdirSync(batchDir, { recursive: true });

const batchKey = Buffer.from(teams.join("\n"), "utf8")
  .toString("base64url")
  .slice(0, 32);
const statePath = path.join(batchDir, "batch-" + batchKey + ".json");

const state = fs.existsSync(statePath)
  ? JSON.parse(fs.readFileSync(statePath, "utf8"))
  : {
      createdAt: new Date().toISOString(),
      teams: Object.fromEntries(
        teams.map((team) => [
          team,
          {
            status: "pending",
            attempts: 0,
            updatedAt: new Date().toISOString(),
          },
        ]),
      ),
    };

for (const team of teams) {
  if (!state.teams[team]) {
    state.teams[team] = {
      status: "pending",
      attempts: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

function saveState() {
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(
    statePath,
    JSON.stringify(state, null, 2) + "\n",
    "utf8",
  );
}

saveState();

const activeChildren = new Map();
let stopping = false;

async function latestCompletedRun(team) {
  const rows = await pipelineDb(
    "pipeline_runs?root_title=eq." +
      encodeURIComponent(team) +
      "&status=eq.completed" +
      "&select=id,finished_at,scope_count,completed_count" +
      "&order=finished_at.desc.nullslast,created_at.desc&limit=1",
  );

  return rows?.[0] || null;
}

function pipelineArgs(team) {
  const result = [
    "--root=" + encodeURIComponent(team),
    "--translate-workers=" + translateWorkers,
    "--render-workers=1",
    "--source-workers=1",
    "--integration-workers=1",
  ];

  if (retryPaused) result.push("--retry-review");
  if (skipHttp) result.push("--skip-http");

  return result;
}

function runTeam(team) {
  return new Promise((resolve) => {
    const item = state.teams[team];

    item.status = "running";
    item.attempts = Number(item.attempts || 0) + 1;
    item.startedAt = item.startedAt || new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    saveState();

    console.log("");
    console.log(
      "BATCH START " +
        team +
        " · attempt=" +
        item.attempts,
    );

    const child = spawn(
      process.execPath,
      [
        path.resolve(ROOT, "scripts/namu-pipeline-start.mjs"),
        ...pipelineArgs(team),
      ],
      {
        cwd: ROOT,
        env: process.env,
        stdio: ["ignore", "inherit", "inherit"],
      },
    );

    activeChildren.set(team, child);

    child.once("exit", (code, signal) => {
      activeChildren.delete(team);

      const exitCode = Number(code ?? 1);
      item.lastExitCode = exitCode;
      item.lastSignal = signal || null;
      item.updatedAt = new Date().toISOString();

      if (exitCode === 0) {
        item.status = "completed";
        item.completedAt = new Date().toISOString();
        console.log("BATCH COMPLETE " + team);
      } else if (exitCode === 4) {
        item.status = "collection_required";
        console.log(
          "BATCH COLLECTION REQUIRED " +
            team +
            " · skipped until extension capture is complete",
        );
      } else if (exitCode === 3) {
        item.status = "paused";
        console.log(
          "BATCH REVIEW " +
            team +
            " · continuing next collected team",
        );
      } else if (item.attempts <= maxRetries) {
        item.status = "retry";
        console.log(
          "BATCH RETRY " +
            team +
            " · " +
            item.attempts +
            "/" +
            (maxRetries + 1),
        );
      } else {
        item.status = "failed";
        console.log(
          "BATCH FAILED " +
            team +
            " · continuing next collected team",
        );
      }

      saveState();
      resolve(item.status);
    });
  });
}

async function prepareQueue() {
  const pending = [];

  for (const team of teams) {
    const item = state.teams[team];

    if (!rebuild) {
      const completed = await latestCompletedRun(team);

      if (completed) {
        item.status = "completed";
        item.completedRunId = completed.id;
        item.completedAt = completed.finished_at || item.completedAt;
        item.updatedAt = new Date().toISOString();
        continue;
      }
    }

    if (item.status === "completed" && !rebuild) continue;
    if (item.status === "paused" && !retryPaused) continue;

    if (
      ["running", "retry", "failed", "collection_required"].includes(
        item.status,
      )
    ) {
      item.status = "pending";
    }

    if (item.status === "pending") pending.push(team);
  }

  saveState();
  return pending;
}

function printSummary() {
  const counts = {};

  for (const team of teams) {
    const status = state.teams[team]?.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
  }

  console.log("");
  console.log(
    "BATCH SUMMARY · " +
      Object.entries(counts)
        .sort()
        .map(([key, value]) => key + "=" + value)
        .join(" · "),
  );
  console.log("State: " + statePath);
}

function shutdown() {
  if (stopping) return;
  stopping = true;

  for (const child of activeChildren.values()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }

  saveState();
}

process.on("SIGINT", () => {
  shutdown();
  setTimeout(() => process.exit(130), 250).unref();
});

process.on("SIGTERM", () => {
  shutdown();
  setTimeout(() => process.exit(143), 250).unref();
});

if (dryRun) {
  console.log("Kpoparkive Post-Collection Batch · DRY RUN");
  console.log(
    "teams=" +
      teams.length +
      " concurrency=" +
      concurrency +
      " translateWorkersPerTeam=" +
      translateWorkers,
  );
  console.log(
    "Collection is NOT started here. Teams without complete extension capture are skipped.",
  );

  for (const team of teams) console.log("- " + team);

  process.exit(0);
}

const pending = await prepareQueue();

console.log(
  "Kpoparkive Post-Collection Batch · teams=" +
    teams.length +
    " pending=" +
    pending.length +
    " concurrency=" +
    concurrency,
);

const queue = [...pending];
const active = new Set();

while (!stopping && (queue.length > 0 || active.size > 0)) {
  while (!stopping && active.size < concurrency && queue.length > 0) {
    const team = queue.shift();

    const promise = runTeam(team).then((status) => {
      active.delete(promise);
      if (status === "retry") queue.push(team);
    });

    active.add(promise);
  }

  if (active.size > 0) {
    await Promise.race(active);
  }
}

printSummary();
shutdown();

const bad = teams.some((team) =>
  ["failed", "paused"].includes(state.teams[team]?.status),
);

process.exitCode = bad ? 3 : 0;
