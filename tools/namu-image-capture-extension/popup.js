const rootInput = document.getElementById("root");
const cloneButton = document.getElementById("clone");
const depthInput = document.getElementById("depth");
const maxDocsInput = document.getElementById("maxDocs");
const health = document.getElementById("health");
const status = document.getElementById("status");
let clonePoll = null;

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

function formatCloneJob(job) {
  if (!job) return "Clone job: not started";
  const lines = [
    `Root: ${job.rootTitle || "—"}`,
    `State: ${job.running ? "RUNNING" : job.done ? "DONE" : "IDLE"}`,
    `Captured documents: ${job.captured || 0}`,
    `Processed: ${job.processed || 0}/${job.maxDocs || 0}`,
    `Queued: ${job.queued || 0}`,
    `Depth: ${job.maxDepth || 0}`,
    `Failed documents: ${job.failed || 0}`,
  ];
  if (job.current) lines.push(`Current: ${job.current}`);
  if (job.lastMedia) lines.push(`Last media: ${job.lastMedia.resolved || 0} resolved · ${job.lastMedia.failed || 0} failed`);
  if (Array.isArray(job.errors) && job.errors.length) {
    lines.push("", "Recent errors:");
    for (const error of job.errors.slice(-5)) lines.push(`- ${error}`);
  }
  return lines.join("\n");
}

async function pollCloneStatus() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-recursive-clone-status" });
    if (!response?.ok) return;
    const job = response.job;
    if (job?.running || job?.done) setStatus(formatCloneJob(job), job?.failed ? "" : "ok");
    cloneButton.disabled = Boolean(job?.running);
    if (!job?.running && clonePoll) {
      clearInterval(clonePoll);
      clonePoll = null;
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
  setStatus(`Starting clone...\nRoot: ${rootTitle}\nDepth: ${maxDepth}\nMax documents: ${maxDocs}`);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-recursive-clone",
      options: { rootTitle, maxDepth, maxDocs },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start clone.");
    setStatus(formatCloneJob(response.job), "ok");
    if (clonePoll) clearInterval(clonePoll);
    clonePoll = setInterval(pollCloneStatus, 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    cloneButton.disabled = false;
  }
});

refreshHealth();
pollCloneStatus();
