import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright-core";

const BUCKET = "wiki-media";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_ROOT = "RESCENE";
const DEFAULT_LIMIT = 300;
const DEFAULT_DELAY_MS = 300;

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

const ROOT_TITLE = argValue("--root", DEFAULT_ROOT).trim();
const UNIQUE_LIMIT = Math.max(1, Number(argValue("--limit", String(DEFAULT_LIMIT))) || DEFAULT_LIMIT);
const DELAY_MS = Math.max(0, Number(argValue("--delay", String(DEFAULT_DELAY_MS))) || DEFAULT_DELAY_MS);
const HEADLESS = hasArg("--headless");
const FILE_FILTER = argValue("--only", "").normalize("NFKC").toLowerCase();

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is missing. Put it in .env.local before running the worker.");
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safePart(value) {
  const ascii = String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return ascii || "asset";
}

function canonicalFileKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function displayFileName(row) {
  return String(row.label || row.source_ref || "").normalize("NFKC").trim().replace(/^(?:파일|File):/i, "");
}

function encodeWikiTitle(title) {
  return String(title).split("/").map((part) => encodeURIComponent(part)).join("/");
}

function dbHeaders(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: { ...dbHeaders(), ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchQueueRows(rootTitle) {
  const output = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const rows = await db(
      `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}` +
      `&asset_type=eq.image&status=in.(pending,unresolved)` +
      `&select=id,source_document_id,source_title,source_ref,label,status,metadata` +
      `&order=updated_at.asc.nullsfirst,id.asc&limit=1000&offset=${offset}`,
    );
    output.push(...rows);
    if (rows.length < 1000) break;
  }
  return output;
}

function findBrowserExecutable() {
  if (process.env.NAMU_BROWSER_EXECUTABLE && fs.existsSync(process.env.NAMU_BROWSER_EXECUTABLE)) {
    return process.env.NAMU_BROWSER_EXECUTABLE;
  }
  const candidates = [];
  if (process.platform === "win32") {
    for (const root of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA]) {
      if (!root) continue;
      candidates.push(
        path.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      );
    }
  } else if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else {
    for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
      const found = spawnSync("which", [name], { encoding: "utf8" }).stdout?.trim();
      if (found) candidates.push(found);
    }
  }
  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function isNavigationOrPlaceholderUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (!/^https?:$/.test(parsed.protocol)) return true;
    if ((host === "namu.moe" || host.endsWith(".namu.moe")) && /^\/(?:images|xref)(?:\/|$)/i.test(parsed.pathname)) return true;
    if ((host === "namu.wiki" || host.endsWith(".namu.wiki")) && /^\/(?:w|raw)(?:\/|$)/i.test(parsed.pathname)) return true;
    return false;
  } catch {
    return true;
  }
}

function dedupe(values) {
  return [...new Set(values.filter(Boolean))];
}

function normalizeCandidateUrl(value, baseUrl) {
  if (!value || /^(?:data|blob):/i.test(value)) return "";
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return "";
  }
}

async function challengeDetected(page) {
  try {
    return await page.evaluate(() => {
      const text = `${document.title}\n${document.body?.innerText || ""}`.slice(0, 5000).toLowerCase();
      return /just a moment|verify you are human|checking your browser|security verification|cf-chl-|turnstile|captcha/.test(text);
    });
  } catch {
    return false;
  }
}

async function openWikiPage(page, url) {
  let response;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  } catch (error) {
    if (!await challengeDetected(page)) throw error;
  }

  if (await challengeDetected(page)) {
    console.log("\n[Browser] NamuWiki verification is visible. Complete it in the opened browser window.");
    console.log("[Browser] This dedicated profile is persistent, so a successful session will be reused next time.\n");
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      await sleep(1500);
      if (!await challengeDetected(page)) break;
    }
    if (await challengeDetected(page)) throw new Error("NamuWiki browser verification was not completed within 3 minutes");
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  }

  await page.waitForTimeout(700);
  await page.evaluate(async () => {
    const height = Math.min(document.documentElement.scrollHeight || document.body?.scrollHeight || 0, 80000);
    for (let y = 0; y < height; y += 1000) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    window.scrollTo(0, 0);
  }).catch(() => {});
  await page.waitForTimeout(400);
  return response;
}

