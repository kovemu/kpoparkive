"use client";

import { useEffect, useState } from "react";

const ADMIN_KEY_STORAGE = "kpoparkive:namu-admin-key";

export default function NamuImportPage() {
  const [adminKey, setAdminKey] = useState("");
  const [rootTitle, setRootTitle] = useState("RESCENE");
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxDocuments, setMaxDocuments] = useState(80);
  const [status, setStatus] = useState("Ready.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(ADMIN_KEY_STORAGE);
      if (saved) setAdminKey(saved);
    } catch {
      // Storage can be unavailable in private/restricted browser contexts.
    }
  }, []);

  useEffect(() => {
    if (!adminKey) return;
    try {
      window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey);
    } catch {
      // Ignore storage failures; the current session still works.
    }
  }, [adminKey]);

  const commonHeaders = { "Content-Type": "application/json", "x-admin-key": adminKey };

  function forgetAdminKey() {
    try {
      window.localStorage.removeItem(ADMIN_KEY_STORAGE);
    } catch {
      // Ignore storage failures.
    }
    setAdminKey("");
    setStatus("Saved admin key cleared from this browser.");
  }

  async function crawl() {
    const response = await fetch("/api/admin/namu-import", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ rootTitle, maxDepth, maxDocuments }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Import failed");
    return result;
  }

  async function parse(force = false) {
    const response = await fetch("/api/admin/namu-process", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ rootTitle, force }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Parse failed");
    return result;
  }

  async function resolveAssets() {
    let totalProcessed = 0;
    let totalResolved = 0;
    let unresolved = 0;
    let remaining = 1;
    let batches = 0;

    while (remaining > 0 && batches < 100) {
      const response = await fetch("/api/admin/namu-assets", {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ rootTitle, batchSize: 30 }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Asset resolution failed");
      totalProcessed += Number(result.processed || 0);
      totalResolved += Number(result.resolved || 0);
      unresolved += Array.isArray(result.unresolved) ? result.unresolved.length : 0;
      remaining = Number(result.remaining || 0);
      batches += 1;
      setStatus(`Resolving assets... ${totalProcessed} processed / ${totalResolved} resolved / ${unresolved} unresolved / ${remaining} pending`);
      if (result.processed === 0) break;
    }

    return { batches, processed: totalProcessed, resolved: totalResolved, unresolved, remaining };
  }

  async function runImportAndParse() {
    setBusy(true);
    try {
      setStatus("Step 1/3: crawling and auto-discovering the group document graph...");
      const importResult = await crawl();
      setStatus(`Step 1/3 complete: ${importResult.fetched} documents fetched, ${importResult.autoDiscovered ?? 0} related documents auto-discovered.\nStep 2/3: rebuilding structured content and asset queue...`);
      const parseResult = await parse(true);
      setStatus(`Step 2/3 complete: ${parseResult.totalQueuedAssets ?? 0} asset references queued.\nStep 3/3: resolving images, videos and links...`);
      const assetResult = await resolveAssets();
      setStatus(JSON.stringify({
        import: importResult,
        parse: parseResult,
        assets: assetResult,
        next: "Automatic import is complete. Unresolved image references are ready for web enrichment; documents are ready for ChatGPT localization.",
      }, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pipeline failed");
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setStatus("Crawling mirror document graph with automatic relation discovery...");
    try {
      setStatus(JSON.stringify(await crawl(), null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function runParse() {
    setBusy(true);
    setStatus("Rebuilding stored mirror snapshots and asset queue with the latest parser...");
    try {
      setStatus(JSON.stringify(await parse(true), null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Parse failed");
    } finally {
      setBusy(false);
    }
  }

  async function runResolveAssets() {
    setBusy(true);
    setStatus("Resolving queued assets...");
    try {
      setStatus(JSON.stringify(await resolveAssets(), null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Asset resolution failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="adminShell">
      <section className="adminPanel">
        <h1>Namu mirror importer</h1>
        <p className="adminIntro">Enter only the root group document. The importer discovers closely related documents, rebuilds a rich document AST, and automatically resolves available images, embedded videos, and links. Only unresolved assets remain for web enrichment.</p>
        <div className="adminForm">
          <label>
            Admin key
            <input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="current-password" />
            <small>Saved only in this browser after you enter it once.</small>
          </label>
          <button type="button" disabled={busy || !adminKey} onClick={forgetAdminKey}>Forget saved admin key</button>
          <label>Root document<input value={rootTitle} onChange={(e) => setRootTitle(e.target.value)} /></label>
          <label>Max depth<input type="number" min={0} max={4} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></label>
          <label>Max documents<input type="number" min={1} max={200} value={maxDocuments} onChange={(e) => setMaxDocuments(Number(e.target.value))} /></label>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImportAndParse}>{busy ? "Working..." : "Run full import pipeline"}</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImport}>Crawl only</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runParse}>Re-parse + rebuild asset queue</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runResolveAssets}>Resolve queued assets</button>
        </div>
        <pre className="adminStatus">{status}</pre>
      </section>
    </main>
  );
}
