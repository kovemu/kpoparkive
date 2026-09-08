import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const v10Path = path.resolve("scripts/namu-chrome-capture-helper-v10.mjs");
let source = fs.readFileSync(v10Path, "utf8").replace(/\r\n?/g, "\n");

const combinedMarker = 'const tempCombined = path.join(os.tmpdir(), `kpoparkive-namu-combined-v10-${process.pid}.mjs`);';
const v8Marker = 'const tempV8 = path.join(os.tmpdir(), `kpoparkive-namu-v8-global-v10-${process.pid}.mjs`);';
if (!source.includes(combinedMarker) || !source.includes(v8Marker)) throw new Error("v10 helper changed; v11 patch markers missing");

const dbRetryPatch = String.raw`
const oldDbWithNoRetry = String.raw\`async function db(pathname, init = {}) {
  const response = await fetch(\`${SUPABASE_URL}/rest/v1/\${pathname}\`, {
    ...init,
    headers: { ...dbHeaders(), ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(\`Supabase \${response.status}: \${await response.text()}\`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}\`;
const newDbWithRetry = String.raw\`async function db(pathname, init = {}) {
  const retryable = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
  let lastError = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const response = await fetch(\`${SUPABASE_URL}/rest/v1/\${pathname}\`, {
        ...init,
        headers: { ...dbHeaders(), ...(init.headers || {}) },
      });
      const text = await response.text();
      if (response.ok) return text ? JSON.parse(text) : null;
      const error = new Error(\`Supabase \${response.status}: \${text}\`);
      if (!retryable.has(response.status) || attempt === 4) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
      if (attempt === 4) throw error;
    }
    const delay = [350, 800, 1600, 3200, 5000][attempt] + Math.floor(Math.random() * 250);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw lastError || new Error("Supabase request failed after retries");
}\`;
combined = mustReplace(combined, oldDbWithNoRetry, newDbWithRetry, "Supabase 5xx retry/backoff");

`;

const mediaRetryPatch = String.raw`
const oldCompleteTask = String.raw\`async function kpopCompleteCloneTask(payload) {
  if (kpopCloneState.status !== "running") return kpopPublicCloneState();
  const lease = kpopTakeLease(String(payload?.leaseId || ""));
  const sourceTitle = String(payload?.sourceTitle || kpopTitleFromUrl(lease.url)).normalize("NFKC").trim();
  kpopCloneState.processed += 1;
  kpopCloneState.captured += 1;
  kpopCloneState.completedUrls.push(lease.url);
  if (sourceTitle) kpopCloneState.completedTitles.push(sourceTitle);
  kpopCloneState.lastMedia = payload?.media && typeof payload.media === "object" ? payload.media : null;
  if (lease.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(payload?.internalLinks || [], lease.depth + 1);
  kpopFinalizeCloneIfDone();
  kpopSaveCloneState();
  return kpopPublicCloneState();
}\`;
const newCompleteTask = String.raw\`async function kpopCompleteCloneTask(payload) {
  if (kpopCloneState.status !== "running") return kpopPublicCloneState();
  const lease = kpopTakeLease(String(payload?.leaseId || ""));
  const sourceTitle = String(payload?.sourceTitle || kpopTitleFromUrl(lease.url)).normalize("NFKC").trim();
  const media = payload?.media && typeof payload.media === "object" ? payload.media : null;
  const mediaFailed = Math.max(0, Number(media?.failed || 0) || 0);
  kpopCloneState.lastMedia = media;

  if (mediaFailed > 0 && lease.attempts < KPOP_CLONE_MAX_RETRIES) {
    kpopCloneState.queue.unshift({ url: lease.url, depth: lease.depth, attempts: lease.attempts });
    kpopCloneState.errors = [...kpopCloneState.errors, lease.url + ": retrying " + mediaFailed + " failed media assets"].slice(-20);
    kpopSaveCloneState();
    return kpopPublicCloneState();
  }

  kpopCloneState.processed += 1;
  kpopCloneState.captured += 1;
  if (mediaFailed > 0) {
    kpopCloneState.failed += 1;
    kpopCloneState.errors = [...kpopCloneState.errors, lease.url + ": " + mediaFailed + " media assets still failed after retries"].slice(-20);
  }
  kpopCloneState.completedUrls.push(lease.url);
  if (sourceTitle) kpopCloneState.completedTitles.push(sourceTitle);
  if (lease.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(payload?.internalLinks || [], lease.depth + 1);
  kpopFinalizeCloneIfDone();
  kpopSaveCloneState();
  return kpopPublicCloneState();
}\`;
v8 = mustReplace(v8, oldCompleteTask, newCompleteTask, "retry incomplete media before reuse");

`;

source = source
  .replace(combinedMarker, dbRetryPatch + combinedMarker)
  .replace(v8Marker, mediaRetryPatch + v8Marker)
  .replaceAll("kpoparkive-namu-chrome-capture-helper-v10", "kpoparkive-namu-chrome-capture-helper-v11")
  .replaceAll("helper v10 (global Namu document registry)", "helper v11 (global registry + resilient media retries)");

const tempPath = path.join(os.tmpdir(), `kpoparkive-namu-capture-v11-${process.pid}.mjs`);
fs.writeFileSync(tempPath, source, "utf8");
const cleanup = () => { try { fs.unlinkSync(tempPath); } catch {} };
process.on("exit", cleanup);

try {
  await import(pathToFileURL(tempPath).href);
} catch (error) {
  cleanup();
  throw error;
}
