const KPOP_FIDELITY_HELPER = "http://127.0.0.1:43119";

function kpopFidelityNorm(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function kpopFidelityTitleFromUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) return "";
    const match = url.pathname.match(/^\/w\/(.+)$/);
    if (!match) return "";
    try { return decodeURIComponent(match[1]).normalize("NFKC").trim(); }
    catch { return match[1].normalize("NFKC").trim(); }
  } catch { return ""; }
}

function kpopFidelityWait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function kpopFidelityWaitForTab(tabId, timeoutMs = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); }
    catch { throw new Error("Comparison tab was closed."); }
    if (tab.status === "complete") {
      await kpopFidelityWait(1600);
      return tab;
    }
    await kpopFidelityWait(350);
  }
  throw new Error("Timed out waiting for comparison page.");
}

async function kpopFidelityCaptureTab(tabId) {
  let lastError = "capture content script unavailable";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "kpoparkive-capture-live-fidelity" });
      if (response?.ok && response.capture) return response.capture;
      lastError = response?.error || lastError;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await kpopFidelityWait(300);
  }
  throw new Error(lastError);
}

function kpopFidelityJaccard(left, right) {
  const a = new Set(Array.isArray(left) ? left : []);
  const b = new Set(Array.isArray(right) ? right : []);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function kpopFidelityRatio(left, right) {
  const a = Number(left || 0);
  const b = Number(right || 0);
  if (a <= 0 || b <= 0) return null;
  return Math.max(a, b) / Math.min(a, b);
}

function kpopFidelityMatchTables(originalTables, baselineTables) {
  const used = new Set();
  const matches = [];
  const unmatchedOriginal = [];

  for (const original of originalTables || []) {
    let best = null;
    for (const baseline of baselineTables || []) {
      if (used.has(baseline.index)) continue;
      const tokenScore = kpopFidelityJaccard(original.tokens, baseline.tokens);
      const rowScore = original.rows && baseline.rows ? 1 - Math.min(1, Math.abs(original.rows - baseline.rows) / Math.max(original.rows, baseline.rows)) : 0;
      const colScore = original.cols && baseline.cols ? 1 - Math.min(1, Math.abs(original.cols - baseline.cols) / Math.max(original.cols, baseline.cols)) : 0;
      const score = tokenScore * 0.78 + rowScore * 0.14 + colScore * 0.08;
      if (!best || score > best.score) best = { baseline, score, tokenScore };
    }

    if (!best || best.score < 0.32 || best.tokenScore < 0.20) {
      unmatchedOriginal.push({ index: original.index, text: original.text?.slice(0, 220) || "", rect: original.rect });
      continue;
    }

    used.add(best.baseline.index);
    const baseline = best.baseline;
    const widthRatio = kpopFidelityRatio(original.rect?.width, baseline.rect?.width);
    const heightRatio = kpopFidelityRatio(original.rect?.height, baseline.rect?.height);
    const wrapperWidthRatio = kpopFidelityRatio(original.wrapper?.rect?.width, baseline.wrapper?.rect?.width);
    matches.push({
      originalIndex: original.index,
      baselineIndex: baseline.index,
      score: Math.round(best.score * 1000) / 1000,
      text: original.text?.slice(0, 260) || baseline.text?.slice(0, 260) || "",
      originalRect: original.rect,
      baselineRect: baseline.rect,
      widthRatio,
      heightRatio,
      wrapperWidthRatio,
      originalStyle: original.computed,
      baselineStyle: baseline.computed,
      originalWrapper: original.wrapper,
      baselineWrapper: baseline.wrapper,
      geometryMismatch: Boolean((widthRatio && widthRatio > 1.18) || (wrapperWidthRatio && wrapperWidthRatio > 1.18) || (heightRatio && heightRatio > 1.35)),
    });
  }

  const unmatchedBaseline = (baselineTables || [])
    .filter((table) => !used.has(table.index))
    .map((table) => ({ index: table.index, text: table.text?.slice(0, 220) || "", rect: table.rect }));

  return { matches, unmatchedOriginal, unmatchedBaseline };
}

function kpopFidelityImageKey(image) {
  return kpopFidelityNorm(image?.key || image?.alt || "")
    .replace(/^(?:파일|File):/i, "")
    .toLowerCase();
}

function kpopFidelityCompareImages(originalImages, baselineImages) {
  const originalByKey = new Map();
  for (const image of originalImages || []) {
    const key = kpopFidelityImageKey(image);
    if (key && !originalByKey.has(key)) originalByKey.set(key, image);
  }
  const baselineByKey = new Map();
  for (const image of baselineImages || []) {
    const key = kpopFidelityImageKey(image);
    if (key && !baselineByKey.has(key)) baselineByKey.set(key, image);
  }

  const common = [];
  const missingInBaseline = [];
  const extraInBaseline = [];
  for (const [key, original] of originalByKey) {
    const baseline = baselineByKey.get(key);
    if (!baseline) {
      missingInBaseline.push({ key, alt: original.alt, rect: original.rect });
      continue;
    }
    const widthRatio = kpopFidelityRatio(original.rect?.width, baseline.rect?.width);
    const heightRatio = kpopFidelityRatio(original.rect?.height, baseline.rect?.height);
    common.push({ key, widthRatio, heightRatio, originalRect: original.rect, baselineRect: baseline.rect });
  }
  for (const [key, baseline] of baselineByKey) {
    if (!originalByKey.has(key)) extraInBaseline.push({ key, alt: baseline.alt, rect: baseline.rect });
  }
  return { common, missingInBaseline, extraInBaseline };
}

function kpopBuildLiveFidelityReport(sourceTitle, original, baseline) {
  const tableDiff = kpopFidelityMatchTables(original.tables || [], baseline.tables || []);
  const imageDiff = kpopFidelityCompareImages(original.images || [], baseline.images || []);
  const geometry = tableDiff.matches
    .filter((item) => item.geometryMismatch)
    .sort((a, b) => Math.max(b.widthRatio || 1, b.wrapperWidthRatio || 1, b.heightRatio || 1) - Math.max(a.widthRatio || 1, a.wrapperWidthRatio || 1, a.heightRatio || 1))
    .slice(0, 40);
  const originalSuspicious = new Set(original.suspicious || []);
  const leakedMarkers = (baseline.suspicious || []).filter((marker) => !originalSuspicious.has(marker));
  const rootWidthRatio = kpopFidelityRatio(original.root?.rect?.width, baseline.root?.rect?.width);

  const summary = {
    sourceTitle,
    originalTables: Number(original.counts?.tables || 0),
    baselineTables: Number(baseline.counts?.tables || 0),
    matchedTables: tableDiff.matches.length,
    tableGeometryMismatches: geometry.length,
    unmatchedOriginalTables: tableDiff.unmatchedOriginal.length,
    unmatchedBaselineTables: tableDiff.unmatchedBaseline.length,
    originalImages: Number(original.counts?.images || 0),
    baselineImages: Number(baseline.counts?.images || 0),
    matchedImagesByAlt: imageDiff.common.length,
    missingImagesByAlt: imageDiff.missingInBaseline.length,
    extraImagesByAlt: imageDiff.extraInBaseline.length,
    leakedMarkerCount: leakedMarkers.length,
    rootWidthRatio,
  };

  return {
    summary,
    original: {
      url: original.url,
      title: original.title,
      capturedAt: original.capturedAt,
      viewport: original.viewport,
      root: original.root,
      counts: original.counts,
      headings: original.headings,
      suspicious: original.suspicious,
      textSample: original.textSample,
    },
    baseline: {
      url: baseline.url,
      title: baseline.title,
      capturedAt: baseline.capturedAt,
      viewport: baseline.viewport,
      root: baseline.root,
      counts: baseline.counts,
      headings: baseline.headings,
      suspicious: baseline.suspicious,
      textSample: baseline.textSample,
    },
    leakedMarkers,
    tableGeometryMismatches: geometry,
    unmatchedOriginalTables: tableDiff.unmatchedOriginal.slice(0, 40),
    unmatchedBaselineTables: tableDiff.unmatchedBaseline.slice(0, 40),
    imageDiff: {
      missingInBaseline: imageDiff.missingInBaseline.slice(0, 80),
      extraInBaseline: imageDiff.extraInBaseline.slice(0, 80),
      sizeMismatches: imageDiff.common
        .filter((item) => (item.widthRatio && item.widthRatio > 1.25) || (item.heightRatio && item.heightRatio > 1.25))
        .slice(0, 80),
    },
  };
}

async function kpopPersistFidelityReport(sourceTitle, report) {
  const response = await fetch(`${KPOP_FIDELITY_HELPER}/fidelity-report`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceTitle, report }),
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { error: text }; }
  if (!response.ok) throw new Error(body?.error || `fidelity helper HTTP ${response.status}`);
  return body;
}

