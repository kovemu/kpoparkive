import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const v10Path = path.resolve("scripts/namu-chrome-capture-helper-v10.mjs");
let source = fs.readFileSync(v10Path, "utf8").replace(/\r\n?/g, "\n");

const combinedMarker = 'const tempCombined = path.join(os.tmpdir(), `kpoparkive-namu-combined-v10-${process.pid}.mjs`);';
const v8Marker = 'const tempV8 = path.join(os.tmpdir(), `kpoparkive-namu-v8-global-v10-${process.pid}.mjs`);';
if (!source.includes(combinedMarker) || !source.includes(v8Marker)) {
  throw new Error("v10 helper changed; v11 patch markers missing");
}

// Old persisted state files predate crawlPolicyVersion. Keep their default at 0
// so the v1 queue migration actually discards stale country/date/etc. work.
source = source.replace(
  "policyVersion: KPOP_CRAWL_POLICY_VERSION, policyRefresh: false,",
  "policyVersion: 0, policyRefresh: false,",
);

// This remains the final compatibility wrapper for the legacy v10/v8 helper chain.
// Transient Supabase failures must pause/retry instead of consuming clone attempts.
const dbRetryPatch = [
  'const oldDbWithNoRetry = [',
  '  "async function db(pathname, init = {}) {",',
  '  "  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {",',
  '  "    ...init,",',
  '  "    headers: { ...dbHeaders(), ...(init.headers || {}) },",',
  '  "  });",',
  '  "  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);",',
  '  "  const text = await response.text();",',
  '  "  return text ? JSON.parse(text) : null;",',
  '  "}",',
  '].join("\\n");',
  'const newDbWithRetry = [',
  '  "async function db(pathname, init = {}) {",',
  '  "  const delays = [1200, 2500, 5000, 10000, 20000, 30000, 30000];",',
  '  "  let lastError = null;",',
  '  "  for (let attempt = 0; attempt < delays.length; attempt += 1) {",',
  '  "    try {",',
  '  "      const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {",',
  '  "        ...init,",',
  '  "        headers: { ...dbHeaders(), ...(init.headers || {}) },",',
  '  "      });",',
  '  "      const text = await response.text();",',
  '  "      if (response.ok) return text ? JSON.parse(text) : null;",',
  '  "      const transientBody = /(?:57014|statement timeout|canceling statement|DatabaseTimeout|Bad Gateway|Gateway Time-out|Web server is down|SSL handshake failed)/i.test(text);",',
  '  "      const retryable = response.status >= 502 || response.status === 500 && transientBody || response.status === 408 || response.status === 429;",',
  '  "      const error = new Error(`Supabase ${response.status}: ${text}`);",',
  '  "      error.kpopRetryable = retryable;",',
  '  "      lastError = error;",',
  '  "      if (!retryable || attempt === delays.length - 1) throw error;",',
  '  "    } catch (error) {",',
  '  "      lastError = error;",',
  '  "      if (error?.kpopRetryable === false) throw error;",',
  '  "      const message = String(error?.message || error || \\\"\\\");",',
  '  "      const networkish = error?.kpopRetryable === true || /(?:fetch failed|Failed to fetch|ECONN|ETIMEDOUT|ECONNRESET|network|socket|TLS|SSL)/i.test(message);",',
  '  "      if (!networkish || attempt === delays.length - 1) throw error;",',
  '  "    }",',
  '  "    const delay = delays[attempt] + Math.floor(Math.random() * 400);",',
  '  "    console.warn(`SUPABASE TRANSIENT OUTAGE: retry ${attempt + 1}/${delays.length - 1} in ${Math.round(delay / 1000)}s`);",',
  '  "    await new Promise((resolve) => setTimeout(resolve, delay));",',
  '  "  }",',
  '  "  throw lastError || new Error(\\"Supabase request failed after retries\\");",',
  '  "}",',
  '].join("\\n");',
  'combined = mustReplace(combined, oldDbWithNoRetry, newDbWithRetry, "Supabase transient outage retry/backoff");',
  'combined = mustReplace(combined, "const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;", "const MAX_DOCUMENT_BYTES = 128 * 1024 * 1024;", "large browser-artifact payload limit");',
  '',
].join("\n");

