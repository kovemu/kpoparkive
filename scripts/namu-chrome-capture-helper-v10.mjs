import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const combinedPath = path.resolve("scripts/namu-chrome-capture-helper-combined.mjs");
const v8Path = path.resolve("scripts/namu-chrome-capture-helper-v8.mjs");
let combined = fs.readFileSync(combinedPath, "utf8").replace(/\r\n?/g, "\n");
let v8 = fs.readFileSync(v8Path, "utf8").replace(/\r\n?/g, "\n");

function mustReplace(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`v10 patch marker missing: ${label}`);
  return source.replace(before, after);
}

const oldEnsureQuery = [
  "  const docs = await db(",
  "    `source_documents?source=eq.namu_mirror` +",
  "    `&root_title=eq.${encodeURIComponent(rootTitle)}` +",
  "    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +",
  "    `&select=id,source_title,root_title&limit=1`,",
  "  );",
].join("\n");
const newEnsureQuery = [
  "  const docs = await db(",
  "    `source_documents?source=eq.namu_mirror` +",
  "    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +",
  "    `&select=id,source_title,root_title&limit=1`,",
  "  );",
].join("\n");
combined = mustReplace(combined, oldEnsureQuery, newEnsureQuery, "global ensureSourceDocument lookup");

async function recordSourceDocumentCluster(rootTitle, sourceDocumentId, crawlDepth) {
  const keyRoot = String(rootTitle || "").normalize("NFKC").trim();
  if (!keyRoot || !sourceDocumentId) return;
  const existing = await db(
    `source_document_clusters?root_title=eq.${encodeURIComponent(keyRoot)}&source_document_id=eq.${encodeURIComponent(sourceDocumentId)}&select=min_crawl_depth&limit=1`
  );
  const depth = Math.max(0, Number(crawlDepth || 0) || 0);
  if (existing?.[0]) {
    await db(
      `source_document_clusters?root_title=eq.${encodeURIComponent(keyRoot)}&source_document_id=eq.${encodeURIComponent(sourceDocumentId)}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          min_crawl_depth: Math.min(Number(existing[0].min_crawl_depth || 0), depth),
          last_seen_at: new Date().toISOString(),
        }),
      },
    );
  } else {
    await db("source_document_clusters", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ root_title: keyRoot, source_document_id: sourceDocumentId, min_crawl_depth: depth }),
    });
  }
}

async function syncSourceDocumentLinks(fromDocumentId, links) {
  const cleaned = cleanInternalLinks(links).slice(0, 1000);
  if (!fromDocumentId || !cleaned.length) return;
  const now = new Date().toISOString();
  const rows = cleaned.map((link) => ({
    from_document_id: fromDocumentId,
    to_source_title: link.title,
    to_source_url: link.href,
    anchor_text: link.text || null,
    last_seen_at: now,
  }));
  await db("source_document_links?on_conflict=from_document_id,to_source_title", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
}

async function backfillIncomingDocumentLinks(sourceTitle, sourceDocumentId) {
  if (!sourceTitle || !sourceDocumentId) return;
  await db(
    `source_document_links?to_source_title=eq.${encodeURIComponent(sourceTitle)}&to_document_id=is.null`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ to_document_id: sourceDocumentId, last_seen_at: new Date().toISOString() }),
    },
  );
}

const registryHelpers = [
  recordSourceDocumentCluster.toString(),
  syncSourceDocumentLinks.toString(),
  backfillIncomingDocumentLinks.toString(),
].join("\n\n") + "\n\n";

const saveMarker = "async function saveRenderedDocument(payload) {";
combined = mustReplace(combined, saveMarker, registryHelpers + saveMarker, "registry helper injection");

const docMarker = "  const doc = await ensureSourceDocument({ rootTitle, sourceTitle, pageUrl, crawlDepth, internalLinks });";
combined = mustReplace(
  combined,
  docMarker,
  docMarker + "\n  await recordSourceDocumentCluster(rootTitle, doc.id, crawlDepth);\n  await backfillIncomingDocumentLinks(sourceTitle, doc.id);",
  "cluster membership on capture",
);

const statsMarker = "  stats.documentsSaved += 1;";
combined = mustReplace(combined, statsMarker, "  await syncSourceDocumentLinks(doc.id, internalLinks);\n\n" + statsMarker, "link graph sync");

const oldCleanInternalLinks = [
  "function cleanInternalLinks(value) {",
  "  if (!Array.isArray(value)) return [];",
  "  const output = [];",
  "  const seen = new Set();",
  "  for (const item of value) {",
  "    const title = String(item?.title || item || \"\").normalize(\"NFKC\").trim();",
  "    if (!title || seen.has(title)) continue;",
  "    seen.add(title);",
  "    output.push({",
  "      title,",
  "      href: String(item?.href || `https://namu.wiki/w/${encodeURIComponent(title)}`).trim(),",
  "      text: String(item?.text || \"\").replace(/\\s+/g, \" \" ).trim().slice(0, 240),",
  "    });",
  "    if (output.length >= 2000) break;",
  "  }",
  "  return output;",
  "}",
].join("\n").replace('replace(/\\s+/g, " " )', 'replace(/\\s+/g, " ")');

function kpopPolicyCleanInternalLinks(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const item of value) {
    const title = String(item?.title || item || "").normalize("NFKC").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    const crawlMode = ["expand", "leaf", "skip"].includes(String(item?.crawlMode || "").toLowerCase())
      ? String(item.crawlMode).toLowerCase()
      : "";
    const link = {
      title,
      href: String(item?.href || `https://namu.wiki/w/${encodeURIComponent(title)}`).trim(),
      text: String(item?.text || "").replace(/\s+/g, " ").trim().slice(0, 240),
    };
    if (crawlMode) link.crawlMode = crawlMode;
    if (item?.relation) link.relation = String(item.relation).slice(0, 80);
    if (item?.section) link.section = String(item.section).slice(0, 80);
    if (item?.sectionTitle) link.sectionTitle = String(item.sectionTitle).replace(/\s+/g, " ").trim().slice(0, 180);
    if (item?.context) link.context = String(item.context).replace(/\s+/g, " ").trim().slice(0, 900);
    if (Number.isFinite(Number(item?.priority))) link.priority = Number(item.priority);
    if (Number.isFinite(Number(item?.importanceTier))) link.importanceTier = Number(item.importanceTier);
    if (Number.isFinite(Number(item?.tocOrder))) link.tocOrder = Number(item.tocOrder);
    if (Number.isFinite(Number(item?.crawlPolicyVersion))) link.crawlPolicyVersion = Number(item.crawlPolicyVersion);
    output.push(link);
    if (output.length >= 2000) break;
  }
  return output;
}
const newCleanInternalLinks = kpopPolicyCleanInternalLinks.toString().replace("kpopPolicyCleanInternalLinks", "cleanInternalLinks");
combined = mustReplace(combined, oldCleanInternalLinks, newCleanInternalLinks, "preserve crawl relationship metadata");

const tempCombined = path.join(os.tmpdir(), `kpoparkive-namu-combined-v10-${process.pid}.mjs`);
fs.writeFileSync(tempCombined, combined, "utf8");

v8 = mustReplace(
  v8,
  'const basePath = path.resolve("scripts/namu-chrome-capture-helper-combined.mjs");',
  `const basePath = ${JSON.stringify(tempCombined)};`,
  "v8 combined path",
);

const oldExisting = String.raw`async function kpopExistingDocument(rootTitle, sourceTitle) {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
    "&root_title=eq." + encodeURIComponent(rootTitle) +
    "&source_title=eq." + encodeURIComponent(sourceTitle) +
    "&select=source_title,source_url,crawl_depth,discovered_links,source_browser_captured_at,source_browser_capture_version&limit=1"
  );
  return rows?.[0] || null;
}`;
const newExisting = String.raw`async function kpopExistingDocument(_rootTitle, sourceTitle) {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
    "&source_title=eq." + encodeURIComponent(sourceTitle) +
    "&select=id,source_title,source_url,crawl_depth,discovered_links,source_browser_captured_at,source_browser_capture_version,source_wikitext,raw_extracted_at,source_format,source_extraction_version&limit=1"
  );
  return rows?.[0] || null;
}`;
v8 = mustReplace(v8, oldExisting, newExisting, "global existing-document lookup");

const oldKnownAssets = String.raw`async function kpopKnownAssetUrls(rootTitle) {
  const rows = await db(
    "namu_capture_staging?root_title=eq." + encodeURIComponent(rootTitle) +
    "&select=source_url&source_url=not.is.null&limit=10000"
  );
  return [...new Set((rows || []).map((row) => String(row?.source_url || "").trim()).filter(Boolean))];
}`;
const newKnownAssets = String.raw`async function kpopKnownAssetUrls(_rootTitle) {
  const staging = await db("namu_capture_staging?select=source_url&source_url=not.is.null&limit=10000");
  const resolved = await db("source_asset_queue?status=eq.resolved&select=metadata&limit=10000");
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
v8 = mustReplace(v8, oldKnownAssets, newKnownAssets, "global known-media cache");

v8 = mustReplace(
  v8,
  "const KPOP_CLONE_MAX_RETRIES = 2;",
  "const KPOP_CLONE_MAX_RETRIES = 2;\nconst KPOP_CRAWL_POLICY_VERSION = 4;",
  "crawl policy version",
);

v8 = mustReplace(
  v8,
  '    id: "", status: "idle", rootTitle: "", rootUrl: "", maxDepth: 0, maxDocs: 0,',
  '    id: "", status: "idle", rootTitle: "", rootUrl: "", maxDepth: 0, maxDocs: 0, captureMode: "dom", crawlProfile: "smart-core", crawlOrder: "smart", includeLeaf: true, refreshExisting: false, paused: false, pauseReason: "", pausedAt: null, policyVersion: KPOP_CRAWL_POLICY_VERSION, policyRefresh: false,',
  "crawl policy state",
);

const oldLoadCloneState = String.raw`function kpopLoadCloneState() {
  try {
    if (!fs.existsSync(KPOP_CLONE_STATE_FILE)) return kpopDefaultCloneState();
    const value = JSON.parse(fs.readFileSync(KPOP_CLONE_STATE_FILE, "utf8"));
    return { ...kpopDefaultCloneState(), ...(value && typeof value === "object" ? value : {}) };
  } catch { return kpopDefaultCloneState(); }
}`;
const newLoadCloneState = String.raw`function kpopLoadCloneState() {
  try {
    const defaults = kpopDefaultCloneState();
    if (!fs.existsSync(KPOP_CLONE_STATE_FILE)) return defaults;
    const value = JSON.parse(fs.readFileSync(KPOP_CLONE_STATE_FILE, "utf8"));
    const persisted = value && typeof value === "object" ? value : {};
    const loaded = { ...defaults, ...persisted };
    if (!Object.prototype.hasOwnProperty.call(persisted, "policyVersion")) loaded.policyVersion = 0;
    return loaded;
  } catch { return kpopDefaultCloneState(); }
}`;
v8 = mustReplace(v8, oldLoadCloneState, newLoadCloneState, "legacy persisted crawl policy migration");


v8 = mustReplace(
  v8,
  "    maxDocs: kpopCloneState.maxDocs,",
  "    maxDocs: kpopCloneState.maxDocs,\n    captureMode: kpopCloneState.captureMode || \"dom\",\n    crawlProfile: kpopCloneState.crawlProfile || \"smart-core\",\n    crawlOrder: kpopCloneState.crawlOrder || \"smart\",\n    includeLeaf: kpopCloneState.includeLeaf !== false,\n    refreshExisting: Boolean(kpopCloneState.refreshExisting),\n    paused: Boolean(kpopCloneState.paused),\n    pauseReason: kpopCloneState.pauseReason || \"\",\n    pausedAt: kpopCloneState.pausedAt || null,\n    policyVersion: kpopCloneState.policyVersion,\n    policyRefresh: Boolean(kpopCloneState.policyRefresh),",
  "public crawl policy state",
);

const oldEnqueueLinks = String.raw`function kpopEnqueueLinks(links, depth) {
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
}`;
const newEnqueueLinks = String.raw`function kpopFallbackCrawlMode(link) {
  const explicit = String(link?.crawlMode || "").toLowerCase();
  if (["expand", "leaf", "skip"].includes(explicit)) return explicit;

  // Policy v3 is strict TOC-first. If an old captured link has no explicit
  // crawl decision, it is not allowed to enter the clone queue.
  return "skip";
}

function kpopQueueImportance(link, mode) {
  if (Number.isFinite(Number(link?.importanceTier))) return Number(link.importanceTier);
  const relation = String(link?.relation || "");
  if (relation === "subdocument") return 10;
  if (relation === "member") return 20;
  if (relation === "core_kpop_document") return 30;
  if (mode === "expand") return 35;
  if (mode === "leaf") return 50;
  return 70;
}

function kpopSortCloneQueue() {
  const order = String(kpopCloneState.crawlOrder || "smart");
  kpopCloneState.queue.sort((a, b) => {
    const depthDiff = Number(a?.depth || 0) - Number(b?.depth || 0);
    if (depthDiff) return depthDiff;

    const aTier = Number(a?.importanceTier ?? 99);
    const bTier = Number(b?.importanceTier ?? 99);
    const aToc = Number.isFinite(Number(a?.tocOrder)) ? Number(a.tocOrder) : Number.MAX_SAFE_INTEGER;
    const bToc = Number.isFinite(Number(b?.tocOrder)) ? Number(b.tocOrder) : Number.MAX_SAFE_INTEGER;

    if (order === "toc") {
      if (aToc !== bToc) return aToc - bToc;
      if (aTier !== bTier) return aTier - bTier;
    } else {
      if (aTier !== bTier) return aTier - bTier;
      if (aToc !== bToc) return aToc - bToc;
    }

    const priorityDiff = Number(b?.priority || 0) - Number(a?.priority || 0);
    if (priorityDiff) return priorityDiff;
    return Number(a?.queueOrder || 0) - Number(b?.queueOrder || 0);
  });
}

function kpopEnqueueLinks(links, depth) {
  if (depth > kpopCloneState.maxDepth) return 0;
  const seen = new Set(kpopCloneState.seenUrls);
  let added = 0;
  for (const link of cleanInternalLinks(links)) {
    if (kpopCloneState.queue.length + kpopCloneState.processed + kpopCloneState.leases.length >= kpopCloneState.maxDocs * 4) break;
    const mode = kpopFallbackCrawlMode(link);
    if (mode === "skip") continue;
    if (mode === "leaf" && kpopCloneState.includeLeaf === false) continue;
    const url = kpopCleanCloneUrl(link.href);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    kpopCloneState.seenUrls.push(url);
    kpopCloneState.queue.push({
      url,
      depth,
      attempts: 0,
      mode,
      priority: Number(link?.priority || 0) || 0,
      importanceTier: kpopQueueImportance(link, mode),
      tocOrder: Number.isFinite(Number(link?.tocOrder)) ? Number(link.tocOrder) : null,
      relation: String(link?.relation || "").slice(0, 80),
      queueOrder: kpopCloneState.seenUrls.length,
      forceCapture: Boolean(kpopCloneState.refreshExisting),
    });
    added += 1;
  }
  kpopSortCloneQueue();
  return added;
}`;
v8 = mustReplace(v8, oldEnqueueLinks, newEnqueueLinks, "expand leaf skip enqueue policy");

v8 = mustReplace(
  v8,
  "  const maxDocs = Math.max(1, Math.min(200, Number(payload?.maxDocs || 25) || 25));\n  if (!rootTitle || !rootUrl) throw new Error(\"rootTitle/rootUrl are required\");",
  "  const maxDocs = Math.max(1, Math.min(200, Number(payload?.maxDocs || 40) || 40));\n  const captureMode = String(payload?.captureMode || \"dom\").toLowerCase() === \"raw\" ? \"raw\" : \"dom\";\n  const crawlProfile = String(payload?.crawlProfile || \"smart-core\").toLowerCase();\n  const crawlOrder = String(payload?.crawlOrder || \"smart\").toLowerCase() === \"toc\" ? \"toc\" : \"smart\";\n  const includeLeaf = payload?.includeLeaf !== false;\n  const refreshExisting = Boolean(payload?.refreshExisting);\n  if (!rootTitle || !rootUrl) throw new Error(\"rootTitle/rootUrl are required\");",
  "capture mode on new job",
);

v8 = mustReplace(
  v8,
  "  const now = new Date().toISOString();\n  kpopCloneState = {",
  "  const now = new Date().toISOString();\n  const policyRefresh = Number(kpopCloneState.policyVersion || 0) !== KPOP_CRAWL_POLICY_VERSION;\n  kpopCloneState = {",
  "policy refresh decision on new job",
);

v8 = mustReplace(
  v8,
  "    maxDepth, maxDocs, queue: [{ url: rootUrl, depth: 0, attempts: 0 }], seenUrls: [rootUrl],",
  "    maxDepth, maxDocs, captureMode, crawlProfile, crawlOrder, includeLeaf, refreshExisting, policyVersion: KPOP_CRAWL_POLICY_VERSION, policyRefresh, queue: [{ url: rootUrl, depth: 0, attempts: 0, mode: \"expand\", priority: 999, importanceTier: 0, tocOrder: -1, relation: \"root\", queueOrder: 0, forceCapture: captureMode === \"raw\" || refreshExisting || policyRefresh }], seenUrls: [rootUrl],",
  "root queue policy",
);

v8 = mustReplace(
  v8,
  "      leaseId: crypto.randomUUID(), url: item.url, depth: item.depth, attempts,",
  "      leaseId: crypto.randomUUID(), url: item.url, depth: item.depth, attempts, mode: item.mode || \"expand\", priority: Number(item.priority || 0), importanceTier: Number(item.importanceTier ?? 99), tocOrder: item.tocOrder ?? null, relation: item.relation || \"\", queueOrder: Number(item.queueOrder || 0), forceCapture: Boolean(item.forceCapture),",
  "lease crawl mode",
);

v8 = mustReplace(
  v8,
  "      kpopCloneState.queue.unshift({ url: lease.url, depth: lease.depth, attempts: lease.attempts });",
  "      kpopCloneState.queue.push({ url: lease.url, depth: lease.depth, attempts: lease.attempts, mode: lease.mode || \"expand\", priority: Number(lease.priority || 0), importanceTier: Number(lease.importanceTier ?? 99), tocOrder: lease.tocOrder ?? null, relation: lease.relation || \"\", queueOrder: Number(lease.queueOrder || 0), forceCapture: Boolean(lease.forceCapture) });\n      kpopSortCloneQueue();",
  "expired lease crawl mode",
);

v8 = mustReplace(
  v8,
  "    kpopCloneState.queue.push({ url: lease.url, depth: lease.depth, attempts: lease.attempts });",
  "    kpopCloneState.queue.push({ url: lease.url, depth: lease.depth, attempts: lease.attempts, mode: lease.mode || \"expand\", priority: Number(lease.priority || 0), importanceTier: Number(lease.importanceTier ?? 99), tocOrder: lease.tocOrder ?? null, relation: lease.relation || \"\", queueOrder: Number(lease.queueOrder || 0), forceCapture: Boolean(lease.forceCapture) });\n    kpopSortCloneQueue();",
  "failed lease crawl mode",
);

const resumeMarker = String.raw`if (kpopCloneState.status === "running") {
  kpopReleaseExpiredLeases();`;
const policyResume = String.raw`if (kpopCloneState.status === "running" && Number(kpopCloneState.policyVersion || 0) !== KPOP_CRAWL_POLICY_VERSION) {
  const rootUrl = kpopCloneState.rootUrl;
  console.log("CRAWL POLICY CHANGED -> rebuilding pending queue from root (v" + KPOP_CRAWL_POLICY_VERSION + ")");
  kpopCloneState = {
    ...kpopCloneState,
    policyVersion: KPOP_CRAWL_POLICY_VERSION,
    policyRefresh: true,
    status: "running",
    queue: rootUrl ? [{ url: rootUrl, depth: 0, attempts: 0, mode: "expand", priority: 999, importanceTier: 0, tocOrder: -1, relation: "root", queueOrder: 0, forceCapture: true }] : [],
    leases: [],
    seenUrls: rootUrl ? [rootUrl] : [],
    completedUrls: [],
    completedTitles: [],
    processed: 0,
    captured: 0,
    skipped: 0,
    failed: 0,
    errors: ["crawl policy updated; old pending queue discarded"],
    finishedAt: null,
  };
  kpopSaveCloneState();
}

if (kpopCloneState.status === "running") {
  kpopReleaseExpiredLeases();`;
v8 = mustReplace(v8, resumeMarker, policyResume, "discard stale queue on crawl policy change");

const finalizeBefore = "  if (kpopCloneState.processed >= kpopCloneState.maxDocs || (!kpopCloneState.queue.length && !kpopCloneState.leases.length)) {";
const finalizeAfter = "  if (kpopClaimInFlight === 0 && (kpopCloneState.processed >= kpopCloneState.maxDocs || (!kpopCloneState.queue.length && !kpopCloneState.leases.length))) {";
v8 = mustReplace(v8, finalizeBefore, finalizeAfter, "claim race finalizer guard");

v8 = mustReplace(v8, "async function kpopClaimCloneTask() {", "async function kpopClaimCloneTaskUnsafe() {", "claim function rename");
const takeLeaseMarker = "function kpopTakeLease(leaseId) {";
const serializedClaim = String.raw`let kpopClaimSerial = Promise.resolve();
let kpopClaimInFlight = 0;

async function kpopClaimCloneTask() {
  kpopClaimInFlight += 1;
  const previous = kpopClaimSerial;
  let release;
  kpopClaimSerial = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await kpopClaimCloneTaskUnsafe();
  } finally {
    kpopClaimInFlight = Math.max(0, kpopClaimInFlight - 1);
    release();
    // Completion is guarded while a claim is active. Re-check immediately
    // after the final serialized claimant leaves, otherwise a reused 1/1 job
    // can remain stuck in RUNNING with queue=0 and leases=0.
    if (kpopClaimInFlight === 0) {
      kpopFinalizeCloneIfDone();
      kpopSaveCloneState();
    }
  }
}

`;
v8 = mustReplace(v8, takeLeaseMarker, serializedClaim + takeLeaseMarker, "serialized claim wrapper");
const cloneStatusBefore = [
  '    if (req.method === "GET" && url.pathname === "/clone/status") {',
  "      kpopReleaseExpiredLeases();",
  "      json(res, 200, { ok: true, job: kpopPublicCloneState() });",
  "      return;",
  "    }",
].join("\n");
const cloneStatusAfter = [
  '    if (req.method === "GET" && url.pathname === "/clone/status") {',
  "      kpopReleaseExpiredLeases();",
  "      // Status polling must also close a fully processed/reused job.",
  "      kpopFinalizeCloneIfDone();",
  "      kpopSaveCloneState();",
  "      json(res, 200, { ok: true, job: kpopPublicCloneState() });",
  "      return;",
  "    }",
].join("\n");
v8 = mustReplace(v8, cloneStatusBefore, cloneStatusAfter, "finalize completed clone on status poll");


const oldSkip = String.raw`    if (existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION) {
      kpopCloneState.processed += 1;`;
const newSkip = String.raw`    const capturedAtMs = Date.parse(existing?.source_browser_captured_at || "");
    const capturedAfterAdFilter = Number.isFinite(capturedAtMs) && capturedAtMs >= Date.parse("2026-09-08T16:30:00Z");
    const reusable = kpopCloneState.captureMode === "raw"
      ? Boolean(
          !item.forceCapture &&
          existing?.source_wikitext &&
          existing?.raw_extracted_at &&
          existing?.source_format === "namuwiki_raw" &&
          /^normal-chrome-(?:raw-view|edit-source)-v1$/.test(String(existing?.source_extraction_version || "")) &&
          ((item.mode || "expand") === "leaf" || (Array.isArray(existing?.discovered_links) && existing.discovered_links.length > 0))
        )
      : Boolean(!item.forceCapture && existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION && capturedAfterAdFilter);
    if (reusable) {
      if (existing?.id) {
        const membership = await db(
          "source_document_clusters?root_title=eq." + encodeURIComponent(kpopCloneState.rootTitle) +
          "&source_document_id=eq." + encodeURIComponent(existing.id) +
          "&select=min_crawl_depth&limit=1"
        );
        if (!membership?.[0]) {
          await db("source_document_clusters", {
            method: "POST",
            headers: { Prefer: "return=minimal" },
            body: JSON.stringify({
              root_title: kpopCloneState.rootTitle,
              source_document_id: existing.id,
              min_crawl_depth: item.depth,
            }),
          });
        }
      }
      kpopCloneState.processed += 1;`;
v8 = mustReplace(v8, oldSkip, newSkip, "global reuse membership + ad refresh + policy refresh");

v8 = mustReplace(
  v8,
  "      if (item.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(existing.discovered_links || [], item.depth + 1);",
  "      if ((item.mode || \"expand\") !== \"leaf\" && item.depth < kpopCloneState.maxDepth) kpopEnqueueLinks(existing.discovered_links || [], item.depth + 1);",
  "leaf documents stop on reuse",
);

v8 = mustReplace(
  v8,
  "async function kpopClaimCloneTaskUnsafe() {\n  kpopReleaseExpiredLeases();",
  "async function kpopClaimCloneTaskUnsafe() {\n  kpopReleaseExpiredLeases();\n  if (kpopCloneState.paused) return { status: \"paused\", job: kpopPublicCloneState() };",
  "pause claim guard",
);

const pauseMarker = "function kpopTakeLease(leaseId) {";
const pauseFunctions = String.raw`function kpopPauseCloneJob(payload = {}) {
  if (kpopCloneState.status !== "running") return kpopPublicCloneState();
  kpopCloneState.paused = true;
  kpopCloneState.pauseReason = String(payload?.reason || "human_verification").slice(0, 200);
  kpopCloneState.pausedAt = new Date().toISOString();
  kpopSaveCloneState();
  console.log("CLONE JOB PAUSED " + kpopCloneState.rootTitle + " reason=" + kpopCloneState.pauseReason);
  return kpopPublicCloneState();
}

function kpopResumeCloneJob() {
  if (kpopCloneState.status !== "running") return kpopPublicCloneState();
  kpopCloneState.paused = false;
  kpopCloneState.pauseReason = "";
  kpopCloneState.pausedAt = null;
  const renewedUntil = new Date(Date.now() + KPOP_CLONE_LEASE_MS).toISOString();
  kpopCloneState.leases = kpopCloneState.leases.map((lease) => ({ ...lease, leaseUntil: renewedUntil }));
  kpopSaveCloneState();
  console.log("CLONE JOB RESUMED " + kpopCloneState.rootTitle);
  return kpopPublicCloneState();
}

`;
v8 = mustReplace(v8, pauseMarker, pauseFunctions + pauseMarker, "pause resume clone functions");

const cancelRouteMarkerForPause = String.raw`    if (req.method === "POST" && url.pathname === "/clone/cancel") {`;
const pauseRoutes = String.raw`    if (req.method === "POST" && url.pathname === "/clone/pause") {
      json(res, 200, { ok: true, job: kpopPauseCloneJob(await kpopReadJson(req)) });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clone/resume") {
      json(res, 200, { ok: true, job: kpopResumeCloneJob() });
      return;
    }

`;
v8 = mustReplace(v8, cancelRouteMarkerForPause, pauseRoutes + cancelRouteMarkerForPause, "pause resume clone routes");

v8 = v8
  .replace('service: "kpoparkive-namu-chrome-capture-helper-v8"', 'service: "kpoparkive-namu-chrome-capture-helper-v10"')
  .replace(
    'Kpoparkive Namu Chrome capture helper v8 (persistent helper-owned clone queue)',
    'Kpoparkive Namu Chrome capture helper v10 (global Namu document registry + crawl policy)',
  );

const tempV8 = path.join(os.tmpdir(), `kpoparkive-namu-v8-global-v10-${process.pid}.mjs`);
fs.writeFileSync(tempV8, v8, "utf8");

const cleanup = () => {
  for (const file of [tempV8, tempCombined]) {
    try { fs.unlinkSync(file); } catch {}
  }
};
process.on("exit", cleanup);

try {
  await import(pathToFileURL(tempV8).href);
} catch (error) {
  cleanup();
  throw error;
}