async function kpopCompareLiveOriginalWithTheTree() {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const sourceTitle = kpopFidelityTitleFromUrl(activeTab?.url || "");
  if (!activeTab?.id || !sourceTitle) throw new Error("Open the live NamuWiki /w/... page you want to compare first.");

  const original = await kpopFidelityCaptureTab(activeTab.id);
  const baselineUrl = `https://kpoparkive.vercel.app/admin/thetree-frontend-poc/${encodeURIComponent(sourceTitle)}`;
  const baselineTab = await chrome.tabs.create({ url: baselineUrl, active: false });
  if (!baselineTab?.id) throw new Error("Could not open The Tree baseline tab.");

  try {
    await kpopFidelityWaitForTab(baselineTab.id);
    const baseline = await kpopFidelityCaptureTab(baselineTab.id);
    if (Number(baseline.counts?.tables || 0) < 1) throw new Error("The Tree baseline did not contain wiki tables. Check deployment/render status.");
    const report = kpopBuildLiveFidelityReport(sourceTitle, original, baseline);
    const saved = await kpopPersistFidelityReport(sourceTitle, report);
    return { sourceTitle, baselineUrl, summary: report.summary, savedAt: saved.capturedAt || null };
  } finally {
    try { await chrome.tabs.remove(baselineTab.id); } catch {}
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-compare-live-fidelity") return;
  kpopCompareLiveOriginalWithTheTree()
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
