let kpopFastCloneJob = {
  running: false,
  rootTitle: "",
  processed: 0,
  captured: 0,
  failed: 0,
  queued: 0,
  current: "",
  maxDepth: 0,
  maxDocs: 0,
  errors: [],
  done: false,
};

function kpopFastSetBadge(text, color = "#6f3cff") {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
  } catch {}
}

async function kpopFastPersist() {
  await chrome.storage.local.set({ kpoparkiveFastCloneJob: kpopFastCloneJob });
  if (kpopFastCloneJob.running) {
    const text = kpopFastCloneJob.maxDocs > 0 ? `${kpopFastCloneJob.captured}/${kpopFastCloneJob.maxDocs}` : "RUN";
    kpopFastSetBadge(text.length <= 4 ? text : String(kpopFastCloneJob.captured));
  }
}

async function kpopFastWaitForTab(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "")) {
      await wait(300);
      return tab;
    }
    await wait(250);
  }
  throw new Error("Timed out waiting for NamuWiki document to finish loading.");
}

async function kpopFastCaptureAssets(prep, concurrency = 4) {
  const assets = Array.isArray(prep.assets) ? prep.assets : [];
  const result = { resolved: 0, noQueue: 0, failed: 0, rejected: 0 };
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= assets.length) return;
      const asset = assets[index];
      const item = await captureOneAsset({
        rootTitle: prep.rootTitle,
        sourceTitle: prep.sourceTitle,
        pageUrl: prep.pageUrl,
        asset,
      });
      result.rejected += Number(item.rejected || 0);
      if (item.status === "resolved") result.resolved += 1;
      else if (item.status === "no_queue") result.noQueue += 1;
      else result.failed += 1;
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, assets.length)) }, () => worker()));
  return result;
}

async function kpopRunFastClone({ rootTitle, maxDepth, maxDocs }) {
  const health = await helperHealth();
  if (!health.ok) throw new Error("Local helper is not running.");

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.url || !/^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(activeTab.url)) {
    throw new Error("Open the root NamuWiki document in this Chrome tab first.");
  }

  const depthLimit = Math.max(0, Math.min(3, Number(maxDepth || 0) || 0));
  const docLimit = Math.max(1, Math.min(200, Number(maxDocs || 25) || 25));
  const root = String(rootTitle || "").trim() || "RESCENE";
  const queue = [{ url: activeTab.url, depth: 0 }];
  const seenUrls = new Set();
  const seenTitles = new Set();

  kpopFastCloneJob = {
    running: true,
    rootTitle: root,
    processed: 0,
    captured: 0,
    failed: 0,
    queued: 1,
    current: "",
    maxDepth: depthLimit,
    maxDocs: docLimit,
    errors: [],
    done: false,
  };
  await kpopFastPersist();

  while (queue.length && kpopFastCloneJob.processed < docLimit) {
    const item = queue.shift();
    if (!item || seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);

    let tabId = null;
    try {
      const tab = await chrome.tabs.create({ url: item.url, active: false });
      tabId = tab.id;
      if (!tabId) throw new Error("Could not open background document tab.");
      await kpopFastWaitForTab(tabId);

      const prep = await tabCapturePayload(tabId, root, item.depth);
      if (seenTitles.has(prep.sourceTitle)) continue;
      seenTitles.add(prep.sourceTitle);

      kpopFastCloneJob.current = prep.sourceTitle;
      kpopFastCloneJob.processed += 1;
      await kpopFastPersist();

      const media = await kpopFastCaptureAssets(prep, 4);
      kpopFastCloneJob.captured += 1;
      kpopFastCloneJob.lastMedia = media;

      if (item.depth < depthLimit) {
        for (const link of prep.internalLinks || []) {
          if (queue.length + kpopFastCloneJob.processed >= docLimit * 4) break;
          const url = String(link.href || "").trim();
          if (!url || seenUrls.has(url)) continue;
          queue.push({ url, depth: item.depth + 1 });
        }
      }

      kpopFastCloneJob.queued = queue.length;
    } catch (error) {
      kpopFastCloneJob.processed += 1;
      kpopFastCloneJob.failed += 1;
      kpopFastCloneJob.errors = [...kpopFastCloneJob.errors, `${item.url}: ${error?.message || error}`].slice(-10);
    } finally {
      if (tabId) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      kpopFastCloneJob.current = "";
      await kpopFastPersist();
      await wait(200);
    }
  }

  kpopFastCloneJob.running = false;
  kpopFastCloneJob.done = true;
  kpopFastCloneJob.queued = queue.length;
  await kpopFastPersist();
  kpopFastSetBadge(kpopFastCloneJob.failed ? "!" : "✓", kpopFastCloneJob.failed ? "#b00020" : "#0a7a2f");
}

function kpopStartFastClone(options) {
  if (kpopFastCloneJob.running) throw new Error("A clone job is already running.");
  kpopRunFastClone(options).catch(async (error) => {
    kpopFastCloneJob.running = false;
    kpopFastCloneJob.done = true;
    kpopFastCloneJob.failed += 1;
    kpopFastCloneJob.errors = [...kpopFastCloneJob.errors, error?.message || String(error)].slice(-10);
    await kpopFastPersist();
    kpopFastSetBadge("!", "#b00020");
  });
  return { ...kpopFastCloneJob, running: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-start-fast-clone") {
    try { sendResponse({ ok: true, job: kpopStartFastClone(message.options || {}) }); }
    catch (error) { sendResponse({ ok: false, error: error?.message || String(error) }); }
    return;
  }

  if (message?.type === "kpoparkive-fast-clone-status") {
    chrome.storage.local.get(["kpoparkiveFastCloneJob"]).then((stored) => {
      sendResponse({ ok: true, job: stored.kpoparkiveFastCloneJob || kpopFastCloneJob });
    }).catch(() => sendResponse({ ok: true, job: kpopFastCloneJob }));
    return true;
  }
});