async function extractPageImages(page) {
  const raw = await page.evaluate(() => {
    const entries = [];
    const pageUrl = location.href;
    const pushEntry = (labels, urls, width = 0, height = 0) => {
      entries.push({ labels: labels.filter(Boolean), urls: urls.filter(Boolean), width, height });
    };

    for (const image of Array.from(document.images)) {
      const anchor = image.closest("a");
      const href = anchor?.getAttribute("href") || "";
      let anchorTitle = "";
      const match = href.match(/\/w\/([^?#]+)/);
      if (match) {
        try { anchorTitle = decodeURIComponent(match[1]); } catch { anchorTitle = match[1]; }
      }
      const labels = [
        image.getAttribute("alt") || "",
        image.getAttribute("title") || "",
        anchor?.getAttribute("title") || "",
        anchorTitle,
      ];
      const srcset = image.getAttribute("srcset") || "";
      const urls = [
        image.currentSrc || "",
        image.getAttribute("src") || "",
        image.getAttribute("data-src") || "",
        image.getAttribute("data-original") || "",
        ...srcset.split(",").map((part) => part.trim().split(/\s+/)[0]),
      ];
      pushEntry(labels, urls, image.naturalWidth || 0, image.naturalHeight || 0);
    }

    for (const meta of Array.from(document.querySelectorAll('meta[property="og:image"],meta[name="twitter:image"]'))) {
      pushEntry(["__page__"], [meta.getAttribute("content") || ""], 0, 0);
    }

    return { pageUrl, entries };
  });

  return raw.entries.map((entry) => ({
    labels: entry.labels,
    urls: dedupe(entry.urls.map((url) => normalizeCandidateUrl(url, raw.pageUrl)).filter((url) => url && !isNavigationOrPlaceholderUrl(url))),
    width: entry.width,
    height: entry.height,
  }));
}

function buildExactFileMap(entries) {
  const map = new Map();
  for (const entry of entries) {
    for (const label of entry.labels) {
      const key = canonicalFileKey(label);
      if (!key || key === "__page__") continue;
      const current = map.get(key) || [];
      map.set(key, dedupe([...current, ...entry.urls]));
    }
  }
  return map;
}

function fallbackPageCandidates(entries) {
  return dedupe(
    [...entries]
      .sort((a, b) => (b.width * b.height) - (a.width * a.height))
      .flatMap((entry) => entry.urls),
  );
}

function detectContentType(bytes, declared = "", url = "") {
  const header = declared.split(";", 1)[0].trim().toLowerCase();
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp" && /^(?:avif|avis)$/i.test(bytes.subarray(8, 12).toString("ascii"))) return "image/avif";
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8").replace(/^\uFEFF/, "").trimStart();
  if (/^(?:<\?xml[\s\S]{0,1000}?>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg\b/i.test(sample)) return "image/svg+xml";
  if (/^image\/(?:jpeg|png|gif|webp|avif|svg\+xml)$/.test(header)) return header;
  const ext = url.match(/\.(jpe?g|png|gif|webp|avif|svg)(?:$|[?#])/i)?.[1]?.toLowerCase();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" })[ext] || "";
}

function extensionFor(contentType) {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
  })[contentType] || "bin";
}

async function validateImageBytes(validatorPage, bytes, contentType) {
  if (!bytes.length) return { valid: false, reason: "empty response" };
  if (bytes.length > MAX_IMAGE_BYTES) return { valid: false, reason: "image exceeds 8 MB" };
  const base64 = bytes.toString("base64");
  return validatorPage.evaluate(async ({ base64, contentType }) => {
    try {
      const binary = atob(base64);
      const raw = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) raw[i] = binary.charCodeAt(i);
      const blob = new Blob([raw], { type: contentType || "application/octet-stream" });
      const objectUrl = URL.createObjectURL(blob);
      const image = new Image();
      image.src = objectUrl;
      await image.decode();
      const width = image.naturalWidth;
      const height = image.naturalHeight;
      if (width < 8 || height < 8) {
        URL.revokeObjectURL(objectUrl);
        return { valid: false, reason: `placeholder-sized image ${width}x${height}`, width, height };
      }
      const canvas = document.createElement("canvas");
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.clearRect(0, 0, 32, 32);
      ctx.drawImage(image, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;
      let visible = 0;
      let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0, minA = 255, maxA = 0;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        minA = Math.min(minA, a); maxA = Math.max(maxA, a);
        if (a <= 8) continue;
        visible += 1;
        minR = Math.min(minR, r); maxR = Math.max(maxR, r);
        minG = Math.min(minG, g); maxG = Math.max(maxG, g);
        minB = Math.min(minB, b); maxB = Math.max(maxB, b);
      }
      URL.revokeObjectURL(objectUrl);
      const visibleRatio = visible / (32 * 32);
      if (visibleRatio < 0.002) return { valid: false, reason: "nearly fully transparent image", width, height, visibleRatio };
      const colorRange = Math.max(maxR - minR, maxG - minG, maxB - minB);
      const alphaRange = maxA - minA;
      if (visibleRatio > 0.98 && colorRange <= 1 && alphaRange <= 1) {
        return { valid: false, reason: "uniform blank image", width, height, visibleRatio, colorRange, alphaRange };
      }
      return { valid: true, width, height, visibleRatio, colorRange, alphaRange };
    } catch (error) {
      return { valid: false, reason: String(error?.message || error || "browser image decode failed").slice(0, 200) };
    }
  }, { base64, contentType });
}

async function downloadThroughBrowser(downloadPage, validatorPage, url, referer) {
  if (isNavigationOrPlaceholderUrl(url)) throw new Error("candidate is a navigation/placeholder URL");
  await downloadPage.setExtraHTTPHeaders(referer ? { Referer: referer } : {});
  let response;
  try {
    response = await downloadPage.goto(url, { waitUntil: "commit", timeout: 45000 });
  } catch (error) {
    throw new Error(`browser download navigation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response) throw new Error("browser download produced no response");
  if (response.status() < 200 || response.status() >= 300) throw new Error(`browser download HTTP ${response.status()}`);
  const headers = await response.allHeaders();
  const bytes = await response.body();
  if (!bytes.length) throw new Error("empty browser response");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image exceeds 8 MB");
  const contentType = detectContentType(bytes, headers["content-type"] || "", response.url());
  if (!contentType) throw new Error(`response is not a supported image (${headers["content-type"] || "unknown MIME"})`);
  const visual = await validateImageBytes(validatorPage, bytes, contentType);
  if (!visual.valid) throw new Error(visual.reason || "browser-decoded image failed validation");
  return { bytes, contentType, visual, finalUrl: response.url() };
}

async function uploadToStorage(bytes, contentType, rootTitle, sourceTitle, fileKey, sourceUrl) {
  const hash = crypto.createHash("sha256").update(`${rootTitle}|${fileKey}|${sourceUrl}`).digest("hex").slice(0, 16);
  const ext = extensionFor(contentType);
  const storagePath = `imports/${safePart(rootTitle)}/${safePart(sourceTitle)}-${hash}.${ext}`;
  const response = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      apikey: SERVICE_ROLE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!response.ok) throw new Error(`storage upload ${response.status}: ${await response.text()}`);
  return {
    storagePath,
    publicUrl: `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`,
  };
}

async function patchResolved(rows, result, candidateUrl, sourcePageUrl, contentType, visual, byteLength) {
  const updatedAt = new Date().toISOString();
  await Promise.all(rows.map((row) => db(`source_asset_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "resolved",
      resolved_url: result.publicUrl,
      storage_path: result.storagePath,
      confidence: 0.995,
      metadata: {
        ...(row.metadata || {}),
        original_url: candidateUrl,
        browser_source_page: sourcePageUrl,
        content_type: contentType,
        bytes: byteLength,
        width: visual.width,
        height: visual.height,
        visible_ratio: visual.visibleRatio,
        color_range: visual.colorRange,
        resolved_from: "local-persistent-browser-worker",
        resolution_error: null,
      },
      updated_at: updatedAt,
    }),
  })));
}

