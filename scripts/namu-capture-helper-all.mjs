import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";

const children = [];
let shuttingDown = false;

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (used) => {
      socket.removeAllListeners();
      try { socket.destroy(); } catch {}
      resolve(used);
    };
    socket.setTimeout(450);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

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

const occupied = [];
for (const port of [43117, 43120]) if (await portInUse(port)) occupied.push(port);
if (occupied.length) {
  console.error(`Kpoparkive helper cannot start because port(s) ${occupied.join(", ")} are already in use.`);
  console.error("An older capture-helper process is still running. Stop that old terminal with Ctrl+C, then run npm.cmd run namu:capture-helper again.");
  process.exit(1);
}

const capture = start("scripts/namu-chrome-capture-helper-v11.mjs");
const rawAssets = start("scripts/namu-raw-asset-helper-v2.mjs", { NAMU_RAW_ASSET_PORT: "43120" });
const assistantPublish = start("scripts/namu-assistant-publish-worker.mjs");

for (const child of [capture, rawAssets, assistantPublish]) {
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

console.log("Kpoparkive capture helper bundle: main=43117, media=43118, fidelity=43119, raw-assets=43120, assistant-publish=watcher");
