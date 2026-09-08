import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const basePath = path.resolve("scripts/namu-chrome-capture-helper-v8.mjs");
// Windows Git checkouts can materialize the v8 source with CRLF line endings.
// v9 patches source text before importing it, so normalize EOLs first instead
// of depending on the checkout's core.autocrlf setting.
const base = fs.readFileSync(basePath, "utf8").replace(/\r\n?/g, "\n");

const oldBlock = String.raw`async function kpopKnownAssetUrls(rootTitle) {
  const rows = await db(
    "namu_capture_staging?root_title=eq." + encodeURIComponent(rootTitle) +
    "&select=source_url&source_url=not.is.null&limit=10000"
  );
  return [...new Set((rows || []).map((row) => String(row?.source_url || "").trim()).filter(Boolean))];
}`;

const newBlock = String.raw`async function kpopKnownAssetUrls(rootTitle) {
  const staging = await db(
    "namu_capture_staging?root_title=eq." + encodeURIComponent(rootTitle) +
    "&select=source_url&source_url=not.is.null&limit=10000"
  );
  const resolved = await db(
    "source_asset_queue?root_title=eq." + encodeURIComponent(rootTitle) +
    "&status=eq.resolved&select=metadata&limit=10000"
  );
  const urls = [];
  for (const row of staging || []) {
    const value = String(row?.source_url || "").trim();
    if (value) urls.push(value);
  }
  for (const row of resolved || []) {
    const value = String(row?.metadata?.original_url || "").trim();
    if (value) urls.push(value);
  }
  return [...new Set(urls)];
}`;

const oldSkip = String.raw`    if (existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION) {
      kpopCloneState.processed += 1;`;

const newSkip = String.raw`    const capturedAtMs = Date.parse(existing?.source_browser_captured_at || "");
    const capturedAfterAdFilter = Number.isFinite(capturedAtMs) && capturedAtMs >= Date.parse("2026-09-08T16:30:00Z");
    if (existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION && capturedAfterAdFilter) {
      kpopCloneState.processed += 1;`;

const finalizeMarker = String.raw`function kpopFinalizeCloneIfDone() {
  if (kpopCloneState.status !== "running") return;
  if (kpopCloneState.processed >= kpopCloneState.maxDocs || (!kpopCloneState.queue.length && !kpopCloneState.leases.length)) {
    kpopCloneState.status = "done";
    kpopCloneState.finishedAt = new Date().toISOString();
  }
}`;

const finalizeReplacement = String.raw`let kpopClaimInFlight = 0;
let kpopClaimLock = Promise.resolve();

function kpopFinalizeCloneIfDone() {
  if (kpopCloneState.status !== "running") return;
  if (kpopCloneState.processed >= kpopCloneState.maxDocs || (!kpopCloneState.queue.length && !kpopCloneState.leases.length && kpopClaimInFlight === 0)) {
    kpopCloneState.status = "done";
    kpopCloneState.finishedAt = new Date().toISOString();
  }
}`;

const claimNameMarker = "async function kpopClaimCloneTask() {";
const takeLeaseMarker = "\nfunction kpopTakeLease(leaseId) {";
const claimWrapper = String.raw`
async function kpopClaimCloneTask() {
  const previous = kpopClaimLock;
  let releaseLock;
  kpopClaimLock = new Promise((resolve) => { releaseLock = resolve; });
  await previous;
  kpopClaimInFlight += 1;
  try {
    return await kpopClaimCloneTaskUnlocked();
  } finally {
    kpopClaimInFlight = Math.max(0, kpopClaimInFlight - 1);
    kpopFinalizeCloneIfDone();
    kpopSaveCloneState();
    releaseLock();
  }
}

function kpopTakeLease(leaseId) {`;

for (const [label, marker] of [
  ["known-media", oldBlock],
  ["artifact-refresh", oldSkip],
  ["clone-finalize", finalizeMarker],
  ["claim-function", claimNameMarker],
  ["claim-wrapper", takeLeaseMarker],
]) {
  if (!base.includes(marker)) throw new Error(`v8 helper changed; v9 ${label} patch no longer matches`);
}

let patched = base
  .replace(oldBlock, newBlock)
  .replace(oldSkip, newSkip)
  .replace(finalizeMarker, finalizeReplacement)
  .replace(claimNameMarker, "async function kpopClaimCloneTaskUnlocked() {")
  .replace(takeLeaseMarker, claimWrapper);

const tempPath = path.join(os.tmpdir(), `kpoparkive-namu-capture-v9-${process.pid}.mjs`);
fs.writeFileSync(tempPath, patched, "utf8");
const cleanup = () => { try { fs.unlinkSync(tempPath); } catch {} };
process.on("exit", cleanup);

try {
  await import(pathToFileURL(tempPath).href);
} catch (error) {
  cleanup();
  throw error;
}
