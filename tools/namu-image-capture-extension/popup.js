const rootInput = document.getElementById("root");
const cloneButton = document.getElementById("clone");
const rawCrawlButton = document.getElementById("rawCrawl");
const rawButton = document.getElementById("raw");
const assetsButton = document.getElementById("assets");
const compareButton = document.getElementById("compare");
const resetButton = document.getElementById("reset");
const depthInput = document.getElementById("depth");
const maxDocsInput = document.getElementById("maxDocs");
const health = document.getElementById("health");
const status = document.getElementById("status");
const verification = document.getElementById("verification");
let pollTimer = null;
let rawAssetPollTimer = null;

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

function titleFromNamuUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/w\/(.+)$/);
    if (!match?.[1]) return "";
    try { return decodeURIComponent(match[1]).normalize("NFKC").trim(); }
    catch { return match[1].normalize("NFKC").trim(); }
  } catch {
    return "";
  }
}

async function syncRootFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const title = titleFromNamuUrl(tab?.url || "");
    if (!title) return rootInput.value.trim() || "";
    rootInput.value = title;
    await chrome.storage.local.set({ kpoparkiveRootTitle: title });
    return title;
  } catch {
    return rootInput.value.trim() || "";
  }
}

async function refreshHealth() {
  try {
    const [response, rawAssets] = await Promise.all([
      chrome.runtime.sendMessage({ type: "kpoparkive-helper-health" }),
      chrome.runtime.sendMessage({ type: "kpoparkive-raw-asset-health" }).catch(() => ({ ok: false })),
    ]);
    if (response?.ok) {
      const suffix = response.documentCapture ? ` · ${response.documentCapture}` : "";
      const rawSuffix = rawAssets?.ok ? " · raw-assets ready" : " · raw-assets unavailable";
      health.textContent = response.supabaseHost
        ? `Local helper: connected (${response.supabaseHost})${suffix}${rawSuffix}`
        : `Local helper: connected${suffix}${rawSuffix}`;
      health.className = rawAssets?.ok ? "ok" : "";
    } else {
      health.textContent = "Local helper: not running";
      health.className = "bad";
    }
  } catch {
    health.textContent = "Local helper: not running";
    health.className = "bad";
  }
}

