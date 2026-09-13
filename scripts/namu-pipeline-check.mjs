#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const files = [
  "scripts/lib/pipeline-db.mjs",
  "scripts/namu-pipeline.mjs",
  "scripts/namu-pipeline-queue.mjs",
  "scripts/namu-pipeline-start.mjs",
  "scripts/namu-batch.mjs",
  "scripts/namu-scope.mjs",
  "scripts/namu-source-worker.mjs",
  "scripts/namu-translation-worker.mjs",
  "scripts/namu-render-worker.mjs",
  "scripts/namu-publish-worker.mjs",
  "scripts/namu-integration-worker.mjs",
];

const requiredScripts = [
  "namu:pipeline",
  "namu:pipeline:start",
  "namu:batch",
  "namu:pipeline:queue",
  "namu:scope",
  "namu:source-worker",
  "namu:translate-worker",
  "namu:render-worker",
  "namu:publish-worker",
  "namu:integration-worker",
];

let failed = 0;

for (const relative of files) {
  const full = path.join(ROOT, relative);
  if (!fs.existsSync(full)) {
    console.error("MISSING " + relative);
    failed += 1;
    continue;
  }

  const result = spawnSync(process.execPath, ["--check", full], {
    cwd: ROOT,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    console.error("SYNTAX FAIL " + relative);
    console.error(result.stderr || result.stdout || "");
    failed += 1;
  } else {
    console.log("SYNTAX PASS " + relative);
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
for (const name of requiredScripts) {
  if (!pkg?.scripts?.[name]) {
    console.error("PACKAGE SCRIPT MISSING " + name);
    failed += 1;
  } else {
    console.log("PACKAGE PASS " + name);
  }
}

if (failed > 0) {
  console.error("PIPELINE CHECK FAILED · " + failed + " issue(s)");
  process.exit(1);
}

console.log("PIPELINE CHECK PASS · " + files.length + " files");
