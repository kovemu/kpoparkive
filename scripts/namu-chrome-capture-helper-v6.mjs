import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const basePath = path.resolve("scripts/namu-chrome-capture-helper-combined.mjs");
const base = fs.readFileSync(basePath, "utf8");

const expectedVersion = 'const DOCUMENT_CAPTURE_VERSION = "chrome-rendered-artifact-v2";';
const expectedRootGuard = 'if (!/<(?:article|main)\\b/i.test(articleHtml)) throw new Error("rendered capture does not contain an article/main root");';
if (!base.includes(expectedVersion) || !base.includes(expectedRootGuard)) {
  throw new Error("Browser capture helper base changed; v6 compatibility patch no longer matches.");
}

const patched = base
  .replace(expectedVersion, 'const DOCUMENT_CAPTURE_VERSION = "chrome-rendered-artifact-v3";')
  .replace(
    expectedRootGuard,
    'if (!/data-kpop-capture-root=["\\\']true["\\\']/i.test(articleHtml) && !/<(?:article|main)\\b/i.test(articleHtml)) throw new Error("rendered capture does not contain a trusted captured content root");',
  )
  .replace("Kpoparkive Namu Chrome capture helper v5", "Kpoparkive Namu Chrome capture helper v6");

const tempPath = path.join(os.tmpdir(), `kpoparkive-namu-capture-v6-${process.pid}.mjs`);
fs.writeFileSync(tempPath, patched, "utf8");

const cleanup = () => {
  try { fs.unlinkSync(tempPath); } catch {}
};
process.on("exit", cleanup);

try {
  await import(pathToFileURL(tempPath).href);
} catch (error) {
  cleanup();
  throw error;
}
