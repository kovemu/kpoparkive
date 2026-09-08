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
  const rawPreviewHref = `/admin/namu-raw-preview/${encodeURIComponent(rootTitle)}`;

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
    if (!response.ok) throw new Error(result.error || "DOM/RAW render artifact extraction failed");
    return result;
  }

  async function resolveAssets(retryUnresolved = false) {
    let totalProcessed = 0;
    let totalResolved = 0;
    let totalSkipped = 0;
    let unresolved = 0;
    let remaining = 1;
    let batches = 0;

    // The server deliberately keeps each request small enough for Vercel's
    // function duration. The browser continues issuing safe batches until the
    // pending queue is actually drained, so one normal Import click is enough.
    while (remaining > 0 && batches < 1000) {
      const response = await fetch("/api/admin/namu-assets", {
        method: "POST",
        headers: commonHeaders,
        body: JSON.stringify({ rootTitle, batchSize: 12, retryUnresolved }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Asset resolution failed");
      totalProcessed += Number(result.processed || 0);
      totalResolved += Number(result.resolved || 0);
      totalSkipped += Number(result.skipped || 0);
      unresolved += Array.isArray(result.unresolved) ? result.unresolved.length : 0;
      remaining = Number(result.remaining || 0);
      batches += 1;
      setStatus(`Step 4/4: resolving assets... ${totalProcessed} processed / ${totalResolved} resolved / ${totalSkipped} skipped / ${unresolved} unresolved / ${remaining >= 1000 ? "1000+" : remaining} pending`);
      if (result.processed === 0) break;
      // Manual retry intentionally performs one pass so permanently broken
      // unresolved rows cannot loop forever. Normal imports drain all pending.
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
      setStatus("Step 1/4: crawling graph and capturing raw_html + article DOM skeleton + RAW fragments + template CSS + rendered media map...");
      const importResult = await crawl();

      setStatus(`Step 1/4 complete: ${importResult.fetched} documents fetched, ${importResult.templateStyles ?? 0} template style blocks captured, ${importResult.renderedFiles ?? 0} rendered files mapped, ${importResult.clusterAssetHints ?? 0} cluster asset hints connected.\nStep 2/4: rebuilding the compatibility/localization AST without deleting importer artifacts...`);
      const parseResult = await parse(true);

      setStatus(`Step 2/4 complete: ${parseResult.totalQueuedAssets ?? 0} missing compatibility references added without replacing importer assets.\nStep 3/4: backfilling legacy DOM/RAW render artifacts where needed...`);
      const rawResult = await extractRaw(false);

      setStatus(`Step 3/4 complete: ${rawResult.extracted ?? 0} legacy documents upgraded, ${rawResult.rawBlocks ?? 0} raw blocks recovered, ${rawResult.styleBlocks ?? 0} style blocks captured, ${rawResult.clusterAssetHints ?? 0} cluster media hints connected.\nStep 4/4: resolving and validating images/videos and classifying links...`);
      const assetResult = await resolveAssets(false);

      setStatus(JSON.stringify({
        import: importResult,
        compatibilityParse: parseResult,
        domRawBackfill: rawResult,
        assets: assetResult,
        preview: rawPreviewHref,
        next: "Reusable import complete. Rendered DOM is the layout skeleton; RAW Namu fragments provide unresolved semantics; template CSS and cluster media mappings are captured by the importer.",
      }, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pipeline failed");
    } finally { setBusy(false); }
  }

  async function runImport() {
    setBusy(true);
    setStatus("Crawling mirror graph and capturing DOM skeleton + RAW + template CSS + media maps...");
    try { setStatus(JSON.stringify(await crawl(), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Import failed"); }
    finally { setBusy(false); }
  }

  async function runParse() {
    setBusy(true);
    setStatus("Rebuilding compatibility/localization AST without replacing importer-owned assets...");
    try { setStatus(JSON.stringify(await parse(true), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "Parse failed"); }
    finally { setBusy(false); }
  }

  async function runRawExtract() {
    setBusy(true);
    setStatus("Rebuilding DOM skeleton + RAW fragments + template CSS + render manifest for this imported cluster...");
    try { setStatus(JSON.stringify(await extractRaw(true), null, 2)); }
    catch (error) { setStatus(error instanceof Error ? error.message : "DOM/RAW artifact extraction failed"); }
    finally { setBusy(false); }
  }

  async function runResolveAssets() {
    setBusy(true);
    setStatus("Retrying unresolved assets with strict payload validation...");
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
        <p className="adminIntro">Reusable K-pop mirror pipeline. Normal operation is one Import click followed by Preview. Individual stages are kept only for debugging and recovery.</p>
        <div className="adminForm">
          <label>Admin key<input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} autoComplete="current-password" /><small>Saved only in this browser after you enter it once.</small></label>
          <button type="button" disabled={busy || !adminKey} onClick={forgetAdminKey}>Forget saved admin key</button>
          <label>Root document<input value={rootTitle} onChange={(e) => setRootTitle(e.target.value)} /></label>
          <label>Max depth<input type="number" min={0} max={4} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></label>
          <label>Max documents<input type="number" min={1} max={200} value={maxDocuments} onChange={(e) => setMaxDocuments(Number(e.target.value))} /></label>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImportAndParse}>{busy ? "Working..." : `Import ${rootTitle || "document"}`}</button>
          <a href={rawPreviewHref} target="_blank" rel="noreferrer">Open DOM/RAW preview</a>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 700, margin: "10px 0" }}>Advanced / Debug tools</summary>
            <div className="adminForm">
              <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImport}>1. Crawl only</button>
              <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runParse}>2. Rebuild compatibility AST</button>
              <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runRawExtract}>3. Force rebuild DOM/RAW artifacts</button>
              <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runResolveAssets}>4. Retry unresolved assets</button>
              <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runHydrateDrafts}>Apply resolved assets to translated drafts</button>
            </div>
          </details>
        </div>
        <pre className="adminStatus">{status}</pre>
      </section>
    </main>
  );
}
