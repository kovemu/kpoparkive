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

function kpopTitleFromDocumentUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/w\/(.+)$/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]).normalize("NFKC").trim(); }
    catch { return match[1].normalize("NFKC").trim(); }
  } catch { return ""; }
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

async function kpopCloseRunnerTabs() {
  const tabs = await chrome.tabs.query({ url: `${KPOP_RUNNER_URL}*` });
  const ids = tabs.map((tab) => tab.id).filter(Boolean);
  if (!ids.length) return;
  try { await chrome.tabs.remove(ids); } catch {}
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

  await kpopEnsureRunnerTab({ reloadExisting: true });
  kpopRunnerWatch = { processed: Number(result?.job?.processed || 0), since: Date.now(), recovering: false };
  return result.job;
}

async function kpopResetHelperClone() {
  try { await kpopControllerJson("/clone/cancel", { method: "POST", body: "{}" }); } catch {}
  await kpopCloseRunnerTabs();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const result = await kpopControllerJson("/clone/reset", { method: "POST", body: "{}" });
  kpopRunnerWatch = { processed: -1, since: 0, recovering: false };
  try { await chrome.action.setBadgeText({ text: "" }); } catch {}
  return result.job || null;
}

async function kpopCaptureEditRawSource(options = {}) {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sourceTitle = kpopTitleFromDocumentUrl(activeTab?.url || "");
  if (!activeTab?.url || !sourceTitle) throw new Error("Open the NamuWiki document (/w/...) you want to test first.");

  const rootTitle = String(options.rootTitle || "").normalize("NFKC").trim() || sourceTitle;
  const sourcePageUrl = `https://namu.wiki/w/${encodeURIComponent(sourceTitle)}`;
  const editUrl = `https://namu.wiki/edit/${encodeURIComponent(sourceTitle)}`;
  const editTab = await chrome.tabs.create({ url: editUrl, active: false });
  if (!editTab?.id) throw new Error("Could not open the NamuWiki edit page.");

  let extracted = null;
  let verificationShown = false;
  const started = Date.now();

  try {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      let tab;
      try { tab = await chrome.tabs.get(editTab.id); }
      catch { throw new Error("The NamuWiki edit tab was closed before source capture finished."); }

      if (tab.status === "complete") {
        try {
          const result = await chrome.tabs.sendMessage(editTab.id, { type: "kpoparkive-extract-namu-edit-source" });
          if (result?.ok && result.raw) {
            extracted = result;
            break;
          }
          if (result?.blocked && !verificationShown) {
            verificationShown = true;
            try { await chrome.tabs.update(editTab.id, { active: true }); } catch {}
          }
        } catch {}
      }

      if (!verificationShown && Date.now() - started > 8000) {
        verificationShown = true;
        try { await chrome.tabs.update(editTab.id, { active: true }); } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!extracted?.raw) {
      try { await chrome.tabs.update(editTab.id, { active: true }); } catch {}
      throw new Error("Could not read the edit source within 90 seconds. If NamuWiki verification is visible, complete it in the opened edit tab and run Capture Raw Source again.");
    }

    const saved = await kpopControllerJson("/raw-source", {
      method: "POST",
      body: JSON.stringify({
        rootTitle,
        sourceTitle,
        pageUrl: sourcePageUrl,
        editUrl: extracted.editUrl || editUrl,
        raw: extracted.raw,
        extractionMethod: extracted.extractionMethod || "normal-chrome-edit",
        signalScore: Number(extracted.signalScore || 0),
      }),
    });

    try { await chrome.tabs.remove(editTab.id); } catch {}
    return {
      ...saved,
      sourceTitle,
      charCount: Number(extracted.charCount || extracted.raw.length),
      extractionMethod: extracted.extractionMethod || "normal-chrome-edit",
      previewUrl: `https://kpoparkive.vercel.app/admin/namu-raw-preview/${encodeURIComponent(sourceTitle)}`,
    };
  } catch (error) {
    throw error;
  }
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

  if (message?.type === "kpoparkive-reset-helper-clone") {
    kpopResetHelperClone()
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-capture-edit-raw-source") {
    kpopCaptureEditRawSource(message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
});

chrome.runtime.onStartup.addListener(() => { kpopRecoverRunner(); });
chrome.runtime.onInstalled.addListener(() => { kpopRecoverRunner(); });
setTimeout(() => { kpopRecoverRunner(); }, 500);
