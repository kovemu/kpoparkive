const rootInput = document.getElementById("root");
const captureButton = document.getElementById("capture");
const health = document.getElementById("health");
const status = document.getElementById("status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

async function refreshHealth() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "kpoparkive-helper-health" });
    if (response?.ok) {
      health.textContent = response.supabaseHost
        ? `Local helper: connected (${response.supabaseHost})`
        : "Local helper: connected";
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
  if (!browserDom) return "Browser DOM: not captured";
  if (!browserDom.ok) return `Browser DOM: FAILED (${browserDom.error || "unknown error"})`;
  const kb = Number(browserDom.articleBytes || 0) / 1024;
  return `Browser DOM: SAVED${kb > 0 ? ` (${kb.toFixed(1)} KB)` : ""}`;
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

chrome.storage.local.get(["kpoparkiveRootTitle"]).then((stored) => {
  if (stored.kpoparkiveRootTitle) rootInput.value = stored.kpoparkiveRootTitle;
});

rootInput.addEventListener("change", () => {
  const value = rootInput.value.trim() || "RESCENE";
  rootInput.value = value;
  chrome.storage.local.set({ kpoparkiveRootTitle: value });
});

captureButton.addEventListener("click", async () => {
  const rootTitle = rootInput.value.trim() || "RESCENE";
  await chrome.storage.local.set({ kpoparkiveRootTitle: rootTitle });
  captureButton.disabled = true;
  setStatus("Capturing final rendered article DOM, then image bytes...\nKeep this popup open while capture is running.");

  try {
    const prepared = await chrome.runtime.sendMessage({
      type: "kpoparkive-prepare-capture",
      rootTitle,
    });
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
        payload: {
          rootTitle,
          sourceTitle: prep.sourceTitle,
          pageUrl: prep.pageUrl,
          asset: prep.assets[index],
        },
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

      setStatus(
        formatResult(result, { done: index + 1, total: prep.assets.length }),
        result.browserDom?.ok || result.resolved > 0 ? "ok" : "",
      );
    }

    setStatus(formatResult(result), result.browserDom?.ok || result.resolved > 0 ? "ok" : "");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    captureButton.disabled = false;
    refreshHealth();
  }
});

refreshHealth();
