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

// Slow the local browser crawler down enough to reduce repeated Cloudflare
// verification. An explicit --delay argument still overrides this default.
source = source.replace(/const DEFAULT_DELAY_MS = \d+;/, "const DEFAULT_DELAY_MS = 1500;");

const functionStart = source.indexOf("async function openWikiPage(page, url) {");
const nextFunction = source.indexOf("async function extractPageImages(page) {", functionStart);

if (functionStart < 0 || nextFunction < 0) {
  console.error("Safe worker could not locate openWikiPage() in the base worker.");
  console.error("The base worker structure changed; update the safe wrapper before running it.");
  process.exit(1);
}

const safeOpenWikiPage = `async function openWikiPage(page, url) {
  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (error) {
    if (!await challengeDetected(page)) throw error;
  }

  if (await challengeDetected(page)) {
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
          await page.bringToFront().catch(() => {});
        }
        continue;
      }

      if (!clearSince) {
        clearSince = Date.now();
        console.log("[Browser] Verification appears cleared. Waiting 5 seconds for stability...");
      }
      if (Date.now() - clearSince >= 5000) break;
    }

    console.log("[Browser] Verification cleared and stable. Cooling down before resuming...");
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await sleep(5000);
    console.log("[Browser] Resuming crawler.\\n");
  }

  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    const height = Math.min(document.documentElement.scrollHeight || document.body?.scrollHeight || 0, 80000);
    for (let y = 0; y < height; y += 1000) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 65));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(700);
  return response;
}

`;

source = source.slice(0, functionStart) + safeOpenWikiPage + source.slice(nextFunction);

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
