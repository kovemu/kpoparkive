function kpopDecodeEditTitle(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function kpopNormalizeEditRaw(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .trim();
}

function kpopRawSignalScore(value) {
  const text = kpopNormalizeEditRaw(value);
  if (text.length < 200) return 0;
  let score = 0;
  if (/\[\[[^\]]+\]\]/.test(text)) score += 2;
  if (/^={1,6}[^=\n].*={1,6}$/m.test(text)) score += 2;
  if (/^\|\|/m.test(text)) score += 2;
  if (/\[include\(/i.test(text)) score += 2;
  if (/\{\{\{#!/.test(text)) score += 2;
  if (/\[\[(?:파일|File):/i.test(text)) score += 1;
  return score;
}

function kpopEditorCandidates() {
  const values = [];
  const push = (source, value) => {
    const raw = kpopNormalizeEditRaw(value);
    if (raw.length >= 200) values.push({ source, raw, score: kpopRawSignalScore(raw) });
  };

  for (const textarea of document.querySelectorAll("textarea")) {
    push(`textarea${textarea.name ? `[name=${textarea.name}]` : ""}`, textarea.value || textarea.textContent || "");
  }

  for (const editor of document.querySelectorAll(".cm-content")) {
    const lines = [...editor.querySelectorAll(":scope > .cm-line")];
    push("codemirror6", lines.length ? lines.map((line) => line.textContent || "").join("\n") : editor.innerText || editor.textContent || "");
  }

  for (const editor of document.querySelectorAll(".CodeMirror-code")) {
    const lines = [...editor.querySelectorAll(".CodeMirror-line")];
    push("codemirror5", lines.length ? lines.map((line) => line.textContent || "").join("\n") : editor.innerText || editor.textContent || "");
  }

  for (const editor of document.querySelectorAll('[contenteditable="true"]')) {
    if (editor.closest("header, nav, aside")) continue;
    push("contenteditable", editor.innerText || editor.textContent || "");
  }

  return values.sort((a, b) => b.score - a.score || b.raw.length - a.raw.length);
}

function kpopExtractEditSource() {
  const match = location.pathname.match(/^\/edit\/(.+)$/);
  const sourceTitle = match ? kpopDecodeEditTitle(match[1]).normalize("NFKC").trim() : "";
  const candidates = kpopEditorCandidates();
  const best = candidates[0] || null;
  const blocked = /captcha|cloudflare|cf-chl|challenge-platform|비정상적인 접근|자동화된 접근|사람인지 확인/i.test(document.body?.innerText || "");

  if (!sourceTitle) return { ok: false, error: "Could not determine the NamuWiki edit document title." };
  if (!best || best.score < 2) {
    return {
      ok: false,
      blocked,
      sourceTitle,
      error: blocked ? "NamuWiki verification/challenge is blocking the edit source." : "NamuMark editor source is not ready yet.",
      candidateCount: candidates.length,
    };
  }

  return {
    ok: true,
    sourceTitle,
    editUrl: location.href,
    extractionMethod: best.source,
    charCount: best.raw.length,
    signalScore: best.score,
    raw: best.raw,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-edit-source") return;
  try { sendResponse(kpopExtractEditSource()); }
  catch (error) { sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
