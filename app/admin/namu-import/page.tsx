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
    } catch {}
  }, []);

  useEffect(() => {
    if (!adminKey) return;
    try { window.localStorage.setItem(ADMIN_KEY_STORAGE, adminKey); } catch {}
  }, [adminKey]);

  const commonHeaders = { "Content-Type": "application/json", "x-admin-key": adminKey };
  const hybridPreviewHref = `/admin/namu-hybrid-preview/${encodeURIComponent(rootTitle)}`;

  function forgetAdminKey() {
    try { window.localStorage.removeItem(ADMIN_KEY_STORAGE); } catch {}
    setAdminKey("");
    setStatus("Saved admin key cleared from this browser.");
  }

  async function crawl() {
    const response = await fetch("/api/admin/namu-import", { method: "POST", headers: commonHeaders, body: JSON.stringify({ rootTitle, maxDepth, maxDocuments }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Import failed");
    return result;
  }

  async function parse(force = false) {
    const response = await fetch("/api/admin/namu-process", { method: "POST", headers: commonHeaders, body: JSON.stringify({ rootTitle, force }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Parse failed");
    return result;
  }

  async function extractRaw(force = false) {
    const response = await fetch("/api/admin/namu-raw-extract", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ rootTitle, force }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "RAW/Hybrid extraction failed");
    return result;
  }

  async function resolveAssets(retryUnresolved = false) {
    let totalProcessed = 0;
    let totalResolved = 0;
    let totalSkipped = 0;
    let unresolved = 0;
    let remaining = 1;
    let batches = 0;

    while (remaining > 0 && batches < 100) {
      const response = await fetch("/api/admin/namu-assets", {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ rootTitle, batchSize: 30, retryUnresolved }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Asset resolution failed");
      totalProcessed += Number(result.processed || 0);
      totalResolved += Number(result.resolved || 0);
      totalSkipped += Number(result.skipped || 0);
      unresolved += Array.isArray(result.unresolved) ? result.unresolved.length : 0;
      remaining = Number(result.remaining || 0);
      batches += 1;
      setStatus(`Step 4/4: resolving assets... ${totalProcessed} processed / ${totalResolved} resolved / ${totalSkipped} skipped / ${unresolved} unresolved / ${remaining} pending`);
      if (result.processed === 0) break;
      if (retryUnresolved) break;
    }

    return { batches, processed: totalProcessed, resolved: totalResolved, skipped: totalSkipped, unresolved, remaining };
  }

  async function hydrateDrafts() {
    const response = await fetch("/api/admin/namu-hydrate", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({ rootTitle }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Draft hydration failed");
    return result;
  }

  async function runImportAndParse() {
    setBusy(true);
    try {
      setStatus("Step 1/4: crawling and auto-discovering the K-pop document graph...");
      const importResult = await crawl();

      setStatus(`Step 1/4 complete: ${importResult.fetched} documents fetched, ${importResult.autoDiscovered ?? 0} related documents auto-discovered.\nStep 2/4: rebuilding compatibility AST and baseline asset queue...`);
      const parseResult = await parse(true);

      // RAW recovery intentionally runs AFTER the compatibility parser because
      // namu-process rebuilds the asset queue. This lets raw-only image refs and
      // linked-document hints augment the queue instead of being deleted by it.
      setStatus(`Step 2/4 complete: ${parseResult.totalQueuedAssets ?? 0} baseline asset references queued.\nStep 3/4: recovering source-order RAW/Hybrid Namu syntax...`);
      const rawResult = await extractRaw(true);

      setStatus(`Step 3/4 complete: ${rawResult.rawBlocks ?? 0} raw blocks recovered, ${rawResult.queuedImages ?? 0} raw-only images added, estimated RAW coverage ${rawResult.estimatedRawCoverage ?? 0}%.\nStep 4/4: resolving images/videos and classifying links...`);
      const assetResult = await resolveAssets(false);

      setStatus(JSON.stringify({
        import: importResult,
        compatibilityParse: parseResult,
        rawHybrid: rawResult,
        assets: assetResult,
        preview: hybridPreviewHref,
        next: "Reusable import complete. Hybrid RAW is canonical for visual reconstruction; compatibility AST remains only for the current localization/draft path.",
      }, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pipeline failed");
    } finally { setBusy(false); }
  }

  async function runImport() {
    setBusy(true);
    setStatus("Crawling mirror document graph with automatic relation discovery...");
    try { setStatus(JSON.stringify(await crawl(), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Import failed"); }
    finally { setBusy(false); }
  }

  async function runParse() {
    setBusy(true);
    setStatus("Rebuilding compatibility AST and baseline asset queue...");
    try { setStatus(JSON.stringify(await parse(true), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Parse failed"); }
    finally { setBusy(false); }
  }

  async function runRawExtract() {
    setBusy(true);
    setStatus("Recovering source-order RAW/Hybrid syntax and augmenting raw-only image references...");
    try { setStatus(JSON.stringify(await extractRaw(true), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "RAW/Hybrid extraction failed"); }
    finally { setBusy(false); }
  }

  async function runResolveAssets() {
    setBusy(true);
    setStatus("Retrying enriched images and classifying unresolved internal links...");
    try { setStatus(JSON.stringify(await resolveAssets(true), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Asset resolution failed"); }
    finally { setBusy(false); }
  }

  async function runHydrateDrafts() {
    setBusy(true);
    setStatus("Applying resolved media and links to translated draft pages...");
    try { setStatus(JSON.stringify(await hydrateDrafts(), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Draft hydration failed"); }
    finally { setBusy(false); }
  }

  return (
    <main className="adminShell">
      <section className="adminPanel">
        <h1>Namu mirror importer</h1>
        <p className="adminIntro">This is the reusable document pipeline, not a RESCENE-only tool. Enter a root K-pop document and the importer crawls its bounded relation graph, rebuilds the legacy compatibility AST, recovers the source-order RAW/Hybrid representation, augments raw-only media references, and resolves assets. The Hybrid RAW representation is now the canonical input for Namu-faithful rendering.</p>
        <div className="adminForm">
          <label>Admin key<input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="current-password" /><small>Saved only in this browser after you enter it once.</small></label>
          <button type="button" disabled={busy || !adminKey} onClick={forgetAdminKey}>Forget saved admin key</button>
          <label>Root document<input value={rootTitle} onChange={(e) => setRootTitle(e.target.value)} /></label>
          <label>Max depth<input type="number" min={0} max={4} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></label>
          <label>Max documents<input type="number" min={1} max={200} value={maxDocuments} onChange={(e) => setMaxDocuments(Number(e.target.value))} /></label>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImportAndParse}>{busy ? "Working..." : "Run reusable RAW/Hybrid import pipeline"}</button>
          <a href={hybridPreviewHref} target="_blank" rel="noreferrer">Open Hybrid preview</a>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImport}>1. Crawl only</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runParse}>2. Rebuild compatibility AST</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runRawExtract}>3. Rebuild RAW/Hybrid source</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runResolveAssets}>4. Retry asset resolution</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runHydrateDrafts}>Apply resolved assets to translated drafts</button>
        </div>
        <pre className="adminStatus">{status}</pre>
      </section>
    </main>
  );
}
