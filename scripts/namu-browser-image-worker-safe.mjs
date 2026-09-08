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

// Keep the local browser path deliberately slow. A caller can still override
// this with --delay when diagnosing a small batch.
source = source.replace(/const DEFAULT_DELAY_MS = \d+;/, "const DEFAULT_DELAY_MS = 1500;");

// The original detector only looked at a small slice of top-level body text.
// NamuWiki can present verification later, inside an iframe, or as a visual
// modal. Replace the detector + navigation function as one unit so every wiki
// navigation observes a global verification lock.
const challengeStart = source.indexOf("async function challengeDetected(page) {");
const extractStart = source.indexOf("async function extractPageImages(page) {", challengeStart);

if (challengeStart < 0 || extractStart < 0) {
  console.error("Safe worker could not locate the challenge/navigation functions in the base worker.");
  console.error("The base worker structure changed; update the safe wrapper before running it.");
  process.exit(1);
}

const verificationRuntime = `let ACTIVE_CONTEXT = null;

async function challengeDetected(page) {
  if (!page || page.isClosed()) return false;
  try {
    const url = page.url().toLowerCase();
    if (/captcha|challenge|turnstile|hcaptcha|arkose|verify|verification|cf-chl/.test(url)) return true;

    const topLevel = await page.evaluate(() => {
      const isVisible = (element) => {
        if (!(element instanceof HTMLElement)) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity || "1") > 0 && rect.width > 20 && rect.height > 20;
      };

      const bodyText = \`\${document.title}\\n\${document.body?.innerText || ""}\`.slice(0, 30000).toLowerCase();
      if (/just a moment|verify you are human|checking your browser|security verification|human verification|사람(?:인지|임을)?.{0,30}(?:확인|인증)|로봇이 아닙니다|표시된 항목보다.{0,120}클릭하세요/.test(bodyText)) return true;

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
        '[class*="challenge" i]',
        '[id*="challenge" i]',
        '[data-sitekey]',
        'input[name*="cf-turnstile" i]',
      ];
      for (const selector of suspiciousSelectors) {
        for (const element of document.querySelectorAll(selector)) {
          if (isVisible(element)) return true;
        }
      }

      // The visual puzzle shown by NamuWiki is not always labelled "captcha".
      // Detect a visible modal/dialog containing the skip control and a grid of
      // image choices instead of relying on provider-specific class names.
      const modalCandidates = document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="popup" i], [class*="overlay" i]');
      for (const modal of modalCandidates) {
        if (!isVisible(modal)) continue;
        const text = (modal.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
        const imageChoices = modal.querySelectorAll('img, button img, [role="button"] img').length;
        if ((text.includes("건너뛰기") || text.includes("click") || text.includes("클릭하세요")) && imageChoices >= 4) return true;
      }
      return false;
    });
    if (topLevel) return true;

    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const frameUrl = frame.url().toLowerCase();
      if (/captcha|challenge|turnstile|hcaptcha|arkose|verify|verification|cf-chl/.test(frameUrl)) return true;
      try {
        const frameSignal = await frame.evaluate(() => {
          const text = (document.body?.innerText || "").slice(0, 12000).toLowerCase();
          return /verify you are human|human verification|checking your browser|captcha|turnstile|사람(?:인지|임을)?.{0,30}(?:확인|인증)|로봇이 아닙니다|표시된 항목보다.{0,120}클릭하세요|건너뛰기/.test(text);
        });
        if (frameSignal) return true;
      } catch {}
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

async function waitForGlobalVerificationClear(context, preferredPage = null, graceMs = 2500) {
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
        console.log("[Browser] Complete the verification in the browser. There is no timeout.");
        console.log("[Browser] No source page or image URL will be opened until it is cleared.\\n");
        announced = true;
      }
      if (Date.now() - lastNotice >= 15000) {
        console.log("[Browser] Waiting for verification... crawler remains fully paused.");
        lastNotice = Date.now();
      }
      await challengePage.bringToFront().catch(() => {});
      await sleep(800);
      continue;
    }

    if (sawChallenge) {
      if (!clearSince) {
        clearSince = Date.now();
        console.log("[Browser] Verification disappeared. Holding for 7 seconds to ensure it stays cleared...");
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
    if (preferredPage && !preferredPage.isClosed()) await preferredPage.bringToFront().catch(() => {});
    await sleep(350);
  }
}

async function openWikiPage(page, url) {
  const context = ACTIVE_CONTEXT || page.context();
  await waitForGlobalVerificationClear(context, page, 600);

  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (error) {
    // A verification page can interrupt navigation. Let the global lock inspect
    // every tab/frame before deciding this was an actual navigation failure.
    await waitForGlobalVerificationClear(context, page, 2500);
    if (!response && !/^https:\\/\\/(?:www\\.)?namu\\.wiki\\//i.test(page.url())) throw error;
  }

  // Verification can be injected shortly after DOMContentLoaded, so observe the
  // whole browser for several seconds before touching the page.
  await waitForGlobalVerificationClear(context, page, 3500);

  await page.waitForTimeout(1000);
  await page.evaluate(async () => {
    const height = Math.min(document.documentElement.scrollHeight || document.body?.scrollHeight || 0, 80000);
    for (let y = 0; y < height; y += 1000) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 65));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});

  // Scrolling/lazy loading can itself trigger the visual challenge.
  await waitForGlobalVerificationClear(context, page, 2200);
  await page.waitForTimeout(700);
  return response;
}

`;

source = source.slice(0, challengeStart) + verificationRuntime + source.slice(extractStart);

// Make the launched persistent browser globally visible to both wiki navigation
// and image-download navigation.
const contextPattern = /(const context = await chromium\.launchPersistentContext\([\s\S]*?\n  \}\);)/;
if (!contextPattern.test(source)) {
  console.error("Safe worker could not locate the persistent browser context.");
  process.exit(1);
}
source = source.replace(contextPattern, `$1\n  ACTIVE_CONTEXT = context;`);

// Never let an image navigation proceed while any tab is showing verification.
source = source.replace(
  "async function downloadThroughBrowser(downloadPage, validatorPage, url, referer) {",
  `async function downloadThroughBrowser(downloadPage, validatorPage, url, referer) {\n  if (ACTIVE_CONTEXT) await waitForGlobalVerificationClear(ACTIVE_CONTEXT, downloadPage, 900);`,
);
source = source.replace(
  "  if (!response) throw new Error(\"browser download produced no response\");",
  `  if (ACTIVE_CONTEXT) await waitForGlobalVerificationClear(ACTIVE_CONTEXT, downloadPage, 1800);\n  if (!response) throw new Error("browser download produced no response");`,
);

// Add one final global gate at the beginning of each unique-file iteration. This
// catches a challenge that appeared during the inter-item delay.
source = source.replace(
  "    for (let index = 0; index < selected.length; index += 1) {",
  `    for (let index = 0; index < selected.length; index += 1) {\n      if (ACTIVE_CONTEXT) await waitForGlobalVerificationClear(ACTIVE_CONTEXT, sourcePage, 700);`,
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
