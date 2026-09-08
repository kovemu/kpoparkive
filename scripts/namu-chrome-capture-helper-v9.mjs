import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const basePath = path.resolve("scripts/namu-chrome-capture-helper-v8.mjs");
const base = fs.readFileSync(basePath, "utf8");

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

if (!base.includes(oldBlock)) throw new Error("v8 helper changed; v9 known-media patch no longer matches");
const patched = base.replace(oldBlock, newBlock);
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
