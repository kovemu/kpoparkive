const HELPER = "http://127.0.0.1:43117";
const MAX_BYTES = 8 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function utf8Base64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function validateBlob(blob, declaredWidth = 0, declaredHeight = 0) {
  if (!blob.size) return { valid: false, reason: "empty image" };
  if (blob.size > MAX_BYTES) return { valid: false, reason: "image exceeds 8 MB" };

  const type = (blob.type || "").toLowerCase();
  if (type === "image/svg+xml") {
    return {
      valid: true,
      width: declaredWidth || 0,
      height: declaredHeight || 0,
      visibleRatio: null,
      colorRange: null,
    };
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (error) {
    return { valid: false, reason: `image decode failed: ${error?.message || error}` };
  }

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
    if (visibleRatio > 0.98 && colorRange <= 1 && alphaRange <= 1) {
      return { valid: false, reason: "uniform blank image", width, height, visibleRatio, colorRange };
    }
    return { valid: true, width, height, visibleRatio, colorRange };
  } finally {
    bitmap.close?.();
  }
}

async function helperHealth() {
  try {
    const response = await fetch(`${HELPER}/health`, { cache: "no-store" });
    if (!response.ok) return false;
    const json = await response.json();
    return Boolean(json?.ok);
  } catch {
    return false;
  }
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
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `helper HTTP ${response.status}`);
  return body;
}

async function captureCurrentTab(rootTitle) {
  if (!await helperHealth()) {
    throw new Error("Local helper is not running. In kpoparkive, run: npm run namu:capture-helper");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https:\/\/(?:www\.)?namu\.wiki\/w\//i.test(tab.url || "")) {
    throw new Error("Open a NamuWiki document in this Chrome tab first.");
  }

  const extracted = await chrome.tabs.sendMessage(tab.id, { type: "kpoparkive-extract-namu-images" });
  if (!extracted?.ok) throw new Error(extracted?.error || "Could not extract images from this page.");

  const results = {
    sourceTitle: extracted.sourceTitle,
    found: extracted.assets.length,
    resolved: 0,
    noQueue: 0,
    failed: 0,
    rejected: 0,
    details: [],
    debug: extracted.debug || null,
  };

  for (const asset of extracted.assets) {
    let done = false;
    let lastError = "no candidate succeeded";
    for (const candidate of unique(asset.urls).slice(0, 8)) {
      try {
        const response = await fetch(candidate, {
          credentials: "include",
          cache: "force-cache",
          referrer: extracted.pageUrl,
          referrerPolicy: "strict-origin-when-cross-origin",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
        if (!contentType.startsWith("image/")) throw new Error(`not image: ${contentType || "unknown MIME"}`);
        const blob = await response.blob();
        const visual = await validateBlob(blob, asset.width, asset.height);
        if (!visual.valid) {
          results.rejected += 1;
          throw new Error(visual.reason || "visual validation failed");
        }

        const helper = await sendAsset(blob, {
          rootTitle,
          sourceTitle: extracted.sourceTitle,
          fileName: asset.fileName,
          sourceUrl: response.url || candidate,
          pageUrl: extracted.pageUrl,
          contentType,
          width: visual.width || asset.width || 0,
          height: visual.height || asset.height || 0,
          visual,
        });

        if (helper.status === "resolved") results.resolved += 1;
        else if (helper.status === "no_queue") results.noQueue += 1;
        results.details.push({ fileName: asset.fileName, status: helper.status, bytes: helper.bytes, width: helper.width, height: helper.height });
        done = true;
        break;
      } catch (error) {
        lastError = error?.message || String(error);
      }
    }
    if (!done) {
      results.failed += 1;
      results.details.push({ fileName: asset.fileName, status: "failed", error: lastError });
    }
    await sleep(120);
  }
  return results;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "kpoparkive-capture-current-page") {
    captureCurrentTab(String(message.rootTitle || "RESCENE").trim() || "RESCENE")
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "kpoparkive-helper-health") {
    helperHealth().then((ok) => sendResponse({ ok })).catch(() => sendResponse({ ok: false }));
    return true;
  }
});