function formatJob(job) {
  if (!job || !job.id) return "Ready.";
  const current = Array.isArray(job.current) ? job.current.filter(Boolean).join(" · ") : String(job.current || "");
  const state = job.paused
    ? "PAUSED · VERIFICATION"
    : job.running
      ? "RUNNING"
      : job.done
        ? "DONE"
        : String(job.status || "IDLE").toUpperCase();
  const lines = [
    `Root: ${job.rootTitle || "—"}`,
    `Mode: ${job.captureMode === "raw" ? "RAW" : "DOM"}`,
    `State: ${state}`,
    `Processed: ${job.processed || 0}/${job.maxDocs || 0}`,
    `Captured: ${job.captured || 0}`,
    `Reused: ${job.skipped || 0}`,
    `Queued: ${job.queued || 0}`,
    `Active workers: ${job.leased || 0}`,
    `Failed: ${job.failed || 0}`,
  ];
  if (current) lines.push(`Current: ${current}`);
  if (job.paused && job.pauseReason) lines.push(`Pause reason: ${job.pauseReason}`);
  if (job.lastMedia) {
    lines.push(`Last media: ${job.lastMedia.resolved || 0} new · ${job.lastMedia.skippedKnown || 0} reused · ${job.lastMedia.failed || 0} failed`);
  }
  if (job.running) lines.push("", "You can close this popup and use Chrome normally.");
  if (Array.isArray(job.errors) && job.errors.length) {
    lines.push("", "Recent errors:");
    for (const error of job.errors.slice(-4)) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

function formatRawAssetJob(job) {
  if (!job || job.id !== "raw-assets") return "Raw asset resolver is idle.";
  const lines = [
    `Raw assets · ${job.rootTitle || "—"}`,
    `State: ${job.running ? "RUNNING" : job.done ? "DONE" : "IDLE"}`,
    `Required by renderer: ${job.required || 0}`,
    `Missing at start: ${job.planned || 0}`,
    `Processed: ${job.processed || 0}/${job.planned || 0}`,
    `Resolved: ${job.resolved || 0}`,
    `Failed: ${job.failed || 0}`,
    `Remaining after verification: ${job.remaining == null ? "—" : job.remaining}`,
  ];
  if (job.current) lines.push(`Current: ${job.current}`);
  if (job.running) lines.push("", "File pages are opened in background. If NamuWiki verification blocks a file, that tab will be brought forward.");
  if (Array.isArray(job.errors) && job.errors.length) {
    lines.push("", "Recent errors:");
    for (const error of job.errors.slice(-5)) lines.push(`- ${error}`);
  }
  if (job.done && !job.failed && Number(job.remaining || 0) === 0) {
    lines.push("", "All renderer-required assets are storage-backed. Re-run the The Tree renderer to refresh missing-files metadata/HTML.");
  }
  return lines.join("\n");
}

async function pollStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-helper-clone-status" });
    if (!response?.ok) return;
    const job = response.job;
    if (job?.id) setStatus(formatJob(job), job.failed ? "" : "ok");
    cloneButton.disabled = Boolean(job?.running);
    rawCrawlButton.disabled = Boolean(job?.running);
    if (!job?.running && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch {}
}

async function pollRawAssetStatus(show = true) {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-raw-asset-status" });
    if (!response?.ok) return;
    const job = response.job;
    assetsButton.disabled = Boolean(job?.running);
    if (show && job?.id === "raw-assets" && (job.running || job.done || job.planned)) {
      setStatus(formatRawAssetJob(job), job.failed ? "" : "ok");
    }
    if (!job?.running && rawAssetPollTimer) {
      clearInterval(rawAssetPollTimer);
      rawAssetPollTimer = null;
    }
  } catch {}
}

chrome.storage.local.get(["kpoparkiveRootTitle", "kpoparkiveCloneDepth", "kpoparkiveCloneMaxDocs"]).then(async (stored) => {
  if (stored.kpoparkiveRootTitle) rootInput.value = stored.kpoparkiveRootTitle;
  if (stored.kpoparkiveCloneDepth != null) depthInput.value = String(stored.kpoparkiveCloneDepth);
  if (stored.kpoparkiveCloneMaxDocs != null) maxDocsInput.value = String(stored.kpoparkiveCloneMaxDocs);
  await syncRootFromActiveTab();
});

rootInput.addEventListener("change", () => {
  const value = rootInput.value.trim() || "RESCENE";
  rootInput.value = value;
  chrome.storage.local.set({ kpoparkiveRootTitle: value });
});

depthInput.addEventListener("change", () => chrome.storage.local.set({ kpoparkiveCloneDepth: Number(depthInput.value || 1) }));
maxDocsInput.addEventListener("change", () => chrome.storage.local.set({ kpoparkiveCloneMaxDocs: Number(maxDocsInput.value || 25) }));

rawCrawlButton.addEventListener("click", async () => {
  const activeRoot = await syncRootFromActiveTab();
  const rootTitle = activeRoot || rootInput.value.trim() || "RESCENE";
  const maxDepth = 0;
  const maxDocs = 1;

  await chrome.storage.local.set({
    kpoparkiveRootTitle: rootTitle,
    kpoparkiveCloneDepth: maxDepth,
    kpoparkiveCloneMaxDocs: maxDocs,
  });

  rawCrawlButton.disabled = true;
  setStatus(
    `Capturing root RAW only...\nDocument: ${rootTitle}\n\nExactly one /raw/ page is read. No linked documents, templates, or file pages are opened.`
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-helper-clone",
      options: { rootTitle, maxDepth, maxDocs, captureMode: "raw" },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start RAW crawl.");
    setStatus(formatJob(response.job), "ok");
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    rawCrawlButton.disabled = false;
  }
});

cloneButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  const maxDepth = Math.max(0, Math.min(3, Number(depthInput.value || 1) || 0));
  const maxDocs = Math.max(1, Math.min(200, Number(maxDocsInput.value || 25) || 25));

  await chrome.storage.local.set({
    kpoparkiveRootTitle: rootTitle,
    kpoparkiveCloneDepth: maxDepth,
    kpoparkiveCloneMaxDocs: maxDocs,
  });

  cloneButton.disabled = true;
  setStatus(`Starting background import...\nRoot: ${rootTitle}\nDepth: ${maxDepth}\nMax documents: ${maxDocs}`);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-helper-clone",
      options: { rootTitle, maxDepth, maxDocs, captureMode: "dom" },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start import.");
    setStatus(formatJob(response.job), "ok");
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollStatus, 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    cloneButton.disabled = false;
  }
});

