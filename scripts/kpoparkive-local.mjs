import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [];
let stopping = false;

function start(args, label) {
  const child = spawn(npm, args, {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  children.push(child);

  child.on("exit", (code, signal) => {
    if (stopping) return;
    const normal = signal === "SIGINT" || signal === "SIGTERM";
    if (!normal && (code ?? 0) !== 0) {
      console.error(`${label} exited with code=${code ?? "null"} signal=${signal || "none"}`);
    }
    shutdown();
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => process.exit(0), 150).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Kpoparkive local workspace");
console.log("- Next.js: http://localhost:3000");
console.log("- Namu capture + draft renderer: starting");
console.log("- Ctrl+C stops everything");

start(["run", "dev"], "Next.js dev");
start(["run", "namu:capture-helper"], "Namu capture helper");
