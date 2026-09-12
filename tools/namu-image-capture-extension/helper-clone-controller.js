const KPOP_HELPER_CONTROLLER = "http://127.0.0.1:43117";
const KPOP_RUNNER_URL = chrome.runtime.getURL("runner.html");
let kpopRunnerWatch = { processed: -1, since: 0, recovering: false };
let kpopRawEditTabId = null;
let kpopRawNavigationSerial = Promise.resolve();
let kpopRawLastNavigationAt = 0;
const KPOP_RAW_MIN_NAVIGATION_INTERVAL_MS = 1200;
let kpopRawVerification = {
  active: false,
  sourceTitle: "",
  tabId: null,
  since: 0,
};

const KPOP_RAW_QUEUE_STORAGE_KEY = "kpoparkiveRawQueueState";
let kpopRawQueueDriving = false;
let kpopRawQueueState = {
  id: "",
  rootTitle: "",
  status: "idle",
  running: false,
  paused: false,
  current: "",
  initialNeeds: 0,
  completed: 0,
  remaining: null,
  startedAt: null,
  updatedAt: null,
  finishedAt: null,
  lastError: "",
};

function kpopPublicRawQueueState() {
  const verificationActive = Boolean(kpopRawVerification.active);
  return {
    ...kpopRawQueueState,
    paused: Boolean(kpopRawQueueState.paused || verificationActive),
    status:
      kpopRawQueueState.running && verificationActive
        ? "paused"
        : kpopRawQueueState.status,
    verification: { ...kpopRawVerification },
  };
}

async function kpopSaveRawQueueState() {
  kpopRawQueueState.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [KPOP_RAW_QUEUE_STORAGE_KEY]: kpopRawQueueState,
  });
}

async function kpopRestoreRawQueueState() {
  try {
    const stored = await chrome.storage.local.get([KPOP_RAW_QUEUE_STORAGE_KEY]);
    const value = stored?.[KPOP_RAW_QUEUE_STORAGE_KEY];
    if (value && typeof value === "object") {
      kpopRawQueueState = {
        ...kpopRawQueueState,
        ...value,
      };
    }
  } catch {}
  return kpopPublicRawQueueState();
}

async function kpopShowVerification(tab, sourceTitle) {
  kpopRawVerification = {
    active: true,
    sourceTitle: String(sourceTitle || "").normalize("NFKC").trim(),
    tabId: tab?.id || null,
    since: Date.now(),
  };

  try {
    if (tab?.id) await chrome.tabs.update(tab.id, { active: true });
  } catch {}

  try {
    if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch {}

  try {
    await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
    await chrome.action.setBadgeText({ text: "VERIFY" });
    await chrome.action.setTitle({
      title: `Kpoparkive paused: complete NamuWiki verification for ${kpopRawVerification.sourceTitle || "current document"}`,
    });
  } catch {}

  await chrome.storage.local.set({ kpoparkiveRawVerification: kpopRawVerification });
  try {
    await kpopControllerJson("/clone/pause", {
      method: "POST",
      body: JSON.stringify({
        reason: `human_verification:${kpopRawVerification.sourceTitle || "unknown"}`,
      }),
    });
  } catch {}
}

async function kpopClearVerification() {
  kpopRawVerification = { active: false, sourceTitle: "", tabId: null, since: 0 };
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Kpoparkive Namu Capture" });
  } catch {}
  await chrome.storage.local.set({ kpoparkiveRawVerification: kpopRawVerification });
  try {
    await kpopControllerJson("/clone/resume", { method: "POST", body: "{}" });
  } catch {}
}

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

async function kpopRestoreRawTabState() {
  try {
    const stored = await chrome.storage.local.get([
      "kpoparkiveRawEditTabId",
      "kpoparkiveRawVerification",
    ]);
    const storedTabId = Number(stored.kpoparkiveRawEditTabId || 0) || null;
    const verification = stored.kpoparkiveRawVerification || null;

    if (!kpopRawEditTabId && storedTabId) {
      try {
        const tab = await chrome.tabs.get(storedTabId);
        if (tab?.id) kpopRawEditTabId = tab.id;
      } catch {
        try { await chrome.storage.local.remove("kpoparkiveRawEditTabId"); } catch {}
      }
    }

    if (!kpopRawVerification.active && verification?.active) {
      const verificationTabId = Number(verification.tabId || 0) || null;
      if (verificationTabId) {
        try {
          const tab = await chrome.tabs.get(verificationTabId);
          if (tab?.id) {
            kpopRawVerification = {
              active: true,
              sourceTitle: String(verification.sourceTitle || "").normalize("NFKC").trim(),
              tabId: tab.id,
              since: Number(verification.since || Date.now()) || Date.now(),
            };
            kpopRawEditTabId = tab.id;
          }
        } catch {}
      }
    }
  } catch {}
}

