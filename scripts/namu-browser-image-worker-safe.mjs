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

// Keep the local browser path deliberately slow. An explicit --delay still wins.
source = source.replace(/const DEFAULT_DELAY_MS = \d+;/, "const DEFAULT_DELAY_MS = 2200;");

const challengeStart = source.indexOf("async function challengeDetected(page) {");
const extractStart = source.indexOf("async function extractPageImages(page) {", challengeStart);

if (challengeStart < 0 || extractStart < 0) {
  console.error("Safe worker could not locate the challenge/navigation functions in the base worker.");
  process.exit(1);
}

const verificationRuntime = `let ACTIVE_CONTEXT = null;

async function visibleFrame(frame) {
  try {
    const handle = await frame.frameElement();
    const visible = await handle.evaluate((element) => {
      if (!(element instanceof HTMLElement)) return false;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none"
        && style.visibility !== "hidden"
        && Number(style.opacity || "1") > 0
        && rect.width > 40
        && rect.height > 40;
    });
    await handle.dispose().catch(() => {});
    return visible;
  } catch {
    return false;
  }
}

async function challengeDetected(page) {
  if (!page || page.isClosed()) return false;
  try {
    const url = page.url().toLowerCase();
    if (/captcha|challenge|turnstile|hcaptcha|arkose|cf-chl/.test(url)) return true;

    const topLevel = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number(style.opacity || "1") > 0
          && rect.width > 30
          && rect.height > 30;
      };

      const bodyText = \`\${document.title}\\n\${document.body?.innerText || ""}\`.slice(0, 40000).toLowerCase();
      if (/just a moment|verify you are human|checking your browser|human verification|로봇이 아닙니다|사람(?:인지|임을)?.{0,30}(?:확인|인증)|표시된 항목보다.{0,180}클릭하세요/.test(bodyText)) return true;

      const suspiciousSelectors = [
        'iframe[src*="captcha" i]',
        'iframe[src*="challenge" i]',
        'iframe[src*="turnstile" i]',
        'iframe[src*="hcaptcha" i]',
        'iframe[src*="arkose" i]',
        '[class*="captcha" i]',
        '[id*="captcha" i]',
        '[class*="turnstile" i]',
        '[id*="turnstile" i]',
        '[data-sitekey]',
      ];
      for (const selector of suspiciousSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (isVisible(element)) return true;
        }
      }

      const modalCandidates = document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="overlay" i]');
      for (const modal of modalCandidates) {
        if (!isVisible(modal)) continue;
        const text = (modal.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const imageChoices = modal.querySelectorAll('img, button img, [role="button"] img').length;
        if ((text.includes("건너뛰기") || text.includes("클릭하세요") || text.includes("click")) && imageChoices >= 4) return true;
      }
      return false;
    });
    if (topLevel) return true;

    // NamuWiki sometimes leaves a completed/hidden verification iframe mounted.
    // A frame URL alone is therefore NOT a challenge signal. Only inspect frames
    // whose iframe element is actually visible on screen.
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      if (!await visibleFrame(frame)) continue;
      const frameUrl = frame.url().toLowerCase();
      try {
        const frameSignal = await frame.evaluate(() => {
          const text = (document.body?.innerText || "").slice(0, 20000).toLowerCase();
          const images = document.querySelectorAll('img').length;
          return /verify you are human|human verification|checking your browser|captcha|turnstile|로봇이 아닙니다|사람(?:인지|임을)?.{0,30}(?:확인|인증)|표시된 항목보다.{0,180}클릭하세요|건너뛰기/.test(text)
            || ((/captcha|challenge|turnstile|hcaptcha|arkose|cf-chl/.test(location.href.toLowerCase())) && images >= 4);
        });
        if (frameSignal) return true;
      } catch {
        if (/captcha|challenge|turnstile|hcaptcha|arkose|cf-chl/.test(frameUrl)) return true;
      }
    }
  } catch {}
  return false;
}

async function findChallengePage(context) {
  if (!context) return null;
  const pages = context.pages();
  for (let index = pages.length - 1; index >= 0; index -= 1) {
    const candidate = pages[index];
    if (await challengeDetected(candidate)) return candidate;
  }
  return null;
}

async function waitForGlobalVerificationClear(context, preferredPage = null, graceMs = 1200) {
  if (!context) return;
  const startedAt = Date.now();
  let sawChallenge = false;
  let clearSince = 0;
  let announced = false;
  let lastNotice = 0;

  while (true) {
    const challengePage = await findChallengePage(context);
    if (challengePage) {
      sawChallenge = true;
      clearSince = 0;
      if (!announced) {
        console.log("\\n[Browser] HUMAN VERIFICATION DETECTED. ALL CRAWLING IS PAUSED.");
        console.log("[Browser] Finish the visual verification. There is no timeout.");
        console.log("[Browser] The worker will not open another page until it is cleared.\\n");
        announced = true;
      }
      if (Date.now() - lastNotice >= 15000) {
        console.log("[Browser] Waiting for verification... crawler remains paused.");
        lastNotice = Date.now();
      }
      await challengePage.bringToFront().catch(() => {});
      await sleep(800);
      continue;
    }

    if (sawChallenge) {
      if (!clearSince) {
        clearSince = Date.now();
        console.log("[Browser] Verification disappeared. Holding for 7 seconds...");
      }
      if (Date.now() - clearSince >= 7000) {
        console.log("[Browser] Verification is stably cleared. Cooling down for 5 seconds...");
        await sleep(5000);
        if (await findChallengePage(context)) {
          clearSince = 0;
          continue;
        }
        console.log("[Browser] Resuming crawler.\\n");
        return;
      }
      await sleep(500);
      continue;
    }

    if (Date.now() - startedAt >= graceMs) return;
    await sleep(300);
  }
}

async function openWikiPage(page, url) {
  const context = ACTIVE_CONTEXT || page.context();
  await waitForGlobalVerificationClear(context, page, 700);

  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  } catch (error) {
    await waitForGlobalVerificationClear(context, page, 3000);
    if (!/^https:\\/\\/(?:www\\.)?namu\\.wiki\\//i.test(page.url())) throw error;
  }

  // Visual verification may be injected after the article is already visible.
  await waitForGlobalVerificationClear(context, page, 5000);

  // Do not auto-scroll the whole document here. The importer reads src,
  // currentSrc, data-src and data-original directly from the DOM, so a long
  // scripted scroll only adds requests and frequently trips verification.
  await page.waitForTimeout(700);
  return response;
}

`;

