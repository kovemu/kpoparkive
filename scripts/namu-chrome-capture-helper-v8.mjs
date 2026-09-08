import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const basePath = path.resolve("scripts/namu-chrome-capture-helper-combined.mjs");
const base = fs.readFileSync(basePath, "utf8");

const routeMarker = '    if (req.method === "POST" && url.pathname === "/document") {';
const proxyMarker = "async function proxyAsset(req, res) {";
const healthMarker = '      service: "kpoparkive-namu-chrome-capture-helper-v7",';
const startupMarker = '  console.log("Kpoparkive Namu Chrome capture helper v7 (recursive DOM clone + images)");';

for (const marker of [routeMarker, proxyMarker, healthMarker, startupMarker]) {
  if (!base.includes(marker)) throw new Error(`Browser capture helper base changed; v8 patch marker missing: ${marker}`);
}

const controller = String.raw`
const KPOP_CLONE_STATE_DIR = path.join(os.homedir(), ".kpoparkive");
const KPOP_CLONE_STATE_FILE = path.join(KPOP_CLONE_STATE_DIR, "namu-clone-state.json");
const KPOP_CLONE_LEASE_MS = 8 * 60 * 1000;
const KPOP_CLONE_MAX_RETRIES = 2;

function kpopDefaultCloneState() {
  return {
    id: "", status: "idle", rootTitle: "", rootUrl: "", maxDepth: 0, maxDocs: 0,
    queue: [], leases: [], seenUrls: [], completedUrls: [], completedTitles: [],
    processed: 0, captured: 0, skipped: 0, failed: 0, errors: [], lastMedia: null,
    createdAt: null, updatedAt: null, finishedAt: null,
  };
}

function kpopLoadCloneState() {
  try {
    if (!fs.existsSync(KPOP_CLONE_STATE_FILE)) return kpopDefaultCloneState();
    const value = JSON.parse(fs.readFileSync(KPOP_CLONE_STATE_FILE, "utf8"));
    return { ...kpopDefaultCloneState(), ...(value && typeof value === "object" ? value : {}) };
  } catch { return kpopDefaultCloneState(); }
}

let kpopCloneState = kpopLoadCloneState();

function kpopSaveCloneState() {
  fs.mkdirSync(KPOP_CLONE_STATE_DIR, { recursive: true });
  kpopCloneState.updatedAt = new Date().toISOString();
  const tmp = KPOP_CLONE_STATE_FILE + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(kpopCloneState, null, 2), "utf8");
  fs.renameSync(tmp, KPOP_CLONE_STATE_FILE);
}

function kpopPublicCloneState() {
  return {
    id: kpopCloneState.id,
    status: kpopCloneState.status,
    running: kpopCloneState.status === "running",
    done: kpopCloneState.status === "done",
    rootTitle: kpopCloneState.rootTitle,
    maxDepth: kpopCloneState.maxDepth,
    maxDocs: kpopCloneState.maxDocs,
    processed: kpopCloneState.processed,
    captured: kpopCloneState.captured,
    skipped: kpopCloneState.skipped,
    failed: kpopCloneState.failed,
    queued: kpopCloneState.queue.length,
    leased: kpopCloneState.leases.length,
    current: kpopCloneState.leases.map((lease) => kpopTitleFromUrl(lease.url) || lease.url),
    errors: kpopCloneState.errors.slice(-10),
    lastMedia: kpopCloneState.lastMedia,
    createdAt: kpopCloneState.createdAt,
    updatedAt: kpopCloneState.updatedAt,
    finishedAt: kpopCloneState.finishedAt,
  };
}

function kpopTitleFromUrl(value) {
  try {
    const url = new URL(validateNamuPageUrl(value));
    const raw = url.pathname.replace(/^\/w\//, "");
    try { return decodeURIComponent(raw).normalize("NFKC").trim(); }
    catch { return raw.normalize("NFKC").trim(); }
  } catch { return ""; }
}

function kpopCleanCloneUrl(value) {
  try {
    const url = new URL(validateNamuPageUrl(value));
    url.hash = "";
    return url.toString();
  } catch { return ""; }
}

async function kpopReadJson(req, maxBytes = 2 * 1024 * 1024) {
  const bytes = await readBody(req, maxBytes);
  if (!bytes.length) return {};
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("request body is not valid JSON"); }
}

async function kpopExistingDocument(rootTitle, sourceTitle) {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
    "&root_title=eq." + encodeURIComponent(rootTitle) +
    "&source_title=eq." + encodeURIComponent(sourceTitle) +
    "&select=source_title,source_url,crawl_depth,discovered_links,source_browser_captured_at,source_browser_capture_version&limit=1"
  );
  return rows?.[0] || null;
}

async function kpopKnownAssetUrls(rootTitle) {
  const rows = await db(
    "namu_capture_staging?root_title=eq." + encodeURIComponent(rootTitle) +
    "&select=source_url&source_url=not.is.null&limit=10000"
  );
  return [...new Set((rows || []).map((row) => String(row?.source_url || "").trim()).filter(Boolean))];
}

function kpopEnqueueLinks(links, depth) {
  if (depth > kpopCloneState.maxDepth) return 0;
  const seen = new Set(kpopCloneState.seenUrls);
  let added = 0;
  for (const link of cleanInternalLinks(links)) {
    if (kpopCloneState.queue.length + kpopCloneState.processed + kpopCloneState.leases.length >= kpopCloneState.maxDocs * 4) break;
    const url = kpopCleanCloneUrl(link.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    kpopCloneState.seenUrls.push(url);
    kpopCloneState.queue.push({ url, depth, attempts: 0 });
    added += 1;
  }
  return added;
}

function kpopFinalizeCloneIfDone() {
  if (kpopCloneState.status !== "running") return;
  if (kpopCloneState.processed >= kpopCloneState.maxDocs || (!kpopCloneState.queue.length && !kpopCloneState.leases.length)) {
    kpopCloneState.status = "done";
    kpopCloneState.finishedAt = new Date().toISOString();
  }
}

function kpopReleaseExpiredLeases() {
  if (kpopCloneState.status !== "running" || !kpopCloneState.leases.length) return;
  const now = Date.now();
  const keep = [];
  for (const lease of kpopCloneState.leases) {
    if (Date.parse(lease.leaseUntil || 0) > now) { keep.push(lease); continue; }
    if (lease.attempts < KPOP_CLONE_MAX_RETRIES) {
      kpopCloneState.queue.unshift({ url: lease.url, depth: lease.depth, attempts: lease.attempts });
    } else {
      kpopCloneState.processed += 1;
      kpopCloneState.failed += 1;
      kpopCloneState.errors = [...kpopCloneState.errors, lease.url + ": lease expired after retries"].slice(-20);
    }
  }
  kpopCloneState.leases = keep;
  kpopFinalizeCloneIfDone();
  kpopSaveCloneState();
}

async function kpopStartCloneJob(payload) {
  const rootTitle = String(payload?.rootTitle || "").normalize("NFKC").trim();
  const rootUrl = kpopCleanCloneUrl(payload?.rootUrl);
  const maxDepth = Math.max(0, Math.min(3, Number(payload?.maxDepth || 0) || 0));
  const maxDocs = Math.max(1, Math.min(200, Number(payload?.maxDocs || 25) || 25));
  if (!rootTitle || !rootUrl) throw new Error("rootTitle/rootUrl are required");

  if (kpopCloneState.status === "running") {
    if (kpopCloneState.rootTitle === rootTitle && kpopCloneState.rootUrl === rootUrl) return kpopPublicCloneState();
    throw new Error("another clone job is already running for " + kpopCloneState.rootTitle);
  }

  const now = new Date().toISOString();
  kpopCloneState = {
    ...kpopDefaultCloneState(), id: crypto.randomUUID(), status: "running", rootTitle, rootUrl,
    maxDepth, maxDocs, queue: [{ url: rootUrl, depth: 0, attempts: 0 }], seenUrls: [rootUrl],
    createdAt: now, updatedAt: now,
  };
  kpopSaveCloneState();
  console.log("CLONE JOB START " + rootTitle + " depth=" + maxDepth + " maxDocs=" + maxDocs);
  return kpopPublicCloneState();
}

async function kpopClaimCloneTask() {
  kpopReleaseExpiredLeases();
  if (kpopCloneState.status !== "running") return { status: kpopCloneState.status, job: kpopPublicCloneState() };

  while (kpopCloneState.queue.length && kpopCloneState.processed + kpopCloneState.leases.length < kpopCloneState.maxDocs) {
    const item = kpopCloneState.queue.shift();
    if (!item?.url) continue;
    const title = kpopTitleFromUrl(item.url);
    if (!title) continue;

    const existing = await kpopExistingDocument(kpopCloneState.rootTitle, title);
    if (existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION) {
      kpopCloneState.processed += 1;
      kpopCloneState.skipped += 1;
      kpopCloneState.completedUrls.push(item.url);
      kpopCloneState.completedTitles.push(title);
      if (item.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(existing.discovered_links || [], item.depth + 1);
      kpopFinalizeCloneIfDone();
      kpopSaveCloneState();
      if (kpopCloneState.status !== "running") return { status: "done", job: kpopPublicCloneState() };
      continue;
    }

    const attempts = Number(item.attempts || 0) + 1;
    const lease = {
      leaseId: crypto.randomUUID(), url: item.url, depth: item.depth, attempts,
      leasedAt: new Date().toISOString(), leaseUntil: new Date(Date.now() + KPOP_CLONE_LEASE_MS).toISOString(),
    };
    kpopCloneState.leases.push(lease);
    kpopSaveCloneState();
    return { status: "task", task: lease, job: kpopPublicCloneState() };
  }

  kpopFinalizeCloneIfDone();
  kpopSaveCloneState();
  return { status: kpopCloneState.status === "done" ? "done" : "wait", job: kpopPublicCloneState() };
}

function kpopTakeLease(leaseId) {
  const index = kpopCloneState.leases.findIndex((lease) => lease.leaseId === leaseId);
  if (index < 0) throw new Error("clone lease not found or expired");
  return kpopCloneState.leases.splice(index, 1)[0];
}

async function kpopCompleteCloneTask(payload) {
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
}

async function kpopFailCloneTask(payload) {
  if (kpopCloneState.status !== "running") return kpopPublicCloneState();
  const lease = kpopTakeLease(String(payload?.leaseId || ""));
  const error = String(payload?.error || "capture failed").slice(0, 1000);
  if (lease.attempts < KPOP_CLONE_MAX_RETRIES) {
    kpopCloneState.queue.push({ url: lease.url, depth: lease.depth, attempts: lease.attempts });
  } else {
    kpopCloneState.processed += 1;
    kpopCloneState.failed += 1;
    kpopCloneState.errors = [...kpopCloneState.errors, lease.url + ": " + error].slice(-20);
  }
  kpopFinalizeCloneIfDone();
  kpopSaveCloneState();
  return kpopPublicCloneState();
}

function kpopCancelCloneJob() {
  if (kpopCloneState.status === "running") {
    kpopCloneState.status = "cancelled";
    kpopCloneState.finishedAt = new Date().toISOString();
    kpopCloneState.leases = [];
    kpopSaveCloneState();
  }
  return kpopPublicCloneState();
}

if (kpopCloneState.status === "running") {
  kpopReleaseExpiredLeases();
  console.log("RESUMING CLONE JOB " + kpopCloneState.rootTitle + " processed=" + kpopCloneState.processed + " queued=" + kpopCloneState.queue.length);
}
`;

