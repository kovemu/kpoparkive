const HELPER = "http://127.0.0.1:43117";
const MAX_BYTES = 32 * 1024 * 1024;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

function syntheticName(asset, contentType, candidate) {
  if (asset.fileName) return asset.fileName;
  const ext = ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
  })[contentType] || String(candidate || "").match(/\.([a-z0-9]+)(?:$|[?#])/i)?.[1] || "bin";
  return `__anonymous__${String(asset.domIndex ?? 0).padStart(4, "0")}.${ext}`;
}

async function validateBlob(blob, declaredWidth = 0, declaredHeight = 0) {
  if (!blob.size) return { valid: false, reason: "empty image" };
  if (blob.size > MAX_BYTES) return { valid: false, reason: "image exceeds 8 MB" };
  const type = (blob.type || "").toLowerCase();
  if (type === "image/svg+xml") {
    return { valid: true, width: declaredWidth || 0, height: declaredHeight || 0, visibleRatio: null, colorRange: null };
  }

  let bitmap;
  try { bitmap = await createImageBitmap(blob); }
  catch (error) { return { valid: false, reason: `image decode failed: ${error?.message || error}` }; }

  try {
    const width = bitmap.width || declaredWidth || 0;
    const height = bitmap.height || declaredHeight || 0;
    if (width < 8 || height < 8) return { valid: false, reason: `placeholder-sized image ${width}x${height}`, width, height };

    const canvas = new OffscreenCanvas(32, 32);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.clearRect(0, 0, 32, 32);
    ctx.drawImage(bitmap, 0, 0, 32, 32);
    const data = ctx.getImageData(0, 0, 32, 32).data;
    let visible = 0;
    let minR = 255, maxR = 0, minG = 255, maxG = 0, minB = 255, maxB = 0, minA = 255, maxA = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
      minA = Math.min(minA, a); maxA = Math.max(maxA, a);
      if (a <= 8) continue;
      visible += 1;
      minR = Math.min(minR, r); maxR = Math.max(maxR, r);
      minG = Math.min(minG, g); maxG = Math.max(maxG, g);
      minB = Math.min(minB, b); maxB = Math.max(maxB, b);
    }
    const visibleRatio = visible / (32 * 32);
    if (visibleRatio < 0.002) return { valid: false, reason: "nearly fully transparent image", width, height, visibleRatio };
    const colorRange = Math.max(maxR - minR, maxG - minG, maxB - minB);
    const alphaRange = maxA - minA;
    if (visibleRatio > 0.98 && colorRange <= 1 && alphaRange <= 1) return { valid: false, reason: "uniform blank image", width, height, visibleRatio, colorRange };
    return { valid: true, width, height, visibleRatio, colorRange };
  } finally {
    bitmap.close?.();
  }
}

async function helperHealth() {
  try {
    const response = await fetch(`${HELPER}/health`, { cache: "no-store" });
    if (!response.ok) return { ok: false };
    const json = await response.json();
    return {
      ok: Boolean(json?.ok),
      supabaseHost: json?.supabaseHost || json?.supabase || "",
      stats: json?.stats || null,
      documentCapture: json?.documentCapture || null,
      recursiveClone: Boolean(json?.recursiveClone),
    };
  } catch {
    return { ok: false };
  }
}

async function sendRenderedDocument(documentCapture, rootTitle) {
  const response = await fetch(`${HELPER}/document`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      rootTitle,
      sourceTitle: documentCapture.sourceTitle,
      pageUrl: documentCapture.pageUrl,
      pageTitle: documentCapture.pageTitle,
      articleHtml: documentCapture.articleHtml,
      styleCss: documentCapture.styleCss || "",
      captureVersion: documentCapture.captureVersion,
      meta: documentCapture.meta || {},
    }),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `document helper HTTP ${response.status}`);
  return body;
}

async function sendAsset(blob, meta) {
  const response = await fetch(`${HELPER}/asset`, {
    method: "POST",
    headers: {
      "Content-Type": blob.type || meta.contentType || "application/octet-stream",
      "X-Kpoparkive-Meta": utf8Base64(JSON.stringify(meta)),
    },
    body: await blob.arrayBuffer(),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `helper HTTP ${response.status}`);
  return body;
}

async function tabCapturePayload(tabId, rootTitle, crawlDepth = 0) {
  const rendered = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-extract-namu-rendered-document" });
  if (!rendered?.ok) throw new Error(rendered?.error || "Could not extract rendered article DOM.");

  let links = { ok: true, links: [] };
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-extract-namu-links" });
    if (response?.ok) links = response;
  } catch {}

  rendered.meta = {
    ...(rendered.meta || {}),
    crawlDepth,
    internalLinks: links.links || [],
  };
  const browserDom = await sendRenderedDocument(rendered, rootTitle);

  const extracted = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-extract-namu-images" });
  if (!extracted?.ok) throw new Error(extracted?.error || "Could not extract images from this page.");

  return {
    rootTitle,
    sourceTitle: extracted.sourceTitle,
    pageUrl: extracted.pageUrl,
    assets: extracted.assets || [],
    debug: extracted.debug || null,
    browserDom,
    internalLinks: links.links || [],
  };
}

