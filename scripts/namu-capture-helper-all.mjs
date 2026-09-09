import { spawn } from "node:child_process";
import path from "node:path";

const children = [];
let shuttingDown = false;

function start(script, env = {}) {
  const child = spawn(process.execPath, [path.resolve(script)], {
    env: { ...process.env, ...env },
    stdio: ["inherit", "inherit", "inherit"],
  });
  children.push(child);
  return child;
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(signal); } catch {}
  }
}

const capture = start("scripts/namu-chrome-capture-helper-v11.mjs");
const rawAssets = start("scripts/namu-raw-asset-helper.mjs", { NAMU_RAW_ASSET_PORT: "43120" });

for (const child of [capture, rawAssets]) {
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    const normalSignal = signal === "SIGTERM" || signal === "SIGINT";
    if ((code ?? 0) !== 0 || !normalSignal) {
      console.error(`Capture helper child exited (code=${code ?? "null"}, signal=${signal || "none"}).`);
    }
    shutdown("SIGTERM");
    process.exitCode = code ?? (normalSignal ? 0 : 1);
  });
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
  setTimeout(() => process.exit(0), 100).unref();
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
  setTimeout(() => process.exit(0), 100).unref();
});

console.log("Kpoparkive capture helper bundle: main=43117, media=43118, fidelity=43119, raw-assets=43120");