const mediaRetryPatch = [
  'v8 = mustReplace(v8, "const KPOP_CLONE_MAX_RETRIES = 2;", "const KPOP_CLONE_MAX_RETRIES = 6;", "clone retry budget");',
  'const oldCompleteTask = [',
  '  "async function kpopCompleteCloneTask(payload) {",',
  '  "  if (kpopCloneState.status !== \\\"running\\\") return kpopPublicCloneState();",',
  '  "  const lease = kpopTakeLease(String(payload?.leaseId || \\\"\\\"));",',
  '  "  const sourceTitle = String(payload?.sourceTitle || kpopTitleFromUrl(lease.url)).normalize(\\\"NFKC\\\").trim();",',
  '  "  kpopCloneState.processed += 1;",',
  '  "  kpopCloneState.captured += 1;",',
  '  "  kpopCloneState.completedUrls.push(lease.url);",',
  '  "  if (sourceTitle) kpopCloneState.completedTitles.push(sourceTitle);",',
  '  "  kpopCloneState.lastMedia = payload?.media && typeof payload.media === \\\"object\\\" ? payload.media : null;",',
  '  "  if (lease.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(payload?.internalLinks || [], lease.depth + 1);",',
  '  "  kpopFinalizeCloneIfDone();",',
  '  "  kpopSaveCloneState();",',
  '  "  return kpopPublicCloneState();",',
  '  "}",',
  '].join("\\n");',
  'const newCompleteTask = [',
  '  "async function kpopCompleteCloneTask(payload) {",',
  '  "  if (kpopCloneState.status !== \\\"running\\\") return kpopPublicCloneState();",',
  '  "  const lease = kpopTakeLease(String(payload?.leaseId || \\\"\\\"));",',
  '  "  const sourceTitle = String(payload?.sourceTitle || kpopTitleFromUrl(lease.url)).normalize(\\\"NFKC\\\").trim();",',
  '  "  const media = payload?.media && typeof payload.media === \\\"object\\\" ? payload.media : null;",',
  '  "  const mediaFailed = Math.max(0, Number(media?.failed || 0) || 0);",',
  '  "  kpopCloneState.lastMedia = media;",',
  '  "",',
  '  "  if (mediaFailed > 0 && lease.attempts < KPOP_CLONE_MAX_RETRIES) {",',
  '  "    kpopCloneState.queue.unshift({ url: lease.url, depth: lease.depth, attempts: lease.attempts, mode: lease.mode || \\\"expand\\\", forceCapture: Boolean(lease.forceCapture) });",',
  '  "    kpopCloneState.errors = [...kpopCloneState.errors, lease.url + \\\": retrying \\\" + mediaFailed + \\\" failed media assets\\\"].slice(-20);",',
  '  "    kpopSaveCloneState();",',
  '  "    return kpopPublicCloneState();",',
  '  "  }",',
  '  "",',
  '  "  kpopCloneState.processed += 1;",',
  '  "  kpopCloneState.captured += 1;",',
  '  "  if (mediaFailed > 0) {",',
  '  "    kpopCloneState.failed += 1;",',
  '  "    kpopCloneState.errors = [...kpopCloneState.errors, lease.url + \\\": \\\" + mediaFailed + \\\" media assets still failed after retries\\\"].slice(-20);",',
  '  "  }",',
  '  "  kpopCloneState.completedUrls.push(lease.url);",',
  '  "  if (sourceTitle) kpopCloneState.completedTitles.push(sourceTitle);",',
  '  "  if ((lease.mode || \\\"expand\\\") !== \\\"leaf\\\" && lease.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(payload?.internalLinks || [], lease.depth + 1);",',
  '  "  kpopFinalizeCloneIfDone();",',
  '  "  kpopSaveCloneState();",',
  '  "  return kpopPublicCloneState();",',
  '  "}",',
  '].join("\\n");',
  'v8 = mustReplace(v8, oldCompleteTask, newCompleteTask, "retry incomplete media before reuse + leaf stop");',
  '',
].join("\n");

const resetJobPatch = [
  'const resetFunctionMarker = "function kpopCancelCloneJob() {";',
  'const resetFunction = [',
  '  "function kpopResetCloneJob() {",',
  '  "  kpopCloneState = kpopDefaultCloneState();",',
  '  "  try { fs.unlinkSync(KPOP_CLONE_STATE_FILE); } catch {}",',
  '  "  console.log(\\"CLONE JOB RESET: queue/leases/progress cleared; captured DB artifacts kept\\");",',
  '  "  return kpopPublicCloneState();",',
  '  "}",',
  '  "",',
  '].join("\\n");',
  'v8 = mustReplace(v8, resetFunctionMarker, resetFunction + resetFunctionMarker, "clone reset function");',
  'const cancelRouteMarker = [',
  '  "    if (req.method === \\\"POST\\\" && url.pathname === \\\"/clone/cancel\\\") {",',
  '].join("\\n");',
  'const resetRoute = [',
  '  "    if (req.method === \\\"POST\\\" && url.pathname === \\\"/clone/reset\\\") {",',
  '  "      json(res, 200, { ok: true, job: kpopResetCloneJob() });",',
  '  "      return;",',
  '  "    }",',
  '  "",',
  '].join("\\n");',
  'v8 = mustReplace(v8, cancelRouteMarker, resetRoute + cancelRouteMarker, "clone reset route");',
  '',
].join("\n");