async function kpopOpenOrReuseRawEditTab(editUrl, sourceTitle = "") {
  await kpopRestoreRawTabState();

  const normalizedTitle = String(sourceTitle || "").normalize("NFKC").trim();

  // Human verification owns the persistent RAW session tab. Never navigate it
  // away and never open a second RAW tab while verification is active.
  if (kpopRawVerification.active) {
    const verificationTitle = String(kpopRawVerification.sourceTitle || "").normalize("NFKC").trim();
    if (verificationTitle && normalizedTitle && verificationTitle !== normalizedTitle) {
      throw new Error(
        `NamuWiki verification is still in progress for ${verificationTitle}. Complete it in the existing RAW session tab before capturing ${normalizedTitle}.`
      );
    }

    const verificationTabId = Number(kpopRawVerification.tabId || kpopRawEditTabId || 0) || null;
    if (verificationTabId) {
      try {
        const existing = await chrome.tabs.get(verificationTabId);
        if (existing?.id) {
          kpopRawEditTabId = existing.id;
          await chrome.storage.local.set({ kpoparkiveRawEditTabId: existing.id });
          return existing;
        }
      } catch {}
    }
  }

  let existing = null;
  if (kpopRawEditTabId) {
    try {
      existing = await chrome.tabs.get(kpopRawEditTabId);
    } catch {
      kpopRawEditTabId = null;
      try { await chrome.storage.local.remove("kpoparkiveRawEditTabId"); } catch {}
    }
  }

  if (!existing?.id) {
    const created = await chrome.tabs.create({ url: editUrl, active: false });
    if (!created?.id) throw new Error("Could not open the persistent NamuWiki RAW/edit session tab.");
    kpopRawEditTabId = created.id;
    kpopRawLastNavigationAt = Date.now();
    await chrome.storage.local.set({ kpoparkiveRawEditTabId: created.id });
    return created;
  }

  kpopRawEditTabId = existing.id;
  await chrome.storage.local.set({ kpoparkiveRawEditTabId: existing.id });

  const currentUrl = String(existing.url || "");
  if (currentUrl === editUrl) return existing;

  // Serialize every RAW/edit navigation through one browsing context and pace
  // page changes slightly. This preserves the same cookies/session/challenge
  // state and avoids bursts of independent RAW requests that can trigger
  // repeated NamuWiki verification.
  const previous = kpopRawNavigationSerial;
  let release;
  kpopRawNavigationSerial = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    const waitMs = Math.max(
      0,
      KPOP_RAW_MIN_NAVIGATION_INTERVAL_MS - (Date.now() - kpopRawLastNavigationAt)
    );
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    let navigated = false;
    try {
      const result = await chrome.scripting.executeScript({
        target: { tabId: existing.id },
        world: "MAIN",
        func: (targetUrl) => {
          if (location.href === targetUrl) return "same";
          location.replace(targetUrl);
          return "replace";
        },
        args: [editUrl],
      });
      navigated = Boolean(result?.length);
    } catch {}

    if (!navigated) {
      await chrome.tabs.update(existing.id, { url: editUrl, active: false });
    }
    kpopRawLastNavigationAt = Date.now();
    return await chrome.tabs.get(existing.id);
  } finally {
    release();
  }
}

async function kpopCloseRawEditTab() {
  const id = kpopRawEditTabId;
  kpopRawEditTabId = null;
  try { await chrome.storage.local.remove("kpoparkiveRawEditTabId"); } catch {}
  if (!id) return;
  try { await chrome.tabs.remove(id); } catch {}
}

function kpopActiveNamuRaw(rawValue) {
  return String(rawValue || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*##/.test(line))
    .join("\n");
}

async function kpopRawStatus(sourceTitle) {
  const title = String(sourceTitle || "").normalize("NFKC").trim();
  if (!title) return { exists: false, rawCaptured: false, raw: null };
  try {
    return await kpopControllerJson(`/raw-status?sourceTitle=${encodeURIComponent(title)}`);
  } catch {
    return { exists: false, rawCaptured: false, raw: null };
  }
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

function kpopExtractIncludeTitles(rawValue) {
  const raw = kpopActiveNamuRaw(rawValue);
  const lower = raw.toLowerCase();
  const output = [];
  const seen = new Set();
  let cursor = 0;

  while (cursor < raw.length) {
    const start = lower.indexOf("[include(", cursor);
    if (start < 0) break;

    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let i = start + 9; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "(") {
        depth += 1;
        continue;
      }
      if (ch === ")") {
        if (depth > 0) {
          depth -= 1;
          continue;
        }
        if (raw[i + 1] === "]") {
          end = i;
          break;
        }
      }
      if (ch === "," && depth === 0 && comma < 0) comma = i;
    }

    if (end < 0) break;
    const nameEnd = comma >= 0 && comma < end ? comma : end;
    const title = raw.slice(start + 9, nameEnd)
      .normalize("NFKC")
      .replace(/\u00a0/g, " ")
      .replace(/^(틀|Template)\s*:\s*/i, "$1:")
      .replace(/[ \t]+/g, " ")
      .trim();
    if (title && !seen.has(title)) {
      seen.add(title);
      output.push(title);
    }
    cursor = end + 2;
  }

  return output;
}


