function kpopRawPageDecode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function kpopRawPageNormalize(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .trim();
}

function kpopRawPageTitle() {
  const match = location.pathname.match(/^\/raw\/(.+?)\/?$/i);
  if (match?.[1]) return kpopRawPageDecode(match[1]).normalize("NFKC").trim();
  return "";
}

function kpopRawPageBlocked() {
  const text = document.body?.innerText || "";
  return /captcha|cloudflare|cf-chl|challenge-platform|비정상적인 접근|자동화된 접근|사람인지 확인/i.test(text);
}

function kpopRawPageSignalScore(value) {
  const text = kpopRawPageNormalize(value);
  if (!text) return 0;
  let score = 0;
  if (/\[\[[^\]]+\]\]/.test(text)) score += 2;
  if (/^={1,6}[^=\n].*={1,6}$/m.test(text)) score += 2;
  if (/^\|\|/m.test(text)) score += 2;
  if (/\[include\(/i.test(text)) score += 2;
  if (/\{\{\{#!/.test(text)) score += 2;
  if (/\[\[(?:파일|File):/i.test(text)) score += 1;
  if (/@[ㄱ-힣A-Za-z0-9_]+@/.test(text)) score += 1;
  return score;
}

function kpopRawPageCandidates() {
  const values = [];
  const seen = new Set();

  const push = (source, value, trustedSource = false, priority = 0) => {
    const raw = kpopRawPageNormalize(value);
    if (!raw || seen.has(raw)) return;
    if (!trustedSource && raw.length < 20) return;
    seen.add(raw);
    values.push({
      source,
      raw,
      trustedSource,
      priority,
      score: kpopRawPageSignalScore(raw),
    });
  };

  for (const textarea of document.querySelectorAll("textarea")) {
    push(
      `textarea${textarea.name ? `[name=${textarea.name}]` : ""}`,
      textarea.value || textarea.textContent || "",
      true,
      120,
    );
  }

  for (const selector of [
    "pre",
    "pre code",
    "code",
    ".wiki-raw",
    "[data-raw]",
    "[class*='raw' i] pre",
    ".cm-content",
    ".CodeMirror-code",
    ".monaco-editor .view-lines"
  ]) {
    for (const node of document.querySelectorAll(selector)) {
      const text = node.matches?.(".cm-content, .CodeMirror-code, .monaco-editor .view-lines")
        ? [...node.querySelectorAll(".cm-line, .CodeMirror-line, .view-line")].map((line) => line.textContent || "").join("\n") || node.innerText || node.textContent || ""
        : node.innerText || node.textContent || "";
      push(selector, text, true, 105);
    }
  }

  for (const selector of ["main article", "article", "main"]) {
    for (const node of document.querySelectorAll(selector)) {
      push(selector, node.innerText || node.textContent || "", false, 30);
    }
  }

  const bodyText = document.body?.innerText || document.body?.textContent || "";
  if (kpopRawPageSignalScore(bodyText) >= 4) {
    push("body-strong-namumark", bodyText, false, 5);
  }

  return values.sort((a, b) =>
    b.priority - a.priority ||
    b.score - a.score ||
    b.raw.length - a.raw.length
  );
}

function kpopExtractRawPageSource() {
  const sourceTitle = kpopRawPageTitle();
  const blocked = kpopRawPageBlocked();

  if (!sourceTitle) {
    return {
      ok: false,
      blocked,
      error: "Could not determine NamuWiki RAW document title.",
      pathname: location.pathname,
    };
  }

  if (blocked) {
    return {
      ok: false,
      blocked: true,
      sourceTitle,
      error: "NamuWiki verification/challenge is blocking the RAW page.",
    };
  }

  const candidates = kpopRawPageCandidates();
  const best = candidates[0] || null;
  const isTemplate = /^틀:/i.test(sourceTitle);

  if (!best) {
    return {
      ok: false,
      blocked: false,
      sourceTitle,
      error: "No RAW source candidate detected on the NamuWiki RAW page.",
      candidateCount: 0,
    };
  }

  const validTemplate = isTemplate && (
    (best.trustedSource && best.raw.length >= 1) ||
    (best.raw.length >= 20 && best.score >= 1)
  );
  const validDocument = !isTemplate && best.raw.length >= 200 && best.score >= 2;

  if (!validTemplate && !validDocument) {
    return {
      ok: false,
      blocked: false,
      sourceTitle,
      error: "RAW page loaded but source candidate failed NamuMark validation.",
      candidateCount: candidates.length,
      bestCandidate: {
        source: best.source,
        charCount: best.raw.length,
        score: best.score,
        trustedSource: Boolean(best.trustedSource),
      },
    };
  }

  return {
    ok: true,
    blocked: false,
    sourceTitle,
    rawUrl: location.href,
    extractionMethod: `normal-chrome-raw-page:${best.source}`,
    charCount: best.raw.length,
    signalScore: best.score,
    trustedSource: Boolean(best.trustedSource),
    raw: best.raw,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-raw-page") return;
  try { sendResponse(kpopExtractRawPageSource()); }
  catch (error) {
    sendResponse({
      ok: false,
      blocked: kpopRawPageBlocked(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