const rawSourcePatch = [
  'const rawFunctionMarker = "function kpopCancelCloneJob() {";',
  'const rawFunction = [',
  '  "async function kpopSaveRawSource(payload) {",',
  '  "  const rootTitle = String(payload?.rootTitle || payload?.sourceTitle || \\\"\\\").normalize(\\\"NFKC\\\").trim();",',
  '  "  const sourceTitle = String(payload?.sourceTitle || \\\"\\\").normalize(\\\"NFKC\\\").trim();",',
  '  "  const pageUrl = kpopCleanCloneUrl(payload?.pageUrl);",',
  '  "  let raw = String(payload?.raw || \\\"\\\");",',
  '  "  raw = raw.split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));",',
  '  "  raw = raw.split(String.fromCharCode(13)).join(String.fromCharCode(10));",',
  '  "  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);",',
  '  "  raw = raw.trim();",',
  '  "  if (!rootTitle || !sourceTitle || !pageUrl) throw new Error(\\\"raw source capture is missing rootTitle/sourceTitle/pageUrl\\\");",',
  '  "  const lowerRaw = raw.toLowerCase();",',
  '  "  const lines = raw.split(String.fromCharCode(10));",',
  '  "  const hasHeading = lines.some((line) => { const text = line.trim(); return text.length >= 3 && text.startsWith(\\\"=\\\") && text.endsWith(\\\"=\\\"); });",',
  '  "  const signals = [raw.includes(\\\"[[\\\") && raw.includes(\\\"]]\\\"), hasHeading, raw.includes(\\\"||\\\"), lowerRaw.includes(\\\"[include(\\\"), raw.includes(\\\"{{{#!\\\")].filter(Boolean).length;",',
  '  "  if (raw.length < 200 || signals < 2) throw new Error(\\\"captured edit source does not look like complete NamuMark (\\\" + raw.length + \\\" chars, \\\" + signals + \\\" signals)\\\");",',
  '  "  const doc = await ensureSourceDocument({ rootTitle, sourceTitle, pageUrl, crawlDepth: 0, internalLinks: [] });",',
  '  "  if (doc?.id) await recordSourceDocumentCluster(rootTitle, doc.id, 0);",',
  '  "  const capturedAt = new Date().toISOString();",',
  '  "  await db(\\\"source_documents?id=eq.\\\" + encodeURIComponent(doc.id), {",',
  '  "    method: \\\"PATCH\\\",",',
  '  "    headers: { Prefer: \\\"return=minimal\\\" },",',
  '  "    body: JSON.stringify({",',
  '  "      source_wikitext: raw,",',
  '  "      source_format: \\\"namuwiki_raw\\\",",',
  '  "      source_extraction_version: \\\"normal-chrome-edit-source-v1\\\",",',
  '  "      raw_extracted_at: capturedAt,",',
  '  "      updated_at: capturedAt,",',
  '  "    }),",',
  '  "  });",',
  '  "  console.log(\\\"RAW SOURCE SAVED \\\" + sourceTitle + \\\" -> \\\" + (Buffer.byteLength(raw, \\\"utf8\\\") / 1024).toFixed(1) + \\\" KB via \\\" + String(payload?.extractionMethod || \\\"normal-chrome-edit\\\"));",',
  '  "  return { ok: true, sourceTitle, rootTitle, charCount: raw.length, bytes: Buffer.byteLength(raw, \\\"utf8\\\"), capturedAt, sourceFormat: \\\"namuwiki_raw\\\" };",',
  '  "}",',
  '  "",',
  '].join("\\n");',
  'v8 = mustReplace(v8, rawFunctionMarker, rawFunction + rawFunctionMarker, "raw source save function");',
  'const rawRouteMarker = [',
  '  "    if (req.method === \\\"POST\\\" && url.pathname === \\\"/clone/cancel\\\") {",',
  '].join("\\n");',
  'const rawRoute = [',
  '  "    if (req.method === \\\"POST\\\" && url.pathname === \\\"/raw-source\\\") {",',
  '  "      json(res, 200, await kpopSaveRawSource(await kpopReadJson(req)));",',
  '  "      return;",',
  '  "    }",',
  '  "",',
  '].join("\\n");',
  'v8 = mustReplace(v8, rawRouteMarker, rawRoute + rawRouteMarker, "raw source route");',
  '',
].join("\n");

source = source
  .replace(combinedMarker, dbRetryPatch + combinedMarker)
  .replace(v8Marker, mediaRetryPatch + resetJobPatch + rawSourcePatch + v8Marker)
  .replaceAll("kpoparkive-namu-chrome-capture-helper-v10", "kpoparkive-namu-chrome-capture-helper-v11")
  .replaceAll("helper v10 (global Namu document registry + crawl policy)", "helper v11 (global registry + crawl policy + raw source + transient outage backoff)")
  .replaceAll("helper v10 (global Namu document registry)", "helper v11 (global registry + transient outage backoff)");

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