function kpopResolveRawLinkTitle(currentTitle, rawTarget) {
  let target = String(rawTarget || "").normalize("NFKC").replace(/\u00a0/g, " ").trim();
  if (!target) return "";
  if (/^(?:https?:|ftp:|mailto:|tel:)/i.test(target)) return "";
  target = target.replace(/^:/, "").trim();
  if (!target) return "";

  const hashIndex = target.indexOf("#");
  if (hashIndex >= 0) target = target.slice(0, hashIndex).trim();
  if (!target) return "";

  if (target.startsWith("/")) {
    const base = String(currentTitle || "").normalize("NFKC").trim();
    if (!base) return "";
    target = base.replace(/\/$/, "") + target;
  }

  if (/^(?:파일|File|분류|Category|틀|Template|나무위키|사용자|User|토론|특수기능|Special):/i.test(target)) {
    return "";
  }

  return target;
}

function kpopExtractRawDocumentLinks(rawValue, currentTitle) {
  const raw = kpopActiveNamuRaw(rawValue);
  const output = [];
  const seen = new Set();
  const re = /\[\[([^\[\]]+?)\]\]/g;
  let match;

  while ((match = re.exec(raw))) {
    const inside = String(match[1] || "");
    const pipeIndex = inside.indexOf("|");
    const rawTarget = pipeIndex >= 0 ? inside.slice(0, pipeIndex) : inside;
    const display = pipeIndex >= 0 ? inside.slice(pipeIndex + 1) : rawTarget;
    const title = kpopResolveRawLinkTitle(currentTitle, rawTarget);
    if (!title || seen.has(title)) continue;
    seen.add(title);
    output.push({
      title,
      href: `https://namu.wiki/w/${encodeURIComponent(title)}`,
      text: String(display || "").replace(/\s+/g, " ").trim().slice(0, 240),
    });
    if (output.length >= 2000) break;
  }

  return output;
}

function kpopExtractRawFileRefs(rawValue) {
  const raw = kpopActiveNamuRaw(rawValue);
  const output = [];
  const seen = new Set();
  const re = /\[\[(?:파일|File):([^\]|]+)(?=[\]|])/gi;
  let match;

  while ((match = re.exec(raw))) {
    const fileName = String(match[1] || "")
      .normalize("NFKC")
      .replace(/\u00a0/g, " ")
      .trim();
    const key = fileName.toLowerCase();
    if (!fileName || seen.has(key)) continue;
    seen.add(key);
    output.push(`파일:${fileName}`);
    if (output.length >= 5000) break;
  }

  return output;
}

function kpopShouldCaptureTemplate(value) {
  const title = String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/^(틀|Template)\s*:\s*/i, "$1:")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!/^틀:/i.test(title)) return false;
  if (/\/설명문서(?:$|\/)/i.test(title)) return false;

  const body = title.replace(/^틀:/i, "").trim();
  if (/^(?:접근\s*제한|설명문서|문서 가져옴|토론 관련 틀|토론 합의(?:\/설명문서)?|분류 설명|분류 참고|한시적 넘겨주기)$/i.test(body)) return false;
  return true;
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
  const captureMode = String(options.captureMode || "dom").toLowerCase() === "raw" ? "raw" : "dom";
  const profileName = String(options.crawlProfile || "smart-core").toLowerCase();
  const profileDefaults = profileName === "essential"
    ? { depth: 1, maxDocs: 20 }
    : profileName === "archive"
      ? { depth: 3, maxDocs: 150 }
      : { depth: 2, maxDocs: 40 };
  const maxDepth = captureMode === "raw"
    ? 0
    : Math.max(0, Math.min(3, Number(options.maxDepth ?? profileDefaults.depth) || 0));
  const maxDocs = captureMode === "raw"
    ? 1
    : Math.max(1, Math.min(200, Number(options.maxDocs ?? profileDefaults.maxDocs) || profileDefaults.maxDocs));

  const result = await kpopControllerJson("/clone/start", {
    method: "POST",
    body: JSON.stringify({
      rootTitle,
      rootUrl: activeTab.url,
      maxDepth,
      maxDocs,
      captureMode,
      crawlProfile: String(options.crawlProfile || "smart-core"),
      crawlOrder: String(options.crawlOrder || "smart"),
      includeLeaf: options.includeLeaf !== false,
      refreshExisting: Boolean(options.refreshExisting),
    }),
  });

  await kpopEnsureRunnerTab({ reloadExisting: true });
  kpopRunnerWatch = { processed: Number(result?.job?.processed || 0), since: Date.now(), recovering: false };
  return result.job;
}

