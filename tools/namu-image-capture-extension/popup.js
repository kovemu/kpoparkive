const rootInput = document.getElementById("root");
const captureButton = document.getElementById("capture");
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

function formatBrowserDom(browserDom) {
  if (!browserDom) return "Browser artifact: not captured";
  if (!browserDom.ok) return `Browser artifact: FAILED (${browserDom.error || "unknown error"})`;
  const htmlKb = Number(browserDom.articleBytes || 0) / 1024;
  const styleKb = Number(browserDom.styleBytes || 0) / 1024;
  const details = [];
  if (htmlKb > 0) details.push(`HTML ${htmlKb.toFixed(1)} KB`);
  if (styleKb > 0) details.push(`pseudo CSS ${styleKb.toFixed(1)} KB`);
  if (browserDom.nodeCount) details.push(`${browserDom.nodeCount} nodes`);
  if (browserDom.internalLinkCount != null) details.push(`${browserDom.internalLinkCount} links`);
  return `Browser artifact: SAVED${details.length ? ` (${details.join(", ")})` : ""}`;
}

function formatResult(result, progress = null) {
  const failed = result.details.filter((item) => item.status === "failed").slice(0, 8);
  const noQueue = result.details.filter((item) => item.status === "no_queue").slice(0, 8);
  const lines = [
    formatBrowserDom(result.browserDom),
    `Page: ${result.sourceTitle}`,
    `Found: ${result.found}`,
    `Resolved: ${result.resolved}`,
    `No queue match: ${result.noQueue}`,
    `Rejected candidates: ${result.rejected}`,
    `Failed files: ${result.failed}`,
  ];

  if (progress) lines.unshift(`Progress: ${progress.done}/${progress.total}`);
  if (result.helper?.supabaseHost) lines.push(`Helper DB: ${result.helper.supabaseHost}`);

  if (result.debug) {
    lines.push(
      "",
      "DOM diagnostics:",
      `- roots: ${result.debug.roots ?? 0}`,
      `- img elements: ${result.debug.images ?? 0}`,
      `- picture sources: ${result.debug.pictureSources ?? 0}`,
      `- CSS image surfaces: ${result.debug.backgroundSurfaces ?? 0}`,
      `- file-like links: ${result.debug.fileLinks ?? 0}`,
      `- labeled assets: ${result.debug.labeledAssets ?? 0}`,
    );
    const samples = (result.debug.unlabeledSamples || []).slice(0, 4);
    if (samples.length) {
      lines.push("", "Unlabeled samples:");
      for (const sample of samples) {
        const label = sample.alt || sample.title || "(no label)";
        lines.push(`- ${label} | ${String(sample.src || "").slice(0, 100)}`);
      }
    }
  }

  if (noQueue.length) {
    lines.push("", "No queue samples:");
    for (const item of noQueue) lines.push(`- ${item.fileName}`);
  }

  if (failed.length) {
    lines.push("", "Failures:");
    for (const item of failed) lines.push(`- ${item.fileName}: ${item.error}`);
  }

  return lines.join("\n");
}

function formatCloneJob(job) {
  if (!job) return "Clone job: not started";
  const lines = [
    `Clone root: ${job.rootTitle || "—"}`,
    `State: ${job.running ? "RUNNING" : job.done ? "DONE" : "IDLE"}`,
    `Captured documents: ${job.captured || 0}`,
    `Processed: ${job.processed || 0}/${job.maxDocs || 0}`,
    `Queued: ${job.queued || 0}`,
    `Depth: ${job.maxDepth || 0}`,
    `Failed documents: ${job.failed || 0}`,
  ];
  if (job.current) lines.push(`Current: ${job.current}`);
  if (job.lastMedia) {
    lines.push(`Last media: ${job.lastMedia.resolved || 0} resolved · ${job.lastMedia.failed || 0} failed`);
  }
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
    captureButton.disabled = Boolean(job?.running);
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

captureButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  await chrome.storage.local.set({ kpoparkiveRootTitle: rootTitle });
  captureButton.disabled = true;
  cloneButton.disabled = true;
  setStatus("Capturing final DOM + computed layout snapshot, link graph and verified image bytes...\nKeep this popup open while capture is running.");

  try {
    const prepared = await chrome.runtime.sendMessage({ type: "kpoparkive-prepare-capture", rootTitle });
    if (!prepared?.ok) throw new Error(prepared?.error || "Could not prepare capture.");

    const prep = prepared.result;
    const result = {
      sourceTitle: prep.sourceTitle,
      found: prep.assets.length,
      resolved: 0,
      noQueue: 0,
      failed: 0,
      rejected: 0,
      details: [],
      debug: prep.debug || null,
      helper: prep.helper || null,
      browserDom: prep.browserDom || null,
    };

    setStatus(formatResult(result, { done: 0, total: prep.assets.length }), prep.browserDom?.ok ? "ok" : "");

    for (let index = 0; index < prep.assets.length; index += 1) {
      const response = await chrome.runtime.sendMessage({
        type: "kpoparkive-capture-one-asset",
        payload: { rootTitle, sourceTitle: prep.sourceTitle, pageUrl: prep.pageUrl, asset: prep.assets[index] },
      });

      if (!response?.ok) {
        result.failed += 1;
        result.details.push({
          fileName: prep.assets[index].fileName || `anonymous@${prep.assets[index].domIndex ?? "?"}`,
          status: "failed",
          error: response?.error || "capture request failed",
        });
      } else {
        const item = response.result;
        result.rejected += Number(item.rejected || 0);
        result.details.push(item.detail);
        if (item.status === "resolved") result.resolved += 1;
        else if (item.status === "no_queue") result.noQueue += 1;
        else if (item.status === "failed") result.failed += 1;
      }

      setStatus(formatResult(result, { done: index + 1, total: prep.assets.length }), result.browserDom?.ok || result.resolved > 0 ? "ok" : "");
    }

    setStatus(formatResult(result), result.browserDom?.ok || result.resolved > 0 ? "ok" : "");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    captureButton.disabled = false;
    cloneButton.disabled = false;
    refreshHealth();
  }
});

cloneButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  const maxDepth = Math.max(0, Math.min(3, Number(depthInput.value || 1) || 1));
  const maxDocs = Math.max(1, Math.min(200, Number(maxDocsInput.value || 25) || 25));
  await chrome.storage.local.set({
    kpoparkiveRootTitle: rootTitle,
    kpoparkiveCloneDepth: maxDepth,
    kpoparkiveCloneMaxDocs: maxDocs,
  });
  cloneButton.disabled = true;
  captureButton.disabled = true;
  setStatus(`Starting recursive clone...\nRoot: ${rootTitle}\nDepth: ${maxDepth}\nMax documents: ${maxDocs}`);

  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-start-recursive-clone",
      options: { rootTitle, maxDepth, maxDocs },
    });
    if (!response?.ok) throw new Error(response?.error || "Could not start recursive clone.");
    setStatus(formatCloneJob(response.job), "ok");
    if (clonePoll) clearInterval(clonePoll);
    clonePoll = setInterval(pollCloneStatus, 1000);
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
    cloneButton.disabled = false;
    captureButton.disabled = false;
  }
});

refreshHealth();
pollCloneStatus();
