const RAW_ASSET_HELPER = "http://127.0.0.1:43120";

function rawAssetCanonical(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[?#].*$/, "")
    .replace(/[ \t]+/g, " ")
    .toLowerCase();
}

function rawAssetDisplay(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[ \t]+/g, " ");
}

async function rawAssetHelperHealth() {
  try {
    const response = await fetch(`${RAW_ASSET_HELPER}/health`, { cache: "no-store" });
    if (!response.ok) return { ok: false };
    return await response.json();
  } catch {
    return { ok: false };
  }
}

async function rawAssetPlan(rootTitle, sourceTitle = rootTitle) {
  const response = await fetch(`${RAW_ASSET_HELPER}/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rootTitle, sourceTitle }),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text }; }
  if (!response.ok || !body?.ok) throw new Error(body?.error || `raw asset helper HTTP ${response.status}`);
  return body;
}

function rawAssetTargetFromTabUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/w\/(.+)$/);
    if (!match) return "";
    return rawAssetCanonical(decodeURIComponent(match[1]));
  } catch {
    return "";
  }
}

async function rawAssetFindExistingTab(fileName) {
  const target = rawAssetCanonical(fileName);
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => /^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "") && rawAssetTargetFromTabUrl(tab.url || "") === target) || null;
}

function rawAssetMatchesText(value, target) {
  const text = rawAssetCanonical(value);
  return Boolean(text && (text === target || text.includes(target) || target.includes(text)));
}

function rawAssetPick(extracted, fileName) {
  const target = rawAssetCanonical(fileName);
  const assets = Array.isArray(extracted?.assets) ? extracted.assets : [];

  const exact = assets.find((asset) => rawAssetCanonical(asset?.fileName) === target);
  if (exact) return exact;

  const semantic = assets.find((asset) =>
    rawAssetMatchesText(asset?.alt, target) ||
    rawAssetMatchesText(asset?.title, target) ||
    rawAssetMatchesText(asset?.contextText, target),
  );
  if (semantic) return semantic;

  const sourceTarget = rawAssetCanonical(extracted?.sourceTitle || "");
  if (sourceTarget === target) {
    const namuContent = assets.filter((asset) => Array.isArray(asset?.urls) && asset.urls.some((url) => {
      try {
        const parsed = new URL(url);
        return parsed.hostname === "i.namu.wiki" && parsed.pathname.startsWith("/i/");
      } catch { return false; }
    }));
    if (namuContent.length === 1) return namuContent[0];
  }

  return null;
}

async function rawAssetExtractUntilFound(tabId, fileName) {
  let lastDebug = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    try {
      const extracted = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-extract-namu-images" });
      if (extracted?.ok) {
        lastDebug = extracted.debug || null;
        const asset = rawAssetPick(extracted, fileName);
        if (asset) return { extracted, asset };
      }
    } catch {}

    if (attempt === 2) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch {}
    }
    await wait(attempt < 3 ? 1200 : 3000);
  }

  const detail = lastDebug
    ? ` images=${lastDebug.images || 0}, labeled=${lastDebug.labeledAssets || 0}, anonymous=${lastDebug.anonymousAssets || 0}`
    : "";
  throw new Error(`Could not locate ${fileName} on its NamuWiki file page.${detail} If verification is visible, complete it and run the resolver again.`);
}

async function rawAssetCaptureOne(rootTitle, item) {
  const fileName = rawAssetDisplay(item?.fileName || item?.sourceRef || "");
  if (!fileName) throw new Error("Raw asset item has no filename.");

  let tab = await rawAssetFindExistingTab(fileName);
  let createdTab = false;
  if (!tab?.id) {
    const url = `https://namu.wiki/w/${encodeURIComponent(`파일:${fileName}`)}`;
    tab = await chrome.tabs.create({ url, active: false });
    createdTab = true;
  }
  if (!tab?.id) throw new Error(`Could not open NamuWiki file page for ${fileName}`);

  let resolved = false;
  try {
    await waitForTab(tab.id, 30000);
    const { extracted, asset } = await rawAssetExtractUntilFound(tab.id, fileName);
    const result = await captureOneAsset({
      rootTitle,
      sourceTitle: String(item?.sourceTitle || rootTitle),
      pageUrl: extracted.pageUrl || tab.url,
      asset: {
        ...asset,
        fileName,
        semanticFileName: fileName,
        alt: asset.alt || fileName,
      },
    });
    if (result?.status !== "resolved") {
      throw new Error(`${fileName}: capture returned ${result?.status || "unknown"}${result?.detail?.error ? ` (${result.detail.error})` : ""}`);
    }
    resolved = true;
    return result;
  } finally {
    if (createdTab && resolved) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }
}

