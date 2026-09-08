const rootInput = document.getElementById("root");
const captureButton = document.getElementById("capture");
const health = document.getElementById("health");
const status = document.getElementById("status");

function setStatus(text, kind = "") {
  status.textContent = text;
  status.className = kind;
}

async function refreshHealth() {
  const response = await chrome.runtime.sendMessage({ type: "kpoparkive-helper-health" });
  if (response?.ok) {
    health.textContent = "Local helper: connected";
    health.className = "ok";
  } else {
    health.textContent = "Local helper: not running";
    health.className = "bad";
  }
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
  setStatus("Capturing current NamuWiki page...\nDo not close this popup until the result appears.");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "kpoparkive-capture-current-page",
      rootTitle,
    });
    if (!response?.ok) throw new Error(response?.error || "Capture failed.");
    const result = response.result;
    const failed = result.details.filter((item) => item.status === "failed").slice(0, 8);
    const lines = [
      `Page: ${result.sourceTitle}`,
      `Found: ${result.found}`,
      `Resolved: ${result.resolved}`,
      `No queue match: ${result.noQueue}`,
      `Rejected candidates: ${result.rejected}`,
      `Failed files: ${result.failed}`,
    ];
    if (failed.length) {
      lines.push("", "Failures:");
      for (const item of failed) lines.push(`- ${item.fileName}: ${item.error}`);
    }
    setStatus(lines.join("\n"), result.resolved > 0 ? "ok" : "");
  } catch (error) {
    setStatus(error?.message || String(error), "bad");
  } finally {
    captureButton.disabled = false;
    refreshHealth();
  }
});

refreshHealth();
