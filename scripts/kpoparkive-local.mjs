import { spawn } from "node:child_process";

const children = [];
let stopping = false;

function startNpm(args, label) {
  const isWindows = process.platform === "win32";
  const command = isWindows ? (process.env.ComSpec || "cmd.exe") : "npm";
  const commandArgs = isWindows
    ? ["/d", "/s", "/c", ["npm.cmd", ...args].join(" ")]
    : args;

  const child = spawn(command, commandArgs, {
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  children.push(child);

  child.on("error", (error) => {
    if (stopping) return;
    console.error(`${label} failed to start: ${error instanceof Error ? error.message : String(error)}`);
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (stopping) return;
    const normal = signal === "SIGINT" || signal === "SIGTERM";
    if (!normal && (code ?? 0) !== 0) {
      console.error(`${label} exited with code=${code ?? "null"} signal=${signal || "none"}`);
      shutdown(code ?? 1);
      return;
    }
    shutdown(0);
  });
}

function shutdown(exitCode = 0) {
  if (stopping) return;
  stopping = true;

  for (const child of children) {
    try {
      if (process.platform === "win32" && child.pid) {
        spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `taskkill /pid ${child.pid} /t /f >nul 2>&1`], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
  }

  setTimeout(() => process.exit(exitCode), 250).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log("Kpoparkive local workspace");
console.log("- Home: http://localhost:3000");
console.log("- Manual Namu collection: existing Chrome extension + local capture helper");
console.log("- Post-collection GUI: http://localhost:3000/admin/pipeline");
console.log("- Import/debug page: http://localhost:3000/admin/namu-import");
console.log("- Ctrl+C stops Next.js + capture helper. Detached pipeline runs are controlled from the GUI.");

startNpm(["run", "dev"], "Next.js dev");
startNpm(["run", "namu:capture-helper"], "Namu capture helper");