async function patchFailure(rows, reason) {
  const updatedAt = new Date().toISOString();
  await Promise.all(rows.map((row) => db(`source_asset_queue?id=eq.${row.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      status: "unresolved",
      metadata: { ...(row.metadata || {}), browser_worker_error: reason.slice(0, 1800), resolution_error: reason.slice(0, 1800) },
      updated_at: updatedAt,
    }),
  })));
}

async function main() {
  console.log(`Kpoparkive Namu browser image worker`);
  console.log(`Root: ${ROOT_TITLE}`);
  console.log(`Mode: ${HEADLESS ? "headless" : "visible persistent browser"}`);

  const rows = await fetchQueueRows(ROOT_TITLE);
  const groups = new Map();
  for (const row of rows) {
    const key = canonicalFileKey(displayFileName(row));
    if (!key) continue;
    if (FILE_FILTER && !key.includes(FILE_FILTER)) continue;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const selected = [...groups.entries()].slice(0, UNIQUE_LIMIT);
  console.log(`Queue rows: ${rows.length}; unique files selected: ${selected.length}/${groups.size}`);
  if (!selected.length) return;

  const executablePath = findBrowserExecutable();
  if (!executablePath) {
    throw new Error("Chrome/Edge was not found. Set NAMU_BROWSER_EXECUTABLE in .env.local to your browser executable path.");
  }
  const profileDir = process.env.NAMU_BROWSER_PROFILE || path.join(os.homedir(), ".kpoparkive", "namu-browser-profile");
  fs.mkdirSync(profileDir, { recursive: true });
  console.log(`Browser: ${executablePath}`);
  console.log(`Persistent profile: ${profileDir}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath,
    headless: HEADLESS,
    viewport: null,
    locale: "ko-KR",
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const sourcePage = context.pages()[0] || await context.newPage();
  const downloadPage = await context.newPage();
  const validatorPage = await context.newPage();
  await validatorPage.goto("about:blank");
  const sourceCache = new Map();
  let resolved = 0;
  let failed = 0;

  async function sourceMapFor(title) {
    if (sourceCache.has(title)) return sourceCache.get(title);
    const url = `https://namu.wiki/w/${encodeWikiTitle(title)}`;
    console.log(`  opening source page: ${title}`);
    await openWikiPage(sourcePage, url);
    const entries = await extractPageImages(sourcePage);
    const result = { url: sourcePage.url(), map: buildExactFileMap(entries), fallback: fallbackPageCandidates(entries) };
    sourceCache.set(title, result);
    await sleep(DELAY_MS);
    return result;
  }

  try {
    for (let index = 0; index < selected.length; index += 1) {
      const [fileKey, groupRows] = selected[index];
      const fileName = displayFileName(groupRows[0]);
      const sourceTitles = dedupe(groupRows.map((row) => row.source_title).filter(Boolean));
      const errors = [];
      let success = null;
      console.log(`\n[${index + 1}/${selected.length}] ${fileName} (${groupRows.length} queue rows)`);

      for (const sourceTitle of sourceTitles.slice(0, 4)) {
        if (success) break;
        try {
          const source = await sourceMapFor(sourceTitle);
          const candidates = source.map.get(fileKey) || [];
          for (const candidate of candidates) {
            try {
              const downloaded = await downloadThroughBrowser(downloadPage, validatorPage, candidate, source.url);
              const stored = await uploadToStorage(downloaded.bytes, downloaded.contentType, ROOT_TITLE, sourceTitle, fileKey, downloaded.finalUrl);
              success = { ...downloaded, ...stored, candidateUrl: downloaded.finalUrl, sourcePageUrl: source.url, sourceTitle };
              break;
            } catch (error) {
              errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          errors.push(`source ${sourceTitle}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!success) {
        const filePageUrl = `https://namu.wiki/w/${encodeWikiTitle(`파일:${fileName}`)}`;
        try {
          console.log(`  opening file page fallback`);
          await openWikiPage(sourcePage, filePageUrl);
          const entries = await extractPageImages(sourcePage);
          const exactMap = buildExactFileMap(entries);
          const candidates = dedupe([...(exactMap.get(fileKey) || []), ...fallbackPageCandidates(entries)]).slice(0, 12);
          for (const candidate of candidates) {
            try {
              const downloaded = await downloadThroughBrowser(downloadPage, validatorPage, candidate, sourcePage.url());
              const stored = await uploadToStorage(downloaded.bytes, downloaded.contentType, ROOT_TITLE, groupRows[0].source_title, fileKey, downloaded.finalUrl);
              success = { ...downloaded, ...stored, candidateUrl: downloaded.finalUrl, sourcePageUrl: sourcePage.url(), sourceTitle: groupRows[0].source_title };
              break;
            } catch (error) {
              errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } catch (error) {
          errors.push(`file page: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (success) {
        await patchResolved(groupRows, success, success.candidateUrl, success.sourcePageUrl, success.contentType, success.visual, success.bytes.length);
        resolved += 1;
        console.log(`  RESOLVED ${success.visual.width}x${success.visual.height}, ${(success.bytes.length / 1024).toFixed(1)} KB -> ${success.storagePath}`);
      } else {
        const reason = errors.slice(-8).join(" | ") || "No browser image candidate found";
        await patchFailure(groupRows, reason);
        failed += 1;
        console.log(`  UNRESOLVED ${reason.slice(0, 360)}`);
      }

      await sleep(DELAY_MS);
    }
  } finally {
    console.log(`\nFinished. unique files resolved=${resolved}, unresolved=${failed}`);
    console.log("The browser profile is intentionally kept for the next run.");
    await context.close();
  }
}

main().catch((error) => {
  console.error(`\nWorker failed: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