function rawAssetDefaultJob() {
  return {
    id: "raw-assets",
    running: false,
    done: false,
    rootTitle: "",
    sourceTitle: "",
    required: 0,
    planned: 0,
    processed: 0,
    resolved: 0,
    failed: 0,
    remaining: null,
    current: "",
    errors: [],
  };
}

let rawAssetJob = rawAssetDefaultJob();

async function rawAssetSaveJob() {
  await chrome.storage.local.set({ kpoparkiveRawAssetJob: rawAssetJob });
}

async function runRawAssetResolver({ rootTitle, sourceTitle }) {
  const health = await rawAssetHelperHealth();
  if (!health.ok) throw new Error("Raw asset helper is not running. Restart: npm.cmd run namu:capture-helper");

  const plan = await rawAssetPlan(rootTitle, sourceTitle);
  rawAssetJob.required = Number(plan.requiredCount || 0);
  rawAssetJob.planned = Number(plan.missingCount || 0);
  rawAssetJob.remaining = rawAssetJob.planned;
  await rawAssetSaveJob();

  for (const item of plan.missingFiles || []) {
    rawAssetJob.current = item.fileName || item.sourceRef || "";
    await rawAssetSaveJob();
    try {
      await rawAssetCaptureOne(rootTitle, item);
      rawAssetJob.resolved += 1;
    } catch (error) {
      rawAssetJob.failed += 1;
      rawAssetJob.errors = [...rawAssetJob.errors, `${rawAssetJob.current}: ${error?.message || error}`].slice(-20);
    }
    rawAssetJob.processed += 1;
    await rawAssetSaveJob();
    await wait(500);
  }

  try {
    const verification = await rawAssetPlan(rootTitle, sourceTitle);
    rawAssetJob.remaining = Number(verification.missingCount || 0);
  } catch (error) {
    rawAssetJob.errors = [...rawAssetJob.errors, `Verification: ${error?.message || error}`].slice(-20);
  }
  rawAssetJob.current = "";
  rawAssetJob.running = false;
  rawAssetJob.done = true;
  await rawAssetSaveJob();
}

function startRawAssetResolver(options = {}) {
  if (rawAssetJob.running) throw new Error("Raw asset resolver is already running.");
  const rootTitle = String(options.rootTitle || "RESCENE").normalize("NFKC").trim() || "RESCENE";
  const sourceTitle = String(options.sourceTitle || rootTitle).normalize("NFKC").trim() || rootTitle;
  rawAssetJob = {
    ...rawAssetDefaultJob(),
    running: true,
    rootTitle,
    sourceTitle,
  };
  rawAssetSaveJob();
  runRawAssetResolver({ rootTitle, sourceTitle }).catch(async (error) => {
    rawAssetJob.running = false;
    rawAssetJob.done = true;
    rawAssetJob.failed += 1;
    rawAssetJob.errors = [...rawAssetJob.errors, error?.message || String(error)].slice(-20);
    await rawAssetSaveJob();
  });
  return { ...rawAssetJob };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-start-raw-asset-resolver") {
    try {
      sendResponse({ ok: true, job: startRawAssetResolver(message.options || {}) });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return;
  }

  if (message?.type === "kpoparkive-raw-asset-status") {
    chrome.storage.local.get(["kpoparkiveRawAssetJob"]).then((stored) => {
      sendResponse({ ok: true, job: stored.kpoparkiveRawAssetJob || rawAssetJob });
    }).catch(() => sendResponse({ ok: true, job: rawAssetJob }));
    return true;
  }

  if (message?.type === "kpoparkive-raw-asset-health") {
    rawAssetHelperHealth().then((result) => sendResponse(result)).catch(() => sendResponse({ ok: false }));
    return true;
  }
});
