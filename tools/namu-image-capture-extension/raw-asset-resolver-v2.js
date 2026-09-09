const RAW_ASSET_HELPER_V2 = "http://127.0.0.1:43120";

function rawAssetV2Canonical(value) {
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

function rawAssetV2Display(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .trim()
    .replace(/^(?:파일|File):/i, "")
    .replace(/[ \t]+/g, " ");
}

function rawAssetV2B64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function rawAssetV2HelperHealth() {
  try {
    const response = await fetch(`${RAW_ASSET_HELPER_V2}/health`, { cache: "no-store" });
    if (!response.ok) return { ok: false };
    return await response.json();
  } catch {
    return { ok: false };
  }
}

async function rawAssetV2Plan(rootTitle, sourceTitle = rootTitle) {
  const response = await fetch(`${RAW_ASSET_HELPER_V2}/plan`, {
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

function rawAssetV2TargetFromTabUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/w\/(.+)$/);
    if (!match) return "";
    return rawAssetV2Canonical(decodeURIComponent(match[1]));
  } catch {
    return "";
  }
}

async function rawAssetV2FindExistingTab(fileName) {
  const target = rawAssetV2Canonical(fileName);
  const tabs = await chrome.tabs.query({});
  return tabs.find((tab) => /^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "") && rawAssetV2TargetFromTabUrl(tab.url || "") === target) || null;
}

function rawAssetV2MatchesText(value, target) {
  const text = rawAssetV2Canonical(value);
  return Boolean(text && (text === target || text.includes(target) || target.includes(text)));
}

function rawAssetV2PickImage(extracted, fileName) {
  const target = rawAssetV2Canonical(fileName);
  const assets = Array.isArray(extracted?.assets) ? extracted.assets : [];
  const exact = assets.filter((asset) => rawAssetV2Canonical(asset?.fileName) === target);
  if (exact.length) {
    return exact.sort((a, b) => Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0];
  }

  const semantic = assets.filter((asset) =>
    rawAssetV2MatchesText(asset?.alt, target) ||
    rawAssetV2MatchesText(asset?.title, target) ||
    rawAssetV2MatchesText(asset?.contextText, target),
  );
  if (semantic.length) {
    return semantic.sort((a, b) => Number(b?.width || 0) * Number(b?.height || 0) - Number(a?.width || 0) * Number(a?.height || 0))[0];
  }
  return null;
}

