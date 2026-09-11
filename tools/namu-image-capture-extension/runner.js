const KPOP_RUNNER_HELPER = "http://127.0.0.1:43117";
const KPOP_RUNNER_DOC_CONCURRENCY = 2;
const KPOP_RUNNER_MEDIA_CONCURRENCY = 4;
const KPOP_RUNNER_HELPER_RETRIES = 6;
const KPOP_RUNNER_ASSET_RETRIES = 5;
const KPOP_RUNNER_BACKOFF_MS = [1200, 2500, 5000, 10000, 20000, 30000];
const runnerStatusNode = document.getElementById("status");
let runnerKnownAssetUrls = new Set();
let runnerRootTitle = "";
let runnerCaptureMode = "dom";
let runnerStopped = false;

function runnerSetStatus(text) {
  if (runnerStatusNode) runnerStatusNode.textContent = text;
}

function runnerNormalizeUrl(value) {
  try { return new URL(String(value || ""), "https://namu.wiki").toString(); }
  catch { return String(value || "").trim(); }
}

function runnerTransientError(value) {
  const text = String(value?.message || value || "");
  return /(?:Supabase|storage upload|Bad Gateway|Gateway Time-out|Web server is down|SSL handshake failed|DatabaseTimeout|statement timeout|canceling statement|\b(?:500|502|503|504|520|521|522|523|524|525|544)\b|Failed to fetch|network|ECONN|ETIMEDOUT|fetch failed)/i.test(text);
}

async function runnerWait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function runnerJson(path, init = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < KPOP_RUNNER_HELPER_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${KPOP_RUNNER_HELPER}${path}`, {
        cache: "no-store",
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers || {}) },
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch { body = { error: text }; }
      if (response.ok) return body;

      const error = new Error(body?.error || `helper HTTP ${response.status}`);
      lastError = error;
      if (!runnerTransientError(error) || attempt === KPOP_RUNNER_HELPER_RETRIES - 1) throw error;
    } catch (error) {
      lastError = error;
      if (!runnerTransientError(error) || attempt === KPOP_RUNNER_HELPER_RETRIES - 1) throw error;
    }

    const delay = KPOP_RUNNER_BACKOFF_MS[Math.min(attempt, KPOP_RUNNER_BACKOFF_MS.length - 1)] + Math.floor(Math.random() * 350);
    runnerSetStatus(`Supabase/helper temporarily unavailable\nRetrying in ${Math.round(delay / 1000)}s...`);
    await runnerWait(delay);
  }
  throw lastError || new Error("helper request failed after retries");
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

async function runnerCaptureOneAssetWithRetry(prep, asset) {
  let lastError = null;
  for (let attempt = 0; attempt < KPOP_RUNNER_ASSET_RETRIES; attempt += 1) {
    try {
      return await captureOneAsset({
        rootTitle: prep.rootTitle,
        sourceTitle: prep.sourceTitle,
        pageUrl: prep.pageUrl,
        asset,
      });
    } catch (error) {
      lastError = error;
      if (!runnerTransientError(error) || attempt === KPOP_RUNNER_ASSET_RETRIES - 1) throw error;
      const delay = KPOP_RUNNER_BACKOFF_MS[Math.min(attempt, KPOP_RUNNER_BACKOFF_MS.length - 1)] + Math.floor(Math.random() * 350);
      await runnerWait(delay);
    }
  }
  throw lastError || new Error("asset capture failed after retries");
}

async function runnerWaitForSourceRender(sourceTitle, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await kpopRawStatus(sourceTitle);
    const rawAt = Date.parse(status?.rawExtractedAt || "");
    const renderedAt = Date.parse(status?.sourceRenderedAt || "");
    const freshRender = Boolean(
      status?.sourceRendered &&
      Number.isFinite(renderedAt) &&
      (!Number.isFinite(rawAt) || renderedAt >= rawAt)
    );
    if (freshRender) return status;
    await runnerWait(1200);
  }
  throw new Error(`Fresh source render did not complete within ${Math.round(timeoutMs / 1000)}s for ${sourceTitle}`);
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
        const item = await runnerCaptureOneAssetWithRetry(prep, asset);
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
    if (runnerCaptureMode === "raw") {
      const sourceTitle = kpopTitleFromDocumentUrl(task.url);
      if (!sourceTitle) throw new Error("Could not resolve raw document title from task URL.");

      runnerSetStatus(`RAW · ${sourceTitle}\nRoot source only · reading visible /raw/ page…`);
      const raw = await kpopCaptureRawBundle({
        rootTitle: runnerRootTitle,
        sourceTitle,
      });

      runnerSetStatus(
        `RAW · ${sourceTitle}\nRoot source saved\nIncludes referenced: ${raw.templatesDiscovered || 0}\nFiles referenced: ${raw.requiredFiles?.length || 0}\nUsing cached DOM/assets · waiting for The Tree render…`
      );

      const rendered = await runnerWaitForSourceRender(sourceTitle);
      const missingFiles = Array.isArray(rendered?.missingFiles) ? rendered.missingFiles : [];
      const missingTemplates = Array.isArray(rendered?.missingTemplates) ? rendered.missingTemplates : [];

      runnerSetStatus(
        `RAW · ${sourceTitle}\nThe Tree render complete\nMissing files: ${missingFiles.length}\nMissing templates: ${missingTemplates.length}`
      );

      await runnerJson("/clone/complete", {
        method: "POST",
        body: JSON.stringify({
          leaseId: task.leaseId,
          sourceTitle: raw.sourceTitle,
          internalLinks: raw.internalLinks || [],
          media: {
            resolved: 0,
            skippedKnown: Number(raw.requiredFiles?.length || 0),
            failed: 0,
            rawTemplates: 0,
            includesReferenced: Number(raw.templatesDiscovered || 0),
            missingFiles: missingFiles.length,
            missingTemplates: missingTemplates.length,
            missingFileNames: missingFiles.slice(0, 20),
            missingTemplateNames: missingTemplates.slice(0, 20),
            capturePolicy: "root-raw-only",
          },
        }),
      });

      return {
        ok: true,
        sourceTitle: raw.sourceTitle,
        rawTemplates: 0,
        includesReferenced: Number(raw.templatesDiscovered || 0),
        assetsResolved: 0,
        missingFiles,
        missingTemplates,
        rendered: true,
        capturePolicy: "root-raw-only",
      };
    }

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
    let claim;
    try {
      claim = await runnerJson("/clone/claim", { method: "POST", body: "{}" });
    } catch (error) {
      if (runnerTransientError(error)) {
        await runnerWait(5000);
        continue;
      }
      throw error;
    }

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
    runnerCaptureMode = job.captureMode === "raw" ? "raw" : "dom";

    if (runnerCaptureMode === "dom") {
      await runnerLoadKnownAssets(runnerRootTitle);
      runnerSetStatus(`Running DOM import · ${runnerRootTitle}\nKnown media cached: ${runnerKnownAssetUrls.size}`);
    } else {
      runnerSetStatus(`Running RAW crawl · ${runnerRootTitle}\nRoot RAW only · templates/assets come from cache and DOM captures`);
    }

    const concurrency = runnerCaptureMode === "raw" ? 1 : KPOP_RUNNER_DOC_CONCURRENCY;
    await Promise.all(Array.from({ length: concurrency }, (_, index) => runnerWorker(index)));
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