async function prepareCapture(rootTitle) {
  const health = await helperHealth();
  if (!health.ok) throw new Error("Local helper is not running. In kpoparkive, run: npm run namu:capture-helper");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "")) throw new Error("Open a NamuWiki document in this Chrome tab first.");

  let result;
  try {
    result = await tabCapturePayload(tab.id, rootTitle, 0);
  } catch (error) {
    const extracted = await chrome.tabs.sendMessage(tab.id, { type: "kpoparkive-extract-namu-images" });
    if (!extracted?.ok) throw error;
    result = {
      rootTitle,
      sourceTitle: extracted.sourceTitle,
      pageUrl: extracted.pageUrl,
      assets: extracted.assets || [],
      debug: extracted.debug || null,
      browserDom: { ok: false, error: error?.message || String(error) },
      internalLinks: [],
    };
  }

  return { ...result, helper: health };
}

async function captureOneAsset(payload) {
  const rootTitle = String(payload?.rootTitle || "RESCENE").trim() || "RESCENE";
  const sourceTitle = String(payload?.sourceTitle || "").trim();
  const pageUrl = String(payload?.pageUrl || "");
  const asset = payload?.asset || {};
  if (!sourceTitle || !pageUrl || !Array.isArray(asset.urls)) throw new Error("Capture asset payload is incomplete.");

  let lastError = "no candidate succeeded";
  let rejected = 0;
  for (const candidate of unique(asset.urls).slice(0, 8)) {
    try {
      const response = await fetch(candidate, { credentials: "include", cache: "force-cache", referrer: pageUrl, referrerPolicy: "strict-origin-when-cross-origin" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
      const wantsVideo = asset?.mediaType === "video";
      const supportedVideo = /^video\/(?:mp4|webm|quicktime)$/i.test(contentType);
      if (wantsVideo ? !supportedVideo : !contentType.startsWith("image/")) {
        throw new Error(`unexpected media type: ${contentType || "unknown MIME"}`);
      }

      const blob = await response.blob();
      if (blob.size > MAX_BYTES) throw new Error(`media exceeds ${Math.round(MAX_BYTES / 1024 / 1024)} MB`);

      const visual = wantsVideo
        ? {
            valid: true,
            width: Number(asset.width || 0),
            height: Number(asset.height || 0),
            visibleRatio: null,
            colorRange: null,
          }
        : await validateBlob(blob, asset.width, asset.height);
      if (!visual.valid) {
        rejected += 1;
        throw new Error(visual.reason || "visual validation failed");
      }

      const fileName = syntheticName(asset, contentType, response.url || candidate);
      const helper = await sendAsset(blob, {
        rootTitle,
        sourceTitle,
        fileName,
        semanticFileName: asset.fileName || null,
        anonymous: Boolean(asset.anonymous),
        domIndex: asset.domIndex ?? null,
        contextText: asset.contextText || "",
        heading: asset.heading || "",
        alt: asset.alt || "",
        title: asset.title || "",
        sourceUrl: response.url || candidate,
        pageUrl,
        contentType,
        mediaType: asset.mediaType || "image",
        width: visual.width || asset.width || 0,
        height: visual.height || asset.height || 0,
        visual,
        refreshExisting: Boolean(payload?.refreshExisting),
      });

      return {
        status: helper.status || "resolved",
        rejected,
        detail: {
          fileName,
          status: helper.status || "resolved",
          bytes: helper.bytes,
          width: helper.width,
          height: helper.height,
          anonymous: Boolean(asset.anonymous),
          matchedAs: helper.matchedAs || helper.fileName || null,
          matchReason: helper.matchReason || helper.matchMethod || null,
        },
      };
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }

  return { status: "failed", rejected, detail: { fileName: asset.fileName || `anonymous@${asset.domIndex ?? "?"}`, status: "failed", error: lastError } };
}

async function captureAssetsForDocument(prep) {
  const result = { resolved: 0, noQueue: 0, failed: 0, rejected: 0 };
  for (const asset of prep.assets) {
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
  return result;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTab(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete" && /^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "")) {
      await wait(900);
      return tab;
    }
    await wait(350);
  }
  throw new Error("Timed out waiting for NamuWiki document to finish loading.");
}

let cloneJob = {
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

async function runRecursiveClone({ rootTitle, maxDepth, maxDocs }) {
  const health = await helperHealth();
  if (!health.ok) throw new Error("Local helper is not running.");
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab?.id || !/^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(activeTab.url || "")) {
    throw new Error("Open the root NamuWiki document in this Chrome tab first.");
  }

  const depthLimit = Math.max(0, Math.min(3, Number(maxDepth || 0) || 0));
  const docLimit = Math.max(1, Math.min(200, Number(maxDocs || 25) || 25));
  const root = String(rootTitle || "").trim() || "RESCENE";
  const queue = [{ url: activeTab.url, depth: 0, tabId: activeTab.id, temporary: false }];
  const seenUrls = new Set();
  const seenTitles = new Set();

  cloneJob = {
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
  await chrome.storage.local.set({ kpoparkiveCloneJob: cloneJob });

  while (queue.length && cloneJob.processed < docLimit) {
    const item = queue.shift();
    if (!item || seenUrls.has(item.url)) continue;
    seenUrls.add(item.url);
    let tabId = item.tabId;
    let temporary = item.temporary;

    try {
      if (!tabId) {
        const tab = await chrome.tabs.create({ url: item.url, active: false });
        tabId = tab.id;
        temporary = true;
      }
      if (!tabId) throw new Error("Could not open linked document tab.");
      await waitForTab(tabId);

      const prep = await tabCapturePayload(tabId, root, item.depth);
      if (seenTitles.has(prep.sourceTitle)) continue;
      seenTitles.add(prep.sourceTitle);
      cloneJob.current = prep.sourceTitle;
      cloneJob.processed += 1;
      const media = await captureAssetsForDocument(prep);
      cloneJob.captured += 1;

      if (item.depth < depthLimit) {
        for (const link of prep.internalLinks || []) {
          if (queue.length + cloneJob.processed >= docLimit * 4) break;
          const url = String(link.href || "").trim();
          if (!url || seenUrls.has(url)) continue;
          queue.push({ url, depth: item.depth + 1, tabId: null, temporary: true });
        }
      }
      cloneJob.queued = queue.length;
      cloneJob.lastMedia = media;
    } catch (error) {
      cloneJob.processed += 1;
      cloneJob.failed += 1;
      cloneJob.errors = [...cloneJob.errors, `${item.url}: ${error?.message || error}`].slice(-10);
    } finally {
      if (temporary && tabId) {
        try { await chrome.tabs.remove(tabId); } catch {}
      }
      cloneJob.current = "";
      await chrome.storage.local.set({ kpoparkiveCloneJob: cloneJob });
      await wait(900);
    }
  }

  cloneJob.running = false;
  cloneJob.done = true;
  cloneJob.queued = queue.length;
  await chrome.storage.local.set({ kpoparkiveCloneJob: cloneJob });
}

function startRecursiveClone(options) {
  if (cloneJob.running) throw new Error("A recursive clone job is already running.");
  runRecursiveClone(options).catch(async (error) => {
    cloneJob.running = false;
    cloneJob.done = true;
    cloneJob.failed += 1;
    cloneJob.errors = [...cloneJob.errors, error?.message || String(error)].slice(-10);
    await chrome.storage.local.set({ kpoparkiveCloneJob: cloneJob });
  });
  return { ...cloneJob, running: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-prepare-capture") {
    prepareCapture(String(message.rootTitle || "RESCENE").trim() || "RESCENE")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-capture-one-asset") {
    captureOneAsset(message.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-start-recursive-clone") {
    try { sendResponse({ ok: true, job: startRecursiveClone(message.options || {}) }); }
    catch (error) { sendResponse({ ok: false, error: error?.message || String(error) }); }
    return;
  }

  if (message?.type === "kpoparkive-recursive-clone-status") {
    chrome.storage.local.get(["kpoparkiveCloneJob"]).then((stored) => {
      sendResponse({ ok: true, job: stored.kpoparkiveCloneJob || cloneJob });
    }).catch(() => sendResponse({ ok: true, job: cloneJob }));
    return true;
  }

  if (message?.type === "kpoparkive-helper-health") {
    helperHealth().then((health) => sendResponse(health)).catch(() => sendResponse({ ok: false }));
    return true;
  }
});
