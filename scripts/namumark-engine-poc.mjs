import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const ENGINE_REPO = "https://github.com/jhk1090/namumark-clone-core.git";
const ENGINE_COMMIT = "94d0ddfbf35e5791096b3c86ebd9c869471abb13";
const ENGINE_NAME = "namumark-clone-core-poc";
const CACHE_DIR = path.resolve(".cache", "namumark-clone-core");

function run(command, args, cwd = process.cwd()) {
  const executable = process.platform === "win32" && ["npm", "npx"].includes(command) ? `${command}.cmd` : command;
  const result = spawnSync(executable, args, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} ${args.join(" ")} failed with exit code ${result.status}`);
}

function ensureEngine() {
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (!fs.existsSync(path.join(CACHE_DIR, ".git"))) run("git", ["clone", "--no-checkout", ENGINE_REPO, CACHE_DIR]);
  run("git", ["fetch", "--depth", "1", "origin", ENGINE_COMMIT], CACHE_DIR);
  run("git", ["checkout", "--detach", "--force", ENGINE_COMMIT], CACHE_DIR);
  if (!fs.existsSync(path.join(CACHE_DIR, "node_modules"))) run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], CACHE_DIR);
  run("npx", ["tsc", "--pretty", "false"], CACHE_DIR);
  const indexPath = path.join(CACHE_DIR, "out", "index.js");
  if (!fs.existsSync(indexPath)) throw new Error(`Engine build did not create ${indexPath}`);
  return indexPath;
}

const engineIndex = ensureEngine();
const require = createRequire(import.meta.url);
const { NamuMark } = require(engineIndex);
if (typeof NamuMark !== "function") throw new Error("Compiled engine does not export NamuMark");

console.log(`${ENGINE_NAME} ready at ${ENGINE_COMMIT.slice(0, 12)}`);
console.log("Next step: wire captured Supabase source_wikitext into this adapter and persist comparison HTML.");
