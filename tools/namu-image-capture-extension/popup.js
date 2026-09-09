const rootInput = document.getElementById("root");
const cloneButton = document.getElementById("clone");
const rawButton = document.getElementById("raw");
const resetButton = document.getElementById("reset");
const depthInput = document.getElementById("depth");
const maxDocsInput = document.getElementById("maxDocs");
const health = document.getElementById("health");
const status = document.getElementById("status");
let pollTimer = null;

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

async function refreshHealth() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-helper-health" });
    if (response?.ok) {
      const suffix = response.documentCapture ? ` · ${response.documentCapture}` : "";
      health.textContent = response.supabaseHost
        ? `Local helper: connected (${response.supabaseHost})${suffix}`
        : `Local helper: connected${suffix}`;
      health.className = "ok";
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
  const lines = [
    `Root: ${job.rootTitle || "—"}`,
    `State: ${job.running ? "RUNNING" : job.done ? "DONE" : String(job.status || "IDLE").toUpperCase()}`,
    `Processed: ${job.processed || 0}/${job.maxDocs || 0}`,
    `Captured: ${job.captured || 0}`,
    `Reused: ${job.skipped || 0}`,
    `Queued: ${job.queued || 0}`,
    `Active workers: ${job.leased || 0}`,
    `Failed: ${job.failed || 0}`,
  ];
  if (current) lines.push(`Current: ${current}`);
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

async function pollStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-helper-clone-status" });
    if (!response?.ok) return;
    const job = response.job;
    if (job?.id) setStatus(formatJob(job), job.failed ? "" : "ok");
    cloneButton.disabled = Boolean(job?.running);
    if (!job?.running && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  } catch {}
}

chrome.storage.local.get(["kpoparkiveRootTitle", "kpoparkiveCloneDepth", "kpoparkiveCloneMaxDocs"]).then((stored) => {
  if (stored.kpoparkiveRootTitle) rootInput.value = stored.kpoparkiveRootTitle;
  if (stored.kpoparkiveCloneDepth != null) depthInput.value = String(stored.kpoparkiveCloneDepth);
  if (stored.kpoparkiveCloneMaxDocs != null) maxDocsInput.value = String(stored.kpoparkiveCloneMaxDocs);
});

rootInput.addEventListener("change", () => {
  const value = rootInput.value.trim() || "RESCENE";
  rootInput.value = value;
  chrome.storage.local.set({ kpoparkiveRootTitle: value });
});

depthInput.addEventListener("change", () => chrome.storage.local.set({ kpoparkiveCloneDepth: Number(depthInput.value || 1) }));
maxDocsInput.addEventListener("change", () => chrome.storage.local.set({ kpoparkiveCloneMaxDocs: Number(maxDocsInput.value || 25) }));

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
      options: { rootTitle, maxDepth, maxDocs },
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
  const rootTitle = rootInput.value.trim() || "RESCENE";
  rawButton.disabled = true;
  setStatus(
    "Capturing canonical NamuMark through normal Chrome edit pages...\n" +
    "The root source is saved first, then included templates are followed recursively.\n" +
    "If NamuWiki verification appears, complete it in the opened tab and leave the tab open."
  );

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-capture-edit-raw-source",
      options: { rootTitle, openPreview: true, maxTemplateDepth: 2, maxTemplates: 40 },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not capture raw source.");

    const failures = Array.isArray(response.templateFailures) ? response.templateFailures : [];
    const lines = [
      "Raw source saved.",
      `Document: ${response.sourceTitle || "—"}`,
      `Characters: ${response.charCount || 0}`,
      `Method: ${response.extractionMethod || "normal Chrome edit"}`,
      `Templates captured: ${response.templatesCaptured || 0}`,
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

resetButton.addEventListener("click", async () => {
  const confirmed = confirm("Reset the current crawler job and clear its queue/progress?\n\nAlready captured Supabase documents and media will be kept.");
  if (!confirmed) return;

  resetButton.disabled = true;
  cloneButton.disabled = true;
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
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    resetButton.disabled = false;
  }
});

refreshHealth();
pollStatus();