async function rawAssetV2ExtractUntilFound(tabId, fileName) {
  let lastDebug = null;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    try {
      const media = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-extract-namu-file-media" });
      if (media?.ok && Array.isArray(media.media) && media.media.length) {
        const candidate = media.media.find((item) => rawAssetV2Canonical(item?.fileName) === rawAssetV2Canonical(fileName)) || media.media[0];
        if (candidate?.urls?.length) return { kind: "video", extracted: media, asset: candidate };
      }
    } catch {}

    try {
      const extracted = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-extract-namu-images" });
      if (extracted?.ok) {
        lastDebug = extracted.debug || null;
        const asset = rawAssetV2PickImage(extracted, fileName);
        if (asset) return { kind: "image", extracted, asset };
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

async function rawAssetV2CaptureVideo(rootTitle, sourceTitle, fileName, pageUrl, asset) {
  let lastError = "no video candidate succeeded";
  for (const candidate of [...new Set(asset?.urls || [])].slice(0, 8)) {
    try {
      const response = await fetch(candidate, {
        credentials: "include",
        cache: "force-cache",
        referrer: pageUrl,
        referrerPolicy: "strict-origin-when-cross-origin",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      if (!contentType.startsWith("video/")) throw new Error(`not video: ${contentType || "unknown MIME"}`);
      const blob = await response.blob();
      if (!blob.size) throw new Error("empty video");
      if (blob.size > 32 * 1024 * 1024) throw new Error("video exceeds 32 MB");

      const meta = {
        rootTitle,
        sourceTitle,
        fileName,
        semanticFileName: fileName,
        sourceUrl: response.url || candidate,
        pageUrl,
        contentType,
        width: Number(asset?.width || 0),
        height: Number(asset?.height || 0),
        duration: asset?.duration ?? null,
      };
      const upload = await fetch(`${RAW_ASSET_HELPER_V2}/media`, {
        method: "POST",
        headers: {
          "Content-Type": contentType,
          "X-Kpoparkive-Meta": rawAssetV2B64(JSON.stringify(meta)),
        },
        body: await blob.arrayBuffer(),
      });
      const text = await upload.text();
      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch { body = { error: text }; }
      if (!upload.ok || !body?.ok) throw new Error(body?.error || `raw media helper HTTP ${upload.status}`);
      return { status: body.status || "resolved", detail: body };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  throw new Error(`${fileName}: ${lastError}`);
}

async function rawAssetV2CaptureOne(rootTitle, item) {
  const fileName = rawAssetV2Display(item?.fileName || item?.sourceRef || "");
  if (!fileName) throw new Error("Raw asset item has no filename.");

  let tab = await rawAssetV2FindExistingTab(fileName);
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
    const found = await rawAssetV2ExtractUntilFound(tab.id, fileName);
    let result;
    if (found.kind === "video") {
      result = await rawAssetV2CaptureVideo(
        rootTitle,
        String(item?.sourceTitle || rootTitle),
        fileName,
        found.extracted.pageUrl || tab.url,
        found.asset,
      );
    } else {
      result = await captureOneAsset({
        rootTitle,
        sourceTitle: String(item?.sourceTitle || rootTitle),
        pageUrl: found.extracted.pageUrl || tab.url,
        asset: {
          ...found.asset,
          fileName,
          semanticFileName: fileName,
          alt: found.asset.alt || fileName,
        },
      });
    }
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

function rawAssetV2DefaultJob() {
  return {
    id: "raw-assets-v2",
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

let rawAssetV2Job = rawAssetV2DefaultJob();

async function rawAssetV2SaveJob() {
  await chrome.storage.local.set({ kpoparkiveRawAssetJob: rawAssetV2Job });
}

async function runRawAssetV2Resolver({ rootTitle, sourceTitle }) {
  const health = await rawAssetV2HelperHealth();
  if (!health.ok) throw new Error("Raw asset helper is not running. Restart: npm.cmd run namu:capture-helper");

  const plan = await rawAssetV2Plan(rootTitle, sourceTitle);
  rawAssetV2Job.required = Number(plan.requiredCount || 0);
  rawAssetV2Job.planned = Number(plan.missingCount || 0);
  rawAssetV2Job.remaining = rawAssetV2Job.planned;
  await rawAssetV2SaveJob();

  for (const item of plan.missingFiles || []) {
    rawAssetV2Job.current = item.fileName || item.sourceRef || "";
    await rawAssetV2SaveJob();
    try {
      await rawAssetV2CaptureOne(rootTitle, item);
      rawAssetV2Job.resolved += 1;
    } catch (error) {
      rawAssetV2Job.failed += 1;
      rawAssetV2Job.errors = [...rawAssetV2Job.errors, `${rawAssetV2Job.current}: ${error?.message || error}`].slice(-20);
    }
    rawAssetV2Job.processed += 1;
    await rawAssetV2SaveJob();
    await wait(500);
  }

  try {
    const verification = await rawAssetV2Plan(rootTitle, sourceTitle);
    rawAssetV2Job.remaining = Number(verification.missingCount || 0);
  } catch (error) {
    rawAssetV2Job.errors = [...rawAssetV2Job.errors, `Verification: ${error?.message || error}`].slice(-20);
  }
  rawAssetV2Job.current = "";
  rawAssetV2Job.running = false;
  rawAssetV2Job.done = true;
  await rawAssetV2SaveJob();
}

function startRawAssetV2Resolver(options = {}) {
  if (rawAssetV2Job.running) throw new Error("Raw asset resolver is already running.");
  const rootTitle = String(options.rootTitle || "RESCENE").normalize("NFKC").trim() || "RESCENE";
  const sourceTitle = String(options.sourceTitle || rootTitle).normalize("NFKC").trim() || rootTitle;
  rawAssetV2Job = { ...rawAssetV2DefaultJob(), running: true, rootTitle, sourceTitle };
  rawAssetV2SaveJob();
  runRawAssetV2Resolver({ rootTitle, sourceTitle }).catch(async (error) => {
    rawAssetV2Job.running = false;
    rawAssetV2Job.done = true;
    rawAssetV2Job.failed += 1;
    rawAssetV2Job.errors = [...rawAssetV2Job.errors, error?.message || String(error)].slice(-20);
    await rawAssetV2SaveJob();
  });
  return { ...rawAssetV2Job };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-start-raw-asset-resolver") {
    try { sendResponse({ ok: true, job: startRawAssetV2Resolver(message.options || {}) }); }
    catch (error) { sendResponse({ ok: false, error: error?.message || String(error) }); }
    return;
  }

  if (message?.type === "kpoparkive-raw-asset-status") {
    chrome.storage.local.get(["kpoparkiveRawAssetJob"]).then((stored) => {
      sendResponse({ ok: true, job: stored.kpoparkiveRawAssetJob || rawAssetV2Job });
    }).catch(() => sendResponse({ ok: true, job: rawAssetV2Job }));
    return true;
  }

  if (message?.type === "kpoparkive-raw-asset-health") {
    rawAssetV2HelperHealth().then((result) => sendResponse(result)).catch(() => sendResponse({ ok: false }));
    return true;
  }
});