const routes = String.raw`
    if (req.method === "GET" && url.pathname === "/assets-known") {
      const rootTitle = String(url.searchParams.get("rootTitle") || "").trim();
      if (!rootTitle) throw new Error("rootTitle is required");
      json(res, 200, { ok: true, urls: await kpopKnownAssetUrls(rootTitle) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/clone/status") {
      kpopReleaseExpiredLeases();
      json(res, 200, { ok: true, job: kpopPublicCloneState() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clone/start") {
      json(res, 200, { ok: true, job: await kpopStartCloneJob(await kpopReadJson(req)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clone/claim") {
      json(res, 200, { ok: true, ...(await kpopClaimCloneTask()) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clone/complete") {
      json(res, 200, { ok: true, job: await kpopCompleteCloneTask(await kpopReadJson(req)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clone/fail") {
      json(res, 200, { ok: true, job: await kpopFailCloneTask(await kpopReadJson(req)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clone/cancel") {
      json(res, 200, { ok: true, job: kpopCancelCloneJob() });
      return;
    }

`;

const patched = base
  .replace('import path from "node:path";', 'import path from "node:path";\nimport os from "node:os";')
  .replace(proxyMarker, controller + "\n" + proxyMarker)
  .replace(routeMarker, routes + routeMarker)
  .replace(healthMarker, '      service: "kpoparkive-namu-chrome-capture-helper-v8",\n      helperOwnedQueue: true,\n      clone: kpopPublicCloneState(),')
  .replace(startupMarker, '  console.log("Kpoparkive Namu Chrome capture helper v8 (persistent helper-owned clone queue)");\n  console.log(`Persistent clone state: ${KPOP_CLONE_STATE_FILE}`);');

const tempPath = path.join(os.tmpdir(), `kpoparkive-namu-capture-v8-${process.pid}.mjs`);
fs.writeFileSync(tempPath, patched, "utf8");

const cleanup = () => { try { fs.unlinkSync(tempPath); } catch {} };
process.on("exit", cleanup);

try {
  await import(pathToFileURL(tempPath).href);
} catch (error) {
  cleanup();
  throw error;
}