rawButton.addEventListener("click", async () => {
  const activeRoot = await syncRootFromActiveTab();
  const rootTitle = activeRoot || rootInput.value.trim() || "RESCENE";
  rawButton.disabled = true;
  setStatus(
    "Capturing canonical NamuMark from the visible /raw/ page...\n" +
    "Only this document RAW is captured. Included templates and assets are not opened recursively.\n" +
    "The Tree will reuse cached template/DOM/asset data already collected by the normal-page crawler."
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-capture-edit-raw-source",
      options: { rootTitle, openPreview: true },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not capture raw source.");

    const failures = Array.isArray(response.templateFailures) ? response.templateFailures : [];
    const lines = [
      "Raw source saved.",
      `Document: ${response.sourceTitle || "—"}`,
      `Characters: ${response.charCount || 0}`,
      `Method: ${response.extractionMethod || "normal Chrome edit"}`,
      `Templates referenced: ${response.templatesDiscovered || 0}`,
      `Template failures: ${failures.length}`,
    ];
    if (failures.length) {
      lines.push("", "Template failures:");
      for (const item of failures.slice(0, 8)) lines.push(`- ${item.title}: ${item.error}`);
    }
    lines.push("", "Run the NamuMark engine POC again to compare the fuller render.");
    setStatus(lines.join("\n"), failures.length ? "" : "ok");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    rawButton.disabled = false;
  }
});

assetsButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  await chrome.storage.local.set({ kpoparkiveRootTitle: rootTitle });
  assetsButton.disabled = true;
  setStatus(
    `Planning renderer-required assets for ${rootTitle}...\n` +
    "Only files without storage-backed bytes will be opened and captured through this normal Chrome session."
  );
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-raw-asset-resolver",
      options: { rootTitle, sourceTitle: rootTitle },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start raw asset resolver.");
    setStatus(formatRawAssetJob(response.job), "ok");
    if (rawAssetPollTimer) clearInterval(rawAssetPollTimer);
    rawAssetPollTimer = setInterval(() => pollRawAssetStatus(true), 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    assetsButton.disabled = false;
  }
});

compareButton.addEventListener("click", async () => {
  compareButton.disabled = true;
  setStatus(
    "Comparing the LIVE NamuWiki page in this tab with the deployed The Tree baseline...\n" +
    "The baseline opens in a background tab, layout/text/image metrics are captured at the same browser width, then the report is saved to Supabase."
  );

  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-compare-live-fidelity" });
    if (!response?.ok) throw new Error(response?.error || "Live fidelity comparison failed.");
    const s = response.summary || {};
    setStatus([
      "Live fidelity report saved.",
      `Document: ${response.sourceTitle || "—"}`,
      `Tables: original ${s.originalTables || 0} / The Tree ${s.baselineTables || 0}`,
      `Matched tables: ${s.matchedTables || 0}`,
      `Geometry mismatches: ${s.tableGeometryMismatches || 0}`,
      `Unmatched tables: original ${s.unmatchedOriginalTables || 0} / The Tree ${s.unmatchedBaselineTables || 0}`,
      `Images: original ${s.originalImages || 0} / The Tree ${s.baselineImages || 0}`,
      `Matched images by alt: ${s.matchedImagesByAlt || 0}`,
      `Missing images by alt: ${s.missingImagesByAlt || 0}`,
      `Leaked syntax markers: ${s.leakedMarkerCount || 0}`,
      "",
      "Saved to source_documents.source_fidelity_meta for direct analysis.",
    ].join("\n"), "ok");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    compareButton.disabled = false;
  }
});

resetButton.addEventListener("click", async () => {
  resetButton.disabled = true;
  cloneButton.disabled = true;
  rawCrawlButton.disabled = true;
  setStatus("Resetting crawler job...\nStopping workers and clearing the local queue.");

  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-reset-helper-clone" });
    if (!response?.ok) throw new Error(response?.error || "Could not reset import job.");
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setStatus("Job reset complete.\nQueue, leases and progress were cleared.\nCaptured Supabase documents/media were kept.", "ok");
    cloneButton.disabled = false;
    rawCrawlButton.disabled = false;
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    resetButton.disabled = false;
  }
});

async function pollVerificationStatus() {
  try {
    const stored = await chrome.storage.local.get(["kpoparkiveRawVerification"]);
    const item = stored.kpoparkiveRawVerification || null;
    if (item?.active) {
      verification.classList.add("show");
      verification.textContent =
        `PAUSED · Complete NamuWiki verification\n${item.sourceTitle || "Current document"}\nThe RAW queue resumes automatically when verification clears.`;
    } else {
      verification.classList.remove("show");
      verification.textContent = "PAUSED · NamuWiki verification required";
    }
  } catch {}
}

refreshHealth();
pollStatus();
pollRawAssetStatus(false);
pollVerificationStatus();
setInterval(pollVerificationStatus, 600);
