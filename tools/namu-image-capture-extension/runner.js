const KPOP_RUNNER_HELPER = "http://127.0.0.1:43117";
const KPOP_RUNNER_DOC_CONCURRENCY = 2;
const KPOP_RUNNER_MEDIA_CONCURRENCY = 6;
const runnerStatusNode = document.getElementById("status");
let runnerKnownAssetUrls = new Set();
let runnerRootTitle = "";
let runnerStopped = false;

function runnerSetStatus(text) {
  if (runnerStatusNode) runnerStatusNode.textContent = text;
}

function runnerNormalizeUrl(value) {
  try { return new URL(String(value || ""), "https://namu.wiki").toString(); }
  catch { return String(value || "").trim(); }
}

async function runnerJson(path, init = {}) {
  const response = await fetch(`${KPOP_RUNNER_HELPER}${path}`, {
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `helper HTTP ${response.status}`);
  return body;
}

async function runnerWait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runnerWaitForDocument(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "")) {
      await runnerWait(350);
      return tab;
    }
    await runnerWait(200);
  }
  throw new Error("Timed out waiting for NamuWiki document to load.");
}

async function runnerLoadKnownAssets(rootTitle) {
  try {
    const result = await runnerJson(`/assets-known?rootTitle=${encodeURIComponent(rootTitle)}`);
    runnerKnownAssetUrls = new Set((result.urls || []).map(runnerNormalizeUrl));
  } catch {
    runnerKnownAssetUrls = new Set();
  }
}

function runnerAssetAlreadyKnown(asset) {
  return (asset?.urls || []).some((url) => runnerKnownAssetUrls.has(runnerNormalizeUrl(url)));
}

function runnerRememberAsset(asset) {
  for (const url of asset?.urls || []) runnerKnownAssetUrls.add(runnerNormalizeUrl(url));
}

async function runnerCaptureAssets(prep) {
  const assets = (prep.assets || []).filter((asset) => !runnerAssetAlreadyKnown(asset));
  const result = {
    total: prep.assets?.length || 0,
    skippedKnown: (prep.assets?.length || 0) - assets.length,
    resolved: 0,
    noQueue: 0,
    failed: 0,
    rejected: 0,
  };
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= assets.length) return;
      const asset = assets[index];
      try {
        const item = await captureOneAsset({
          rootTitle: prep.rootTitle,
          sourceTitle: prep.sourceTitle,
          pageUrl: prep.pageUrl,
          asset,
        });
        result.rejected += Number(item.rejected || 0);
        if (item.status === "resolved") {
          result.resolved += 1;
          runnerRememberAsset(asset);
        } else if (item.status === "no_queue") {
          result.noQueue += 1;
          runnerRememberAsset(asset);
        } else {
          result.failed += 1;
        }
      } catch {
        result.failed += 1;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(KPOP_RUNNER_MEDIA_CONCURRENCY, Math.max(1, assets.length)) }, () => worker()));
  return result;
}

async function runnerProcessTask(task) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: task.url, active: false });
    tabId = tab.id;
    if (!tabId) throw new Error("Could not open capture tab.");
    await runnerWaitForDocument(tabId);

    const prep = await tabCapturePayload(tabId, runnerRootTitle, task.depth);
    const media = await runnerCaptureAssets(prep);
    await runnerJson("/clone/complete", {
      method: "POST",
      body: JSON.stringify({
        leaseId: task.leaseId,
        sourceTitle: prep.sourceTitle,
        internalLinks: prep.internalLinks || [],
        media,
      }),
    });
    return { ok: true, sourceTitle: prep.sourceTitle, media };
  } catch (error) {
    try {
      await runnerJson("/clone/fail", {
        method: "POST",
        body: JSON.stringify({ leaseId: task.leaseId, error: error?.message || String(error) }),
      });
    } catch {}
    return { ok: false, error: error?.message || String(error) };
  } finally {
    if (tabId) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
  }
}

function runnerBadge(job) {
  try {
    if (job?.running) {
      const value = `${job.processed || 0}/${job.maxDocs || 0}`;
      chrome.action.setBadgeBackgroundColor({ color: "#6f3cff" });
      chrome.action.setBadgeText({ text: value.length <= 4 ? value : String(job.processed || 0) });
    } else if (job?.done) {
      chrome.action.setBadgeBackgroundColor({ color: job.failed ? "#b00020" : "#0a7a2f" });
      chrome.action.setBadgeText({ text: job.failed ? "!" : "✓" });
    }
  } catch {}
}

async function runnerWorker(workerIndex) {
  while (!runnerStopped) {
    const claim = await runnerJson("/clone/claim", { method: "POST", body: "{}" });
    const job = claim.job || {};
    runnerBadge(job);
    runnerSetStatus(`Worker ${workerIndex + 1}\n${job.processed || 0}/${job.maxDocs || 0} processed\n${job.queued || 0} queued · ${job.leased || 0} active\n${job.failed || 0} failed`);

    if (claim.status === "done" || job.done || job.status === "cancelled") return;
    if (claim.status !== "task" || !claim.task) {
      await runnerWait(500);
      continue;
    }
    await runnerProcessTask(claim.task);
  }
}

async function runnerCloseSelf() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) await chrome.tabs.remove(tab.id);
  } catch {}
}

async function runnerMain() {
  try {
    const status = await runnerJson("/clone/status");
    const job = status.job || {};
    if (!job.running) {
      runnerBadge(job);
      await runnerWait(800);
      await runnerCloseSelf();
      return;
    }

    runnerRootTitle = job.rootTitle;
    await runnerLoadKnownAssets(runnerRootTitle);
    runnerSetStatus(`Running ${runnerRootTitle}\nKnown media cached: ${runnerKnownAssetUrls.size}`);

    await Promise.all(Array.from({ length: KPOP_RUNNER_DOC_CONCURRENCY }, (_, index) => runnerWorker(index)));
    const finalStatus = await runnerJson("/clone/status");
    runnerBadge(finalStatus.job || {});
    runnerSetStatus(`Done\n${finalStatus.job?.processed || 0} processed\n${finalStatus.job?.captured || 0} captured\n${finalStatus.job?.skipped || 0} reused\n${finalStatus.job?.failed || 0} failed`);
    await runnerWait(1200);
    await runnerCloseSelf();
  } catch (error) {
    runnerSetStatus(`Runner error: ${error?.message || error}`);
    try {
      chrome.action.setBadgeBackgroundColor({ color: "#b00020" });
      chrome.action.setBadgeText({ text: "!" });
    } catch {}
  }
}

runnerMain();
