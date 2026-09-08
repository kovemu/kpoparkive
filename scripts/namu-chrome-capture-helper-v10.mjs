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

const oldEnsureQuery = String.raw`  const docs = await db(
    `source_documents?source=eq.namu_mirror` +
    `&root_title=eq.${encodeURIComponent(rootTitle)}` +
    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +
    `&select=id,source_title,root_title&limit=1`,
  );`;
const newEnsureQuery = String.raw`  const docs = await db(
    `source_documents?source=eq.namu_mirror` +
    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +
    `&select=id,source_title,root_title&limit=1`,
  );`;
combined = mustReplace(combined, oldEnsureQuery, newEnsureQuery, "global ensureSourceDocument lookup");

const saveMarker = "async function saveRenderedDocument(payload) {";
const registryHelpers = String.raw`
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
        body: JSON.stringify({ min_crawl_depth: Math.min(Number(existing[0].min_crawl_depth || 0), depth), last_seen_at: new Date().toISOString() }),
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

  const targetTitles = [...new Set(cleaned.map((link) => link.title))];
  for (const title of targetTitles.slice(0, 300)) {
    const targets = await db(
      `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=id&limit=1`
    );
    if (!targets?.[0]?.id) continue;
    await db(
      `source_document_links?from_document_id=eq.${encodeURIComponent(fromDocumentId)}&to_source_title=eq.${encodeURIComponent(title)}`,
      { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ to_document_id: targets[0].id, last_seen_at: now }) },
    );
  }
}

async function backfillIncomingDocumentLinks(sourceTitle, sourceDocumentId) {
  if (!sourceTitle || !sourceDocumentId) return;
  await db(
    `source_document_links?to_source_title=eq.${encodeURIComponent(sourceTitle)}&to_document_id=is.null`,
    { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ to_document_id: sourceDocumentId, last_seen_at: new Date().toISOString() }) },
  );
}

`;
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
    "&select=id,source_title,source_url,crawl_depth,discovered_links,source_browser_captured_at,source_browser_capture_version&limit=1"
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
  }
}

`;
v8 = mustReplace(v8, takeLeaseMarker, serializedClaim + takeLeaseMarker, "serialized claim wrapper");

const oldSkip = String.raw`    if (existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION) {
      kpopCloneState.processed += 1;`;
const newSkip = String.raw`    const capturedAtMs = Date.parse(existing?.source_browser_captured_at || "");
    const capturedAfterAdFilter = Number.isFinite(capturedAtMs) && capturedAtMs >= Date.parse("2026-09-08T16:30:00Z");
    if (existing?.source_browser_captured_at && existing?.source_browser_capture_version === DOCUMENT_CAPTURE_VERSION && capturedAfterAdFilter) {
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
            body: JSON.stringify({ root_title: kpopCloneState.rootTitle, source_document_id: existing.id, min_crawl_depth: item.depth }),
          });
        }
      }
      kpopCloneState.processed += 1;`;
v8 = mustReplace(v8, oldSkip, newSkip, "global reuse membership + ad refresh");

v8 = v8
  .replace('service: "kpoparkive-namu-chrome-capture-helper-v8"', 'service: "kpoparkive-namu-chrome-capture-helper-v10"')
  .replace('Kpoparkive Namu Chrome capture helper v8 (persistent helper-owned clone queue)', 'Kpoparkive Namu Chrome capture helper v10 (global Namu document registry)');

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