async function kpopResetHelperClone() {
  let storedVerification = null;
  try {
    const stored = await chrome.storage.local.get(["kpoparkiveRawVerification"]);
    storedVerification = stored.kpoparkiveRawVerification || null;
  } catch {}

  // Reset helper state first so a disappearing runner context cannot interrupt
  // the actual queue reset.
  let result;
  try { await kpopControllerJson("/clone/cancel", { method: "POST", body: "{}" }); } catch {}
  result = await kpopControllerJson("/clone/reset", { method: "POST", body: "{}" });

  await kpopClearVerification();
  await kpopCloseRawEditTab();

  const verificationTabId = Number(storedVerification?.tabId || 0) || null;
  if (verificationTabId) {
    try { await chrome.tabs.remove(verificationTabId); } catch {}
  }

  await kpopCloseRunnerTabs();
  kpopRunnerWatch = { processed: -1, since: 0, recovering: false };
  try {
    await chrome.storage.local.set({
      kpoparkiveRawVerification: { active: false, sourceTitle: "", tabId: null, since: 0 },
    });
  } catch {}
  try { await chrome.action.setBadgeText({ text: "" }); } catch {}
  return result.job || null;
}

function kpopWithTimeout(promise, timeoutMs, label = "operation") {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)),
  ]);
}

