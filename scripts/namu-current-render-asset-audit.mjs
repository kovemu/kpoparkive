import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalAssetKey, normalizeAssetName } from "./namu-asset-audit.mjs";

const ROOT_DIR = process.cwd();

function loadEnv(filePath) {
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

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

async function db(pathname, init = {}) {
  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function dbAll(pathname, pageSize = 1000, maxRows = 20000) {
  const rows = [];
  const separator = pathname.includes("?") ? "&" : "?";
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db(`${pathname}${separator}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(batch)) throw new Error(`Expected array response while paging ${pathname}`);
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`Supabase pagination reached ${maxRows} rows for ${pathname}`);
}

function arrayField(meta, key) {
  return Array.isArray(meta?.[key]) ? meta[key] : [];
}

function normalizeMissingFile(value) {
  if (value && typeof value === "object") {
    value = value.fileName || value.filename || value.sourceRef || value.name || "";
  }
  const fileName = normalizeAssetName(value);
  const key = canonicalAssetKey(fileName);
  if (!fileName || !key) return null;
  return { fileName, key, sourceRef: `파일:${fileName}` };
}

function stableMediaKey(value) {
  if (typeof value === "string") return value.normalize("NFKC").trim();
  try { return JSON.stringify(value); } catch { return String(value); }
}

function currentRenderNeeds(doc) {
  const sourceReady = Boolean(doc?.source_namumark_rendered_at && doc?.source_namumark_meta);
  const contentReady = Boolean(doc?.content_namumark_rendered_at && doc?.content_namumark_meta);
  const files = new Map();
  const media = new Map();

  const addFiles = (values) => {
    for (const value of values) {
      const item = normalizeMissingFile(value);
      if (item && !files.has(item.key)) files.set(item.key, item);
    }
  };
  const addMedia = (values) => {
    for (const value of values) {
      const key = stableMediaKey(value);
      if (key && !media.has(key)) media.set(key, value);
    }
  };

  if (sourceReady) {
    addFiles(arrayField(doc.source_namumark_meta, "missingFiles"));
    addMedia(arrayField(doc.source_namumark_meta, "missingMedia"));
  }
  if (contentReady) {
    addFiles(arrayField(doc.content_namumark_meta, "missingFiles"));
    addMedia(arrayField(doc.content_namumark_meta, "missingMedia"));
  }

  return {
    sourceReady,
    contentReady,
    files: [...files.values()],
    media: [...media.values()],
  };
}

function queueKeys(row) {
  return [...new Set([
    canonicalAssetKey(row?.source_ref),
    canonicalAssetKey(row?.label),
    canonicalAssetKey(row?.metadata?.filename),
  ].filter(Boolean))];
}

function storagePathFromResolvedUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const marker = "/storage/v1/object/public/wiki-media/";
    const index = url.pathname.indexOf(marker);
    return index >= 0 ? decodeURIComponent(url.pathname.slice(index + marker.length)) : "";
  } catch {
    return "";
  }
}

function storagePathForQueueRow(row) {
  return String(row?.storage_path || "").trim() || storagePathFromResolvedUrl(row?.resolved_url);
}

function storagePublicUrl(storagePath) {
  const encoded = String(storagePath || "")
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `${SUPABASE_URL}/storage/v1/object/public/wiki-media/${encoded}`;
}

async function verifyStoragePaths(paths, concurrency = 16) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  const existing = new Set();
  const missing = new Set();
  let cursor = 0;

  async function worker() {
    while (cursor < unique.length) {
      const storagePath = unique[cursor++];
      let ok = false;
      try {
        const response = await fetch(storagePublicUrl(storagePath), {
          method: "HEAD",
          cache: "no-store",
          signal: AbortSignal.timeout(5000),
        });
        ok = response.ok;
      } catch {}
      (ok ? existing : missing).add(storagePath);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker()));
  return { existing, missing };
}

async function enqueueMissing(rootTitle, missingUnique) {
  let created = 0;
  let alreadyQueued = 0;

  for (const item of missingUnique) {
    if ((item.queueRows || []).some((row) => row?.status === "unresolved")) {
      alreadyQueued += 1;
      continue;
    }

    const owner = item.owners?.[0];
    if (!owner) continue;
    await db("source_asset_queue?on_conflict=source_document_id,asset_type,source_ref", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        source_document_id: owner.id,
        root_title: rootTitle,
        source_title: owner.sourceTitle,
        asset_type: "image",
        source_ref: item.sourceRef,
        label: item.fileName,
        provider: "namuwiki",
        role: "current_render_missing",
        status: "unresolved",
        metadata: {
          origin: "namu-current-render-asset-audit",
          filename: item.fileName,
          required_by: item.owners.map((entry) => entry.sourceTitle),
        },
      }),
    });
    created += 1;
  }

  return { created, alreadyQueued };
}

export async function runCurrentRenderAssetAudit({
  rootTitle,
  clusterDepth = 1,
  expectedCoreDocuments = null,
  enqueue = false,
} = {}) {
  rootTitle = String(rootTitle || "").normalize("NFKC").trim();
  if (!rootTitle) throw new Error("rootTitle is required");

  const clusterRows = await dbAll(
    `source_document_clusters?root_title=eq.${encodeURIComponent(rootTitle)}` +
      `&min_crawl_depth=eq.${encodeURIComponent(clusterDepth)}` +
      "&select=source_document_id,min_crawl_depth&order=source_document_id.asc",
  );
  const clusterIds = new Set(clusterRows.map((row) => row.source_document_id).filter(Boolean));

  const docs = await dbAll(
    `source_documents?root_title=eq.${encodeURIComponent(rootTitle)}` +
      "&select=id,source_title,root_title,crawl_depth,source_format,source_namumark_meta,source_namumark_rendered_at,content_namumark_meta,content_namumark_rendered_at&order=source_title.asc",
  );
  const coreDocs = docs
    .filter((doc) => clusterIds.has(doc.id) && !String(doc.source_title || "").startsWith("틀:"))
    .sort((a, b) => String(a.source_title).localeCompare(String(b.source_title), "ko"));

  if (expectedCoreDocuments != null && coreDocs.length !== Number(expectedCoreDocuments)) {
    throw new Error(
      `Fixed core scope mismatch for ${rootTitle}: expected ${expectedCoreDocuments}, found ${coreDocs.length}. Refusing to enqueue assets.`
    );
  }

  const needsByDoc = new Map(coreDocs.map((doc) => [doc.id, currentRenderNeeds(doc)]));
  const requiredByKey = new Map();
  for (const doc of coreDocs) {
    const needs = needsByDoc.get(doc.id);
    for (const item of needs.files) {
      const existing = requiredByKey.get(item.key) || { ...item, owners: [] };
      existing.owners.push({ id: doc.id, sourceTitle: doc.source_title });
      requiredByKey.set(item.key, existing);
    }
  }

  const queueRows = await dbAll(
    "source_asset_queue?asset_type=eq.image" +
      "&select=id,root_title,source_document_id,source_title,source_ref,label,status,resolved_url,storage_path,metadata,updated_at&order=id.asc",
  );
  const stagingRows = await dbAll(
    "namu_capture_staging?storage_path=not.is.null" +
      "&select=id,root_title,source_title,file_name,canonical_key,storage_path,content_type,byte_length,captured_at,metadata&order=captured_at.desc",
  );

  const queueByKey = new Map();
  const candidateByKey = new Map();
  const addCandidate = (key, candidate) => {
    if (!key || !requiredByKey.has(key)) return;
    const group = candidateByKey.get(key) || [];
    group.push(candidate);
    candidateByKey.set(key, group);
  };

  for (const row of queueRows) {
    for (const key of queueKeys(row)) {
      if (!requiredByKey.has(key)) continue;
      const group = queueByKey.get(key) || [];
      group.push(row);
      queueByKey.set(key, group);
      const storagePath = storagePathForQueueRow(row);
      if (row.status === "resolved" && storagePath) addCandidate(key, { kind: "queue", storagePath, row });
    }
  }

  for (const row of stagingRows) {
    const fileName = String(row?.file_name || "");
    if (!row?.storage_path || /^__anonymous__/i.test(fileName)) continue;
    const key = canonicalAssetKey(row?.canonical_key || fileName);
    addCandidate(key, { kind: "staging", storagePath: row.storage_path, row });
  }

  const candidatePaths = [...candidateByKey.values()].flatMap((rows) => rows.map((row) => row.storagePath));
  const storage = await verifyStoragePaths(candidatePaths);

  const missingUnique = [];
  const globallyReusable = [];
  for (const item of requiredByKey.values()) {
    const candidates = (candidateByKey.get(item.key) || []).filter((candidate) => storage.existing.has(candidate.storagePath));
    if (candidates.length) {
      globallyReusable.push({
        fileName: item.fileName,
        requiredBy: item.owners.map((owner) => owner.sourceTitle),
        storagePaths: [...new Set(candidates.map((candidate) => candidate.storagePath))],
      });
      continue;
    }
    missingUnique.push({
      ...item,
      queueRows: queueByKey.get(item.key) || [],
    });
  }

  const enqueueResult = enqueue ? await enqueueMissing(rootTitle, missingUnique) : null;
  const documents = coreDocs.map((doc) => {
    const needs = needsByDoc.get(doc.id);
    return {
      sourceTitle: doc.source_title,
      sourceFormat: doc.source_format,
      sourceRenderReady: needs.sourceReady,
      englishRenderReady: needs.contentReady,
      currentMissingFiles: needs.files.map((item) => item.fileName),
      currentMissingMedia: needs.media,
    };
  });

  const sourceRenderReady = documents.filter((doc) => doc.sourceRenderReady).length;
  const englishRenderReady = documents.filter((doc) => doc.englishRenderReady).length;
  const noCurrentRender = documents.filter((doc) => !doc.sourceRenderReady && !doc.englishRenderReady).length;
  const missingMediaReferences = documents.reduce((sum, doc) => sum + doc.currentMissingMedia.length, 0);

  return {
    rootTitle,
    scope: "cluster-current-render",
    clusterDepth,
    expectedCoreDocuments,
    coreDocuments: coreDocs.length,
    renderReadiness: {
      sourceRenderReady,
      englishRenderReady,
      noCurrentRender,
    },
    totals: {
      currentMissingFileReferences: documents.reduce((sum, doc) => sum + doc.currentMissingFiles.length, 0),
      currentMissingUniqueFiles: requiredByKey.size,
      globallyReusableUniqueFiles: globallyReusable.length,
      captureRequiredUniqueFiles: missingUnique.length,
      currentMissingMediaReferences: missingMediaReferences,
      verifiedStoragePaths: storage.existing.size,
      staleStoragePaths: storage.missing.size,
    },
    enqueue: enqueueResult,
    globallyReusableFiles: globallyReusable,
    missingUniqueFiles: missingUnique.map((item) => ({
      fileName: item.fileName,
      requiredBy: item.owners.map((owner) => owner.sourceTitle),
      existingQueueStatuses: [...new Set((item.queueRows || []).map((row) => row.status).filter(Boolean))],
    })),
    missingMedia: documents
      .filter((doc) => doc.currentMissingMedia.length)
      .map((doc) => ({ sourceTitle: doc.sourceTitle, items: doc.currentMissingMedia })),
    staleStoragePaths: [...storage.missing].sort(),
    documents,
  };
}

async function main() {
  const rootTitle = decodeURIComponent(process.argv[2] || "").normalize("NFKC").trim();
  const depthArg = process.argv.find((arg) => arg.startsWith("--cluster-depth="));
  const expectedArg = process.argv.find((arg) => arg.startsWith("--expected-core="));
  const clusterDepth = depthArg ? Number(depthArg.split("=")[1]) : 1;
  const expectedCoreDocuments = expectedArg ? Number(expectedArg.split("=")[1]) : null;
  const enqueue = process.argv.includes("--enqueue");
  const result = await runCurrentRenderAssetAudit({ rootTitle, clusterDepth, expectedCoreDocuments, enqueue });
  console.log(JSON.stringify(result, null, 2));
  if (result.totals.captureRequiredUniqueFiles > 0 || result.totals.currentMissingMediaReferences > 0) process.exitCode = 2;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
