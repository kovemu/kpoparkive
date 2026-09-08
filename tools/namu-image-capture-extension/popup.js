const rootInput = document.getElementById("root");
const cloneButton = document.getElementById("clone");
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

refreshHealth();
pollStatus();
