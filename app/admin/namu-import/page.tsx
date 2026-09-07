"use client";

import { useState } from "react";

const defaultMembers = ["원이", "리브(RESCENE)", "미나미(RESCENE)", "메이(RESCENE)", "제나"];

export default function NamuImportPage() {
  const [adminKey, setAdminKey] = useState("");
  const [rootTitle, setRootTitle] = useState("RESCENE");
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxDocuments, setMaxDocuments] = useState(80);
  const [includeTitles, setIncludeTitles] = useState(defaultMembers.join("\n"));
  const [status, setStatus] = useState("Ready.");
  const [busy, setBusy] = useState(false);

  const commonHeaders = { "Content-Type": "application/json", "x-admin-key": adminKey };

  async function crawl() {
    const response = await fetch("/api/admin/namu-import", {
      method: "POST",
      headers: commonHeaders,
      body: JSON.stringify({
        rootTitle,
        maxDepth,
        maxDocuments,
        includePrefixes: [rootTitle + "/"],
        includeTitles: includeTitles.split("\n").map((v) => v.trim()).filter(Boolean),
      }),
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

  async function runImport() {
    setBusy(true);
    setStatus("Crawling mirror document graph...");
    try {
      const result = await crawl();
      setStatus(JSON.stringify(result, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function runParse() {
    setBusy(true);
    setStatus("Parsing stored mirror snapshots into structured sections...");
    try {
      const result = await parse(true);
      setStatus(JSON.stringify(result, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Parse failed");
    } finally {
      setBusy(false);
    }
  }

  async function runAll() {
    setBusy(true);
    try {
      setStatus("Step 1/2: crawling document graph...");
      const importResult = await crawl();
      setStatus(`Step 1/2 complete: ${importResult.fetched} documents fetched.\nStep 2/2: parsing structure...`);
      const parseResult = await parse(true);
      setStatus(JSON.stringify({ import: importResult, parse: parseResult }, null, 2));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Pipeline failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="adminShell">
      <section className="adminPanel">
        <h1>Namu mirror importer</h1>
        <p className="adminIntro">Crawl a group document graph, preserve the source snapshots, then convert them into structured sections for translation and Kpoparkive rendering.</p>
        <div className="adminForm">
          <label>Admin key<input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} /></label>
          <label>Root document<input value={rootTitle} onChange={(e) => setRootTitle(e.target.value)} /></label>
          <label>Max depth<input type="number" min={0} max={4} value={maxDepth} onChange={(e) => setMaxDepth(Number(e.target.value))} /></label>
          <label>Max documents<input type="number" min={1} max={200} value={maxDocuments} onChange={(e) => setMaxDocuments(Number(e.target.value))} /></label>
          <label>Extra exact titles (one per line)<textarea rows={7} value={includeTitles} onChange={(e) => setIncludeTitles(e.target.value)} /></label>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runAll}>{busy ? "Working..." : "Import + parse document graph"}</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runImport}>Crawl only</button>
          <button type="button" disabled={busy || !adminKey || !rootTitle} onClick={runParse}>Re-parse stored snapshots</button>
        </div>
        <pre className="adminStatus">{status}</pre>
      </section>
    </main>
  );
}