source = source.slice(0, challengeStart) + verificationRuntime + source.slice(extractStart);

const contextPattern = /(const context = await chromium\.launchPersistentContext\([\s\S]*?\n  \}\);)/;
if (!contextPattern.test(source)) {
  console.error("Safe worker could not locate the persistent browser context.");
  process.exit(1);
}
source = source.replace(contextPattern, `$1\n  ACTIVE_CONTEXT = context;`);

source = source.replace(
  "async function downloadThroughBrowser(downloadPage, validatorPage, url, referer) {",
  `async function downloadThroughBrowser(downloadPage, validatorPage, url, referer) {\n  if (ACTIVE_CONTEXT) await waitForGlobalVerificationClear(ACTIVE_CONTEXT, downloadPage, 1000);`,
);
source = source.replace(
  "  if (!response) throw new Error(\"browser download produced no response\");",
  `  if (ACTIVE_CONTEXT) await waitForGlobalVerificationClear(ACTIVE_CONTEXT, downloadPage, 2200);\n  if (!response) throw new Error("browser download produced no response");`,
);

source = source.replace(
  "    for (let index = 0; index < selected.length; index += 1) {",
  `    for (let index = 0; index < selected.length; index += 1) {\n      if (ACTIVE_CONTEXT) await waitForGlobalVerificationClear(ACTIVE_CONTEXT, sourcePage, 900);`,
);

// Make each expensive phase visible in the console. If a future page stalls we
// can tell whether it is navigation, DOM extraction, candidate download or upload.
source = source.replace(
  "    await openWikiPage(sourcePage, url);\n    const entries = await extractPageImages(sourcePage);",
  `    await openWikiPage(sourcePage, url);\n    console.log(\`  source page ready: \${title}\`);\n    const entries = await extractPageImages(sourcePage);\n    console.log(\`  DOM image entries: \${entries.length}\`);`,
);
source = source.replace(
  "          const candidates = source.map.get(fileKey) || [];",
  `          const candidates = source.map.get(fileKey) || [];\n          console.log(\`  exact candidates on source page: \${candidates.length}\`);`,
);

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