async function kpopExtractVisibleRawFromTab(tabId, normalizedTitle) {
  if (!chrome.scripting?.executeScript) {
    return { ok: false, error: "chrome.scripting is unavailable" };
  }

  try {
    const results = await kpopWithTimeout(
      chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        world: "ISOLATED",
        func: () => {
          const normalize = (value) => String(value || "")
            .replace(/\r\n?/g, "\n")
            .replace(/^\uFEFF/, "")
            .trim();

          const score = (value) => {
            const text = normalize(value);
            let total = 0;
            if (/\[\[[^\]]+\]\]/.test(text)) total += 2;
            if (/^={1,6}[^=\n].*={1,6}$/m.test(text)) total += 2;
            if (/^\|\|/m.test(text)) total += 2;
            if (/\[include\(/i.test(text)) total += 2;
            if (/\{\{\{#!/.test(text)) total += 2;
            if (/\[\[(?:파일|File):/i.test(text)) total += 1;
            if (/@[ㄱ-힣A-Za-z0-9_]+@/.test(text)) total += 1;
            return total;
          };

          const visible = (element) => {
            if (!(element instanceof Element)) return false;
            try {
              const style = getComputedStyle(element);
              const rect = element.getBoundingClientRect();
              if (!style || !rect) return false;
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity || "1") === 0) return false;
              return rect.width >= 100 && rect.height >= 40;
            } catch {
              return false;
            }
          };

          const candidates = [];
          const push = (source, element, value, priority) => {
            const raw = normalize(value);
            if (!raw || !visible(element)) return;
            candidates.push({
              source,
              raw,
              priority,
              score: score(raw),
              area: Math.max(0, element.getBoundingClientRect().width * element.getBoundingClientRect().height),
            });
          };

          for (const textarea of document.querySelectorAll("textarea")) {
            push("ui:textarea", textarea, textarea.value || textarea.textContent || "", 300);
          }

          for (const element of document.querySelectorAll('[contenteditable="true"], [role="textbox"]')) {
            push("ui:editable", element, element.innerText || element.textContent || "", 220);
          }

          for (const element of document.querySelectorAll(".cm-content, .CodeMirror-code, .monaco-editor .view-lines")) {
            const lines = [...element.querySelectorAll(".cm-line, .CodeMirror-line, .view-line")];
            const value = lines.length
              ? lines.map((line) => line.textContent || "").join("\n")
              : element.innerText || element.textContent || "";
            push("ui:editor", element, value, 200);
          }

          for (const element of document.querySelectorAll("pre, pre code")) {
            push("ui:pre", element, element.innerText || element.textContent || "", 120);
          }

          candidates.sort((a, b) =>
            b.priority - a.priority ||
            b.score - a.score ||
            b.area - a.area ||
            b.raw.length - a.raw.length
          );

          const best = candidates[0] || null;
          if (best) {
            try {
              const element = document.querySelector("textarea");
              element?.focus?.();
              element?.select?.();
            } catch {}
          }

          return {
            href: location.href,
            documentTitle: document.title,
            candidateCount: candidates.length,
            best,
          };
        },
      }),
      2500,
      "visible RAW UI extraction"
    );

    const payloads = (Array.isArray(results) ? results : [])
      .map((item) => item?.result)
      .filter(Boolean);
    const candidates = payloads
      .map((payload) => ({ payload, best: payload.best }))
      .filter((item) => item.best?.raw)
      .sort((a, b) =>
        Number(b.best.priority || 0) - Number(a.best.priority || 0) ||
        Number(b.best.score || 0) - Number(a.best.score || 0) ||
        String(b.best.raw || "").length - String(a.best.raw || "").length
      );

    const winner = candidates[0] || null;
    const best = winner?.best || null;
    const isTemplate = /^틀:/i.test(normalizedTitle);
    const valid = Boolean(
      best?.raw &&
      (
        (isTemplate && best.raw.length >= 1) ||
        (!isTemplate && best.raw.length >= 200 && Number(best.score || 0) >= 2)
      )
    );

    if (!valid) {
      return {
        ok: false,
        error: `Visible RAW UI not found or invalid (frames=${payloads.length}, candidates=${payloads.reduce((n, p) => n + Number(p.candidateCount || 0), 0)})`,
      };
    }

    return {
      ok: true,
      sourceTitle: normalizedTitle,
      rawUrl: winner?.payload?.href || null,
      extractionMethod: best.source || "ui:raw-copy",
      charCount: best.raw.length,
      signalScore: Number(best.score || 0),
      trustedSource: true,
      trustedEditor: true,
      raw: best.raw,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function kpopTabMatchesTarget(tab, targetUrl) {
  try {
    const current = new URL(String(tab?.url || ""));
    const target = new URL(String(targetUrl || ""));
    return current.origin === target.origin &&
      current.pathname === target.pathname &&
      current.search === target.search;
  } catch {
    return String(tab?.url || "") === String(targetUrl || "");
  }
}

async function kpopTryReadOnlyRawTitle(normalizedTitle) {
  await kpopRestoreRawTabState();

  const rawUrl = `https://namu.wiki/raw/${encodeURIComponent(normalizedTitle)}`;
  const tab = await kpopOpenOrReuseRawEditTab(rawUrl, normalizedTitle);
  if (!tab?.id) throw new Error(`Could not open the NamuWiki RAW page for ${normalizedTitle}.`);

  let verificationShown = Boolean(
    kpopRawVerification.active &&
    Number(kpopRawVerification.tabId || 0) === Number(tab.id)
  );
  let lastResult = null;
  const started = Date.now();
  const softWaitMs = 2500;
  const maxHumanWaitMs = 10 * 60 * 1000;

  while (Date.now() - started < maxHumanWaitMs) {
    let current;
    try {
      current = await chrome.tabs.get(tab.id);
    } catch {
      throw new Error(`The NamuWiki RAW tab for ${normalizedTitle} was closed before capture finished.`);
    }

    if (current.status === "complete" && kpopTabMatchesTarget(current, rawUrl)) {
      try {
        const result = await kpopWithTimeout(
          chrome.tabs.sendMessage(tab.id, { type: "kpoparkive-extract-namu-raw-page" }),
          1800,
          "RAW page extraction"
        );
        lastResult = result || lastResult;

        if (result?.ok && result.raw) {
          if (kpopRawVerification.active) await kpopClearVerification();
          return {
            ...result,
            rawUrl: result.rawUrl || rawUrl,
            trustedEditor: Boolean(result.trustedSource),
          };
        }

        if (result?.blocked && !verificationShown) {
          verificationShown = true;
          await kpopShowVerification(current, normalizedTitle);
        }
      } catch {}

      try {
        const direct = await kpopExtractVisibleRawFromTab(tab.id, normalizedTitle);
        if (direct?.ok && direct.raw) {
          if (kpopRawVerification.active) await kpopClearVerification();
          return direct;
        }
        if (direct?.error) lastResult = direct;
      } catch {}

      // NamuWiki sometimes presents a verification/interstitial page that does
      // not match our challenge selectors. If the RAW source is still absent
      // after a short grace period, treat the SAME tab as a human-wait tab.
      // This prevents fail/retry loops from spawning or navigating new tabs.
      if (!verificationShown && Date.now() - started >= softWaitMs) {
        verificationShown = true;
        await kpopShowVerification(current, normalizedTitle);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, verificationShown ? 1000 : 400));
  }

  // Keep the verification state and the existing tab intact. The user can
  // explicitly cancel/reset from the extension if verification cannot finish.
  throw new Error(
    `RAW capture is still waiting for NamuWiki verification for ${normalizedTitle}. The existing RAW tab was kept open; no new tab was created.`
  );
}

async function kpopTryEditRawTitle(normalizedTitle) {
  const editUrl = `https://namu.wiki/edit/${encodeURIComponent(normalizedTitle)}`;
  const editTab = await kpopOpenOrReuseRawEditTab(editUrl, normalizedTitle);
  if (!editTab?.id) throw new Error(`Could not open the NamuWiki edit page for ${normalizedTitle}.`);

  let extracted = null;
  let verificationShown = false;
  const started = Date.now();

  for (let attempt = 0; attempt < 90 || kpopRawVerification.active; attempt += 1) {
    let tab;
    try { tab = await chrome.tabs.get(editTab.id); }
    catch { throw new Error(`The NamuWiki edit tab for ${normalizedTitle} was closed before source capture finished.`); }

    if (tab.status === "complete" && kpopTabMatchesTarget(tab, editUrl)) {
      try {
        const result = await chrome.tabs.sendMessage(editTab.id, { type: "kpoparkive-extract-namu-edit-source" });
        if (result?.ok && result.raw) {
          extracted = result;
          await kpopClearVerification();
          break;
        }
        if (result?.blocked) {
          if (!verificationShown) {
            verificationShown = true;
            await kpopShowVerification(tab, normalizedTitle);
          }
          await new Promise((resolve) => setTimeout(resolve, 1000));
          continue;
        }
      } catch {}
    }

    if (!verificationShown && Date.now() - started > 2000) {
      verificationShown = true;
      try { await chrome.tabs.update(editTab.id, { active: true }); } catch {}
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (!extracted?.raw) {
    let tab = null;
    try { tab = await chrome.tabs.get(editTab.id); } catch {}
    await kpopShowVerification(tab, normalizedTitle);
    throw new Error(`Could not read raw source for ${normalizedTitle} within 90 seconds.`);
  }

  return {
    ...extracted,
    editUrl: extracted.editUrl || editUrl,
    trustedEditor: Boolean(extracted.trustedEditor),
  };
}

async function kpopCaptureOneRawTitle({ rootTitle, sourceTitle }) {
  const normalizedTitle = String(sourceTitle || "").normalize("NFKC").trim();
  if (!normalizedTitle) throw new Error("Raw source title is empty.");

  const sourcePageUrl = `https://namu.wiki/w/${encodeURIComponent(normalizedTitle)}`;
  let extracted = null;
  const sourceMode = "raw";

  try {
    const rawView = await kpopTryReadOnlyRawTitle(normalizedTitle);
    if (rawView?.ok && rawView.raw) {
      extracted = rawView;
      console.log(
        `RAW VIEW CAPTURED ${normalizedTitle} -> ${Number(rawView.charCount || rawView.raw.length).toLocaleString()} chars via ${rawView.extractionMethod || "raw-page"}`
      );
    } else {
      throw new Error(
        `RAW UI capture failed for ${normalizedTitle}: ${rawView?.error || "visible RAW source was not detected"}`
      );
    }

    const saved = await kpopControllerJson("/raw-source", {
      method: "POST",
      body: JSON.stringify({
        rootTitle,
        sourceTitle: normalizedTitle,
        pageUrl: sourcePageUrl,
        editUrl: extracted.editUrl || null,
        rawUrl: extracted.rawUrl || null,
        raw: extracted.raw,
        internalLinks: kpopExtractRawDocumentLinks(extracted.raw, normalizedTitle),
        translate: true,
        extractionMethod: extracted.extractionMethod || (sourceMode === "raw" ? "normal-chrome-raw-page" : "normal-chrome-edit"),
        signalScore: Number(extracted.signalScore || 0),
        trustedEditor: Boolean(extracted.trustedEditor || extracted.trustedSource),
      }),
    });

    return {
      ...saved,
      sourceTitle: normalizedTitle,
      raw: extracted.raw,
      charCount: Number(extracted.charCount || extracted.raw.length),
      sourceMode,
      extractionMethod: extracted.extractionMethod || (sourceMode === "raw" ? "normal-chrome-raw-page" : "normal-chrome-edit"),
    };
  } catch (error) {
    // Verification is intentionally sticky: never resume/retry the queue merely
    // because extraction has not completed yet. Only successful extraction or
    // an explicit reset/cancel clears the human-verification state.
    throw error;
  }
}

async function kpopCaptureRawBundle({
  rootTitle,
  sourceTitle,
} = {}) {
  const normalizedRoot = String(rootTitle || sourceTitle || "").normalize("NFKC").trim();
  const normalizedSource = String(sourceTitle || "").normalize("NFKC").trim();
  if (!normalizedRoot || !normalizedSource) throw new Error("Raw bundle requires rootTitle/sourceTitle.");

  const rootCapture = await kpopCaptureOneRawTitle({
    rootTitle: normalizedRoot,
    sourceTitle: normalizedSource,
  });

  const includeTitles = kpopExtractIncludeTitles(rootCapture.raw)
    .filter(kpopShouldCaptureTemplate);
  const requiredFiles = kpopExtractRawFileRefs(rootCapture.raw);

  return {
    ...rootCapture,
    sourceTitle: normalizedSource,
    internalLinks: kpopExtractRawDocumentLinks(rootCapture.raw, normalizedSource),
    templatesCaptured: 0,
    templatesDiscovered: includeTitles.length,
    templateFailures: [],
    capturedTemplates: [],
    includeTitles,
    requiredFiles,
    capturePolicy: "root-raw-only",
  };
}

async function kpopCaptureEditRawSource(options = {}) {
  const requestedTitle = String(options?.sourceTitle || "").normalize("NFKC").trim();
  let sourceTitle = requestedTitle;

  if (!sourceTitle) {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    sourceTitle = kpopTitleFromDocumentUrl(activeTab?.url || "");
    if (!activeTab?.url || !sourceTitle) {
      throw new Error("Open a NamuWiki document or provide sourceTitle for RAW capture.");
    }
  }

  const rootTitle = String(options.rootTitle || "").normalize("NFKC").trim() || sourceTitle;

  const rootCapture = await kpopCaptureRawBundle({
    rootTitle,
    sourceTitle,
  });

  const previewUrl = `https://kpoparkive.vercel.app/w/${encodeURIComponent(sourceTitle)}`;
  if (options.openPreview) {
    try { await chrome.tabs.create({ url: previewUrl, active: true }); } catch {}
  }

  return {
    ...rootCapture,
    sourceTitle,
    previewUrl,
    templateDepth: "complete",
    templatesCaptured: rootCapture.templatesCaptured,
    templatesDiscovered: rootCapture.templatesDiscovered,
    templateFailures: rootCapture.templateFailures,
    capturedTemplates: rootCapture.capturedTemplates,
  };
}

async function kpopRawNeedsStatus(options = {}) {
  const rootTitle = String(options?.rootTitle || "").normalize("NFKC").trim();
  if (!rootTitle) throw new Error("rootTitle is required");
  return kpopControllerJson("/raw-needs?rootTitle=" + encodeURIComponent(rootTitle));
}

async function kpopPlanRawNeeds(options = {}) {
  const rootTitle = String(options?.rootTitle || "").normalize("NFKC").trim();
  if (!rootTitle) throw new Error("rootTitle is required");
  return kpopControllerJson("/raw-needs/plan", {
    method: "POST",
    body: JSON.stringify({ rootTitle }),
  });
}

async function kpopIgnoreRawNeed(options = {}) {
  const rootTitle = String(options?.rootTitle || "").normalize("NFKC").trim();
  const sourceTitle = String(options?.sourceTitle || "").normalize("NFKC").trim();
  if (!rootTitle || !sourceTitle) throw new Error("rootTitle/sourceTitle are required");
  return kpopControllerJson("/raw-needs/ignore", {
    method: "POST",
    body: JSON.stringify({ rootTitle, sourceTitle }),
  });
}

async function kpopCaptureNextRequiredRaw(options = {}) {
  const rootTitle = String(options?.rootTitle || "").normalize("NFKC").trim();
  if (!rootTitle) throw new Error("rootTitle is required");

  const plan = options?.replan === false
    ? await kpopRawNeedsStatus({ rootTitle })
    : await kpopPlanRawNeeds({ rootTitle });
  const next = plan?.next || null;
  if (!next?.source_title) {
    return { ok: true, noWork: true, rawNeeds: plan, sourceTitle: null };
  }

  const capture = await kpopCaptureRawBundle({
    rootTitle,
    sourceTitle: String(next.source_title),
  });
  const refreshed = await kpopRawNeedsStatus({ rootTitle });
  return {
    ok: true,
    noWork: false,
    ...capture,
    rawNeeds: refreshed,
  };
}

async function kpopDriveRawQueue() {
  if (kpopRawQueueDriving || !kpopRawQueueState.running) return;
  kpopRawQueueDriving = true;

  try {
    while (kpopRawQueueState.running) {
      await kpopRestoreRawTabState();
      const rootTitle = String(kpopRawQueueState.rootTitle || "").normalize("NFKC").trim();
      if (!rootTitle) throw new Error("RAW queue rootTitle is missing.");

      const rawNeeds = await kpopRawNeedsStatus({ rootTitle });
      const remaining = Number(rawNeeds?.counts?.needs_raw || 0);
      const next = rawNeeds?.next || null;

      kpopRawQueueState.remaining = remaining;
      if (!next?.source_title || remaining <= 0) {
        kpopRawQueueState.running = false;
        kpopRawQueueState.paused = false;
        kpopRawQueueState.current = "";
        kpopRawQueueState.status = "done";
        kpopRawQueueState.finishedAt = new Date().toISOString();
        kpopRawQueueState.lastError = "";
        await kpopSaveRawQueueState();
        try {
          await chrome.action.setBadgeText({ text: "" });
          await chrome.action.setTitle({ title: "Kpoparkive Namu Capture" });
        } catch {}
        break;
      }

      const sourceTitle = String(next.source_title || "").normalize("NFKC").trim();
      kpopRawQueueState.current = sourceTitle;
      kpopRawQueueState.paused = Boolean(kpopRawVerification.active);
      kpopRawQueueState.status = kpopRawVerification.active ? "paused" : "running";
      await kpopSaveRawQueueState();

      try {
        await kpopCaptureRawBundle({ rootTitle, sourceTitle });

        kpopRawQueueState.completed = Number(kpopRawQueueState.completed || 0) + 1;
        kpopRawQueueState.current = "";
        kpopRawQueueState.paused = false;
        kpopRawQueueState.status = "running";
        kpopRawQueueState.lastError = "";

        const refreshed = await kpopPlanRawNeeds({ rootTitle });
        kpopRawQueueState.remaining = Number(refreshed?.counts?.needs_raw || 0);
        await kpopSaveRawQueueState();

        try {
          await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
          await chrome.action.setBadgeText({ text: "RAW" });
          await chrome.action.setTitle({
            title: `Kpoparkive RAW queue · ${kpopRawQueueState.remaining} remaining`,
          });
        } catch {}

        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        const message = error?.message || String(error);
        await kpopRestoreRawTabState();

        if (kpopRawVerification.active) {
          // Keep the queue alive on the same document/tab. A completed human
          // verification is picked up by the next capture attempt; no extra
          // operator click is required.
          kpopRawQueueState.paused = true;
          kpopRawQueueState.status = "paused";
          kpopRawQueueState.lastError = "";
          await kpopSaveRawQueueState();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          continue;
        }

        kpopRawQueueState.running = false;
        kpopRawQueueState.paused = false;
        kpopRawQueueState.status = "error";
        kpopRawQueueState.lastError = message;
        kpopRawQueueState.finishedAt = new Date().toISOString();
        await kpopSaveRawQueueState();
        try {
          await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
          await chrome.action.setBadgeText({ text: "ERR" });
          await chrome.action.setTitle({ title: `Kpoparkive RAW queue stopped: ${message}` });
        } catch {}
        break;
      }
    }
  } catch (error) {
    kpopRawQueueState.running = false;
    kpopRawQueueState.paused = false;
    kpopRawQueueState.status = "error";
    kpopRawQueueState.lastError = error?.message || String(error);
    kpopRawQueueState.finishedAt = new Date().toISOString();
    try { await kpopSaveRawQueueState(); } catch {}
  } finally {
    kpopRawQueueDriving = false;
  }
}

async function kpopStartRawQueue(options = {}) {
  const rootTitle = String(options?.rootTitle || "").normalize("NFKC").trim();
  if (!rootTitle) throw new Error("rootTitle is required");

  await kpopRestoreRawQueueState();
  if (kpopRawQueueState.running) {
    if (kpopRawQueueState.rootTitle !== rootTitle) {
      throw new Error(`RAW queue is already running for ${kpopRawQueueState.rootTitle}.`);
    }
    void kpopDriveRawQueue();
    return kpopPublicRawQueueState();
  }

  const plan = await kpopPlanRawNeeds({ rootTitle });
  const needs = Number(plan?.counts?.needs_raw || 0);
  const now = new Date().toISOString();

  kpopRawQueueState = {
    id: crypto.randomUUID(),
    rootTitle,
    status: needs > 0 ? "running" : "done",
    running: needs > 0,
    paused: false,
    current: "",
    initialNeeds: needs,
    completed: 0,
    remaining: needs,
    startedAt: now,
    updatedAt: now,
    finishedAt: needs > 0 ? null : now,
    lastError: "",
  };
  await kpopSaveRawQueueState();

  if (needs > 0) {
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#0f766e" });
      await chrome.action.setBadgeText({ text: "RAW" });
      await chrome.action.setTitle({ title: `Kpoparkive RAW queue · ${needs} remaining` });
    } catch {}
    void kpopDriveRawQueue();
  }

  return kpopPublicRawQueueState();
}

async function kpopRawQueueStatus() {
  await kpopRestoreRawQueueState();
  if (kpopRawQueueState.running && !kpopRawQueueDriving) void kpopDriveRawQueue();
  return kpopPublicRawQueueState();
}

async function kpopCancelRawQueue() {
  await kpopRestoreRawQueueState();
  kpopRawQueueState.running = false;
  kpopRawQueueState.paused = false;
  kpopRawQueueState.status = "cancelled";
  kpopRawQueueState.current = "";
  kpopRawQueueState.finishedAt = new Date().toISOString();
  await kpopSaveRawQueueState();
  try {
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({ title: "Kpoparkive Namu Capture" });
  } catch {}
  return kpopPublicRawQueueState();
}

async function kpopRecoverRawQueue() {
  await kpopRestoreRawQueueState();
  if (kpopRawQueueState.running) void kpopDriveRawQueue();
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // runner.html also loads this file for shared capture helpers. Control
  // messages must be answered only by the background service worker.
  if (typeof document !== "undefined") return;

  if (message?.type === "kpoparkive-verification-detected") {
    kpopShowVerification(sender?.tab || null, message.sourceTitle || "")
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-raw-verification-status") {
    sendResponse({ ok: true, verification: { ...kpopRawVerification } });
    return;
  }
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

  if (message?.type === "kpoparkive-plan-raw-needs") {
    kpopPlanRawNeeds(message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-raw-needs-status") {
    kpopRawNeedsStatus(message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-ignore-raw-need") {
    kpopIgnoreRawNeed(message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-capture-next-required-raw") {
    kpopCaptureNextRequiredRaw(message.options || {})
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-start-raw-queue") {
    kpopStartRawQueue(message.options || {})
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-raw-queue-status") {
    kpopRawQueueStatus()
      .then((job) => sendResponse({ ok: true, job }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "kpoparkive-cancel-raw-queue") {
    kpopCancelRawQueue()
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

chrome.runtime.onStartup.addListener(() => {
  kpopRecoverRunner();
  kpopRecoverRawQueue();
});
chrome.runtime.onInstalled.addListener(() => {
  kpopRecoverRunner();
  kpopRecoverRawQueue();
});
setTimeout(() => {
  kpopRecoverRunner();
  kpopRecoverRawQueue();
}, 500);
