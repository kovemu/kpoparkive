const KPOP_HELPER_CONTROLLER = "http://127.0.0.1:43117";
const KPOP_RUNNER_URL = chrome.runtime.getURL("runner.html");
let kpopRunnerWatch = { processed: -1, since: 0, recovering: false };

async function kpopControllerJson(path, init = {}) {
  const response = await fetch(`${KPOP_HELPER_CONTROLLER}${path}`, {
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

async function kpopEnsureRunnerTab({ reloadExisting = false } = {}) {
  const tabs = await chrome.tabs.query({ url: `${KPOP_RUNNER_URL}*` });
  const existing = tabs.find((tab) => tab.id);
  if (existing?.id) {
    if (reloadExisting) {
      try { await chrome.tabs.reload(existing.id); } catch {}
      try { return await chrome.tabs.get(existing.id); } catch { return existing; }
    }
    return existing;
  }
  return chrome.tabs.create({ url: KPOP_RUNNER_URL, active: false, pinned: true });
}

async function kpopWatchRunner(job) {
  if (!job?.running || Number(job.queued || 0) <= 0 || Number(job.leased || 0) > 0) {
    kpopRunnerWatch = { processed: Number(job?.processed || 0), since: 0, recovering: false };
    return;
  }

  const processed = Number(job.processed || 0);
  if (kpopRunnerWatch.processed !== processed) {
    kpopRunnerWatch = { processed, since: Date.now(), recovering: false };
    return;
  }
  if (!kpopRunnerWatch.since) kpopRunnerWatch.since = Date.now();
  if (kpopRunnerWatch.recovering || Date.now() - kpopRunnerWatch.since < 2500) return;

  kpopRunnerWatch.recovering = true;
  try {
    await kpopEnsureRunnerTab({ reloadExisting: true });
    kpopRunnerWatch = { processed, since: Date.now(), recovering: false };
  } catch {
    kpopRunnerWatch.recovering = false;
  }
}

async function kpopControllerStatus() {
  try {
    const result = await kpopControllerJson("/clone/status");
    const job = result.job || null;
    await kpopWatchRunner(job);
    return { ok: true, job };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function kpopStartHelperClone(options = {}) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.url || !/^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(activeTab.url)) {
    throw new Error("Open the root NamuWiki document in this Chrome tab first.");
  }

  const rootTitle = String(options.rootTitle || "").trim() || "RESCENE";
  const maxDepth = Math.max(0, Math.min(3, Number(options.maxDepth || 0) || 0));
  const maxDocs = Math.max(1, Math.min(200, Number(options.maxDocs || 25) || 25));

  const result = await kpopControllerJson("/clone/start", {
    method: "POST",
    body: JSON.stringify({ rootTitle, rootUrl: activeTab.url, maxDepth, maxDocs }),
  });

  // A previous helper failure can leave runner.html open but dead. Because the
  // Import button is disabled while a job is already running, an explicit start
  // here means it is safe to restart the runner page and create fresh workers.
  await kpopEnsureRunnerTab({ reloadExisting: true });
  kpopRunnerWatch = { processed: Number(result?.job?.processed || 0), since: Date.now(), recovering: false };
  return result.job;
}

async function kpopRecoverRunner() {
  try {
    const status = await kpopControllerJson("/clone/status");
    const job = status?.job;
    if (!job?.running) return;

    const tabs = await chrome.tabs.query({ url: `${KPOP_RUNNER_URL}*` });
    const existing = tabs.find((tab) => tab.id);
    if (!existing) {
      await kpopEnsureRunnerTab();
      return;
    }

    // If a persisted job has queued work but no active leases, the previous
    // runner likely died while the helper was stopped or errored. Confirm the
    // idle state after a short grace period before reloading to avoid racing a
    // healthy worker between claims.
    if (Number(job.queued || 0) > 0 && Number(job.leased || 0) === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const confirm = await kpopControllerJson("/clone/status");
      const next = confirm?.job;
      if (
        next?.running &&
        Number(next.queued || 0) > 0 &&
        Number(next.leased || 0) === 0 &&
        Number(next.processed || 0) === Number(job.processed || 0)
      ) {
        await kpopEnsureRunnerTab({ reloadExisting: true });
      }
    }
  } catch {}
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-start-helper-clone") {
    kpopStartHelperClone(message.options || {})
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-helper-clone-status") {
    kpopControllerStatus().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-cancel-helper-clone") {
    kpopControllerJson("/clone/cancel", { method: "POST", body: "{}" })
      .then((result) => sendResponse({ ok: true, job: result.job || null }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => { kpopRecoverRunner(); });
chrome.runtime.onInstalled.addListener(() => { kpopRecoverRunner(); });
setTimeout(() => { kpopRecoverRunner(); }, 500);
