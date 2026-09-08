import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const sourcePath = path.join(scriptDir, "namu-browser-image-worker.mjs");
const cacheDir = path.join(projectRoot, "node_modules", ".cache", "kpoparkive");
const runtimePath = path.join(cacheDir, `namu-browser-image-worker-${process.pid}.mjs`);

if (!fs.existsSync(sourcePath)) {
  console.error(`Base worker not found: ${sourcePath}`);
  process.exit(1);
}

let source = fs.readFileSync(sourcePath, "utf8");

// The browser worker was originally tuned like a server-side fetch loop. That is
// too aggressive for NamuWiki: it repeatedly trips verification. Use a slower
// default for the local persistent-browser path. --delay still overrides this.
source = source.replace(
  "const DEFAULT_DELAY_MS = 300;",
  "const DEFAULT_DELAY_MS = 1500;",
);

const oldVerificationBlock = `  if (await challengeDetected(page)) {
    console.log("\\n[Browser] NamuWiki verification is visible. Complete it in the opened browser window.");
    console.log("[Browser] This dedicated profile is persistent, so a successful session will be reused next time.\\n");
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (!await challengeDetected(page)) break;
    }
    if (await challengeDetected(page)) throw new Error("NamuWiki browser verification was not completed within 3 minutes");
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  }`;

const safeVerificationBlock = `  if (await challengeDetected(page)) {
    console.log("\\n[Browser] NamuWiki verification detected. The crawler is PAUSED.");
    console.log("[Browser] Complete the verification in the NamuWiki tab. There is no timeout.");
    console.log("[Browser] No next wiki page will be opened until verification is stably cleared.\\n");
    await page.bringToFront().catch(() => {});

    let clearSince = 0;
    let lastNotice = Date.now();
    while (true) {
      await sleep(1000);
      const challenged = await challengeDetected(page);
      const currentUrl = page.url();
      const onWiki = /^https:\\/\\/(?:www\\.)?namu\\.wiki\\/w\\//i.test(currentUrl);

      if (challenged || !onWiki) {
        clearSince = 0;
        if (Date.now() - lastNotice >= 30000) {
          console.log("[Browser] Still waiting for verification... crawler remains paused.");
          lastNotice = Date.now();
        }
        continue;
      }

      if (!clearSince) clearSince = Date.now();
      if (Date.now() - clearSince >= 5000) break;
    }

    console.log("[Browser] Verification cleared and stable. Cooling down before resuming...");
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await sleep(5000);
    console.log("[Browser] Resuming crawler.\\n");
  }`;

if (!source.includes(oldVerificationBlock)) {
  console.error("Safe worker could not find the expected verification block in the base worker.");
  console.error("The base worker changed; update the safe wrapper before running it.");
  process.exit(1);
}

source = source.replace(oldVerificationBlock, safeVerificationBlock);

fs.mkdirSync(cacheDir, { recursive: true });
fs.writeFileSync(runtimePath, source, "utf8");

try {
  const result = spawnSync(process.execPath, [runtimePath, ...process.argv.slice(2)], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  try { fs.unlinkSync(runtimePath); } catch {}
}
