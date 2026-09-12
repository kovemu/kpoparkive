import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT_DIR = process.cwd();

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

export function normalizeAssetName(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[ \t]+/g, " ");
}

export function canonicalAssetKey(value) {
  return normalizeAssetName(value).toLowerCase();
}

export function selectCoreRawDocuments(rows, maxDepth = 1) {
  return (rows || [])
    .filter((row) =>
      row?.source_format === "namuwiki_raw" &&
      !String(row?.source_title || "").startsWith("틀:") &&
      Number(row?.crawl_depth ?? 999) <= maxDepth
    )
    .sort((a, b) => String(a.source_title).localeCompare(String(b.source_title), "ko"));
}

export function requiredFilesForDocument(row) {
  const raw = Array.isArray(row?.source_namumark_meta?.requiredFiles)
    ? row.source_namumark_meta.requiredFiles
    : [];
  const seen = new Set();
  const output = [];
  for (const value of raw) {
    const fileName = normalizeAssetName(value);
    const key = canonicalAssetKey(fileName);
    if (!fileName || !key || seen.has(key)) continue;
    seen.add(key);
    output.push({ fileName, key, sourceRef: `파일:${fileName}` });
  }
  return output;
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

function queueKeys(row) {
  return [...new Set([
    canonicalAssetKey(row?.source_ref),
    canonicalAssetKey(row?.label),
    canonicalAssetKey(row?.metadata?.filename),
  ].filter(Boolean))];
}

function addIndex(map, key, value) {
  if (!key) return;
  const group = map.get(key) || [];
  group.push(value);
  map.set(key, group);
}

export function buildAssetAudit(coreDocs, queueRows, stagingRows) {
  const queueByKey = new Map();
  const availableByKey = new Map();

  for (const row of queueRows || []) {
    for (const key of queueKeys(row)) {
      addIndex(queueByKey, key, row);
      const storagePath = storagePathForQueueRow(row);
      if (row?.status === "resolved" && storagePath) {
        addIndex(availableByKey, key, { kind: "queue", storagePath, row });
      }
    }
  }

  for (const row of stagingRows || []) {
    const fileName = String(row?.file_name || "");
    if (!row?.storage_path || /^__anonymous__/i.test(fileName)) continue;
    const key = canonicalAssetKey(row?.canonical_key || fileName);
    if (!key) continue;
    addIndex(availableByKey, key, { kind: "staging", storagePath: row.storage_path, row });
  }

  const documents = [];
  const missingUnique = new Map();
  const duplicatePaths = new Map();

  for (const doc of coreDocs || []) {
    const required = requiredFilesForDocument(doc);
    let available = 0;
    const missing = [];

    for (const item of required) {
      const candidates = availableByKey.get(item.key) || [];
      const paths = [...new Set(candidates.map((candidate) => candidate.storagePath).filter(Boolean))];
      if (paths.length) {
        available += 1;
        if (paths.length > 1) duplicatePaths.set(item.key, { fileName: item.fileName, paths });
        continue;
      }

      missing.push(item.fileName);
      const existing = missingUnique.get(item.key) || {
        key: item.key,
        fileName: item.fileName,
        sourceRef: item.sourceRef,
        owners: [],
        queueRows: queueByKey.get(item.key) || [],
      };
      existing.owners.push({ id: doc.id, sourceTitle: doc.source_title });
      missingUnique.set(item.key, existing);
    }

    documents.push({
      sourceTitle: doc.source_title,
      required: required.length,
      available,
      missing: missing.length,
      missingFiles: missing,
    });
  }

  return {
    documents,
    missingUnique: [...missingUnique.values()].sort((a, b) => a.fileName.localeCompare(b.fileName, "ko")),
    duplicatePaths: [...duplicatePaths.values()].sort((a, b) => a.fileName.localeCompare(b.fileName, "ko")),
  };
}

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

async function enqueueMissing(rootTitle, audit) {
  let created = 0;
  let requeued = 0;
  let alreadyQueued = 0;

  for (const item of audit.missingUnique) {
    const existing = (item.queueRows || []).find((row) => row?.id);
    if (existing) {
      if (existing.status === "unresolved") {
        alreadyQueued += 1;
        continue;
      }
      await db(`source_asset_queue?id=eq.${encodeURIComponent(existing.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          status: "unresolved",
          storage_path: null,
          resolved_url: null,
          metadata: {
            ...(existing.metadata && typeof existing.metadata === "object" ? existing.metadata : {}),
            origin: "namu-asset-audit",
            filename: item.fileName,
            required_by: item.owners.map((owner) => owner.sourceTitle),
            requeued_at: new Date().toISOString(),
          },
          updated_at: new Date().toISOString(),
        }),
      });
      requeued += 1;
      continue;
    }

    const owner = item.owners[0];
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
        role: "raw_required",
        status: "unresolved",
        metadata: {
          origin: "namu-asset-audit",
          filename: item.fileName,
          required_by: item.owners.map((entry) => entry.sourceTitle),
        },
      }),
    });
    created += 1;
  }

  return { created, requeued, alreadyQueued };
}

export async function runAssetAudit({ rootTitle = "RESCENE", maxDepth = 1, enqueue = false } = {}) {
  const docs = await dbAll(
    `source_documents?root_title=eq.${encodeURIComponent(rootTitle)}` +
      "&select=id,source_title,root_title,crawl_depth,source_format,source_namumark_meta&order=source_title.asc",
  );
  const coreDocs = selectCoreRawDocuments(docs, maxDepth);
  const queueRows = await dbAll(
    "source_asset_queue?asset_type=eq.image" +
      "&select=id,root_title,source_document_id,source_title,source_ref,label,status,resolved_url,storage_path,metadata,updated_at&order=id.asc",
  );
  const stagingRows = await dbAll(
    "namu_capture_staging?storage_path=not.is.null" +
      "&select=id,root_title,source_title,file_name,canonical_key,storage_path,content_type,byte_length,captured_at,metadata&order=captured_at.desc",
  );

  const audit = buildAssetAudit(coreDocs, queueRows, stagingRows);
  const enqueueResult = enqueue ? await enqueueMissing(rootTitle, audit) : null;
  const totals = audit.documents.reduce((acc, row) => {
    acc.required += row.required;
    acc.available += row.available;
    acc.missingReferences += row.missing;
    return acc;
  }, { required: 0, available: 0, missingReferences: 0 });

  return {
    rootTitle,
    maxDepth,
    coreDocuments: coreDocs.length,
    totals: {
      ...totals,
      missingUniqueFiles: audit.missingUnique.length,
      duplicateCanonicalKeys: audit.duplicatePaths.length,
    },
    enqueue: enqueueResult,
    documents: audit.documents,
    missingUniqueFiles: audit.missingUnique.map((item) => ({
      fileName: item.fileName,
      requiredBy: item.owners.map((owner) => owner.sourceTitle),
      existingQueueStatuses: [...new Set((item.queueRows || []).map((row) => row.status).filter(Boolean))],
    })),
    duplicateCanonicalKeys: audit.duplicatePaths,
  };
}

async function main() {
  const rootTitle = decodeURIComponent(process.argv[2] || "RESCENE").normalize("NFKC").trim();
  const maxDepthArg = process.argv.find((arg) => arg.startsWith("--max-depth="));
  const maxDepth = maxDepthArg ? Number(maxDepthArg.split("=")[1]) : 1;
  const enqueue = process.argv.includes("--enqueue");
  const result = await runAssetAudit({ rootTitle, maxDepth, enqueue });
  console.log(JSON.stringify(result, null, 2));
  if (result.totals.missingUniqueFiles > 0) process.exitCode = 2;
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invoked === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  });
}
