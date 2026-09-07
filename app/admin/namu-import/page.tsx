"use client";

import { useState } from "react";

export default function NamuImportPage() {
  const [adminKey, setAdminKey] = useState("");
  const [rootTitle, setRootTitle] = useState("RESCENE");
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxDocuments, setMaxDocuments] = useState(80);
  const [status, setStatus] = useState("Ready.");
  const [busy, setBusy] = useState(false);

  const commonHeaders = { "Content-Type": "application/json", "x-admin-key": adminKey };

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

  async function runImportAndParse() {
    setBusy(true);
    try {
      setStatus("Step 1/2: crawling and auto-discovering the group document graph...");
      const importResult = await crawl();
      setStatus(`Step 1/2 complete: ${importResult.fetched} documents fetched, ${importResult.autoDiscovered ?? 0} related documents auto-discovered.\nStep 2/2: parsing structure and asset refs...`);
      const parseResult = await parse(true);
      setStatus(JSON.stringify({
        import: importResult,
        parse: parseResult,
        next: "The document graph and asset queue are ready for automatic enrichment and ChatGPT localization.",
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
    setStatus("Parsing stored mirror snapshots into structured sections and asset refs...");
    try {
      setStatus(JSON.stringify(await parse(true), null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Parse failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="adminShell">
      <section className="adminPanel">
        <h1>Namu mirror importer</h1>
        <p className="adminIntro">Enter only the root group document. The importer automatically follows group subdocuments and detects member, discography, activity, and other closely related documents from the page context.</p>
        <div className="adminForm">
          <label>Admin key<input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} /></label>
          <label>Root document<input value={rootTitle} onChange={(e) => setRootTitle(e.target.value)} /></label>
          <label>Max depth<input type="number" min={0} max={4} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></label>
          <label>Max documents<input type="number" min={1} max={200} value={maxDocuments} onChange={(e) => setMaxDocuments(Number(e.target.value))} /></label>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImportAndParse}>{busy ? "Working..." : "Crawl + parse for ChatGPT"}</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImport}>Crawl only</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runParse}>Re-parse stored snapshots</button>
        </div>
        <pre className="adminStatus">{status}</pre>
      </section>
    </main>
  );
}
