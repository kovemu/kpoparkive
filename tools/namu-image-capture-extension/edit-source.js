function kpopDecodeEditTitle(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function kpopNormalizeEditRaw(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "")
    .trim();
}

function kpopSourceTitleFromPage() {
  const pathMatch = location.pathname.match(/^\/(?:edit|new_edit_request)\/(.+?)\/?$/i);
  if (pathMatch?.[1]) return kpopDecodeEditTitle(pathMatch[1]).normalize("NFKC").trim();

  const heading = document.querySelector("h1")?.textContent?.normalize("NFKC").trim() || "";
  if (heading) {
    const cleaned = heading
      .replace(/\s*\((?:편집|편집 요청 편집|편집 요청)\)\s*$/i, "")
      .trim();
    if (cleaned && cleaned !== heading) return cleaned;
  }

  return "";
}

function kpopRawSignalScore(value) {
  const text = kpopNormalizeEditRaw(value);
  if (text.length < 20) return 0;
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

function kpopExpectedEditorStats() {
  const text = document.body?.innerText || "";
  const chars = text.match(/글자\s*수\s*:\s*([\d,]+)/i);
  const lines = text.match(/줄\s*수\s*:\s*([\d,]+)/i);
  return {
    chars: chars ? Number(chars[1].replace(/,/g, "")) || 0 : 0,
    lines: lines ? Number(lines[1].replace(/,/g, "")) || 0 : 0,
  };
}

function kpopCollectSearchRoots() {
  const output = [];
  const seen = new Set();

  function visitRoot(root, label, depth) {
    if (!root || seen.has(root) || depth > 3) return;
    seen.add(root);
    output.push({ root, label });

    let elements = [];
    try { elements = [...root.querySelectorAll("*")]; } catch {}
    for (const element of elements) {
      if (element.shadowRoot) visitRoot(element.shadowRoot, `${label} > shadow(${element.tagName.toLowerCase()})`, depth + 1);
      if (element.tagName === "IFRAME") {
        try {
          const child = element.contentDocument;
          if (child) visitRoot(child, `${label} > iframe`, depth + 1);
        } catch {}
      }
    }
  }

  visitRoot(document, "document", 0);
  return output;
}

function kpopEditorCandidates() {
  const values = [];
  const expected = kpopExpectedEditorStats();
  const seenRaw = new Set();

  const push = (source, value, trustedEditor = false, priority = 0) => {
    const raw = kpopNormalizeEditRaw(value);
    if (!raw.length || (!trustedEditor && raw.length < 20) || seenRaw.has(raw)) return;
    seenRaw.add(raw);
    const score = kpopRawSignalScore(raw);
    const ratio = expected.chars > 0 ? raw.length / expected.chars : null;
    values.push({ source, raw, score, ratio, trustedEditor, priority });
  };

  for (const { root, label } of kpopCollectSearchRoots()) {
    try {
      for (const textarea of root.querySelectorAll("textarea")) {
        push(`${label}:textarea${textarea.name ? `[name=${textarea.name}]` : ""}`, textarea.value || textarea.textContent || "", true, 100);
      }
    } catch {}

    try {
      for (const editor of root.querySelectorAll(".cm-content")) {
        const lines = [...editor.querySelectorAll(":scope > .cm-line")];
        push(`${label}:codemirror6`, lines.length ? lines.map((line) => line.textContent || "").join("\n") : editor.innerText || editor.textContent || "", true, 90);
      }
    } catch {}

    try {
      for (const editor of root.querySelectorAll(".CodeMirror-code")) {
        const lines = [...editor.querySelectorAll(".CodeMirror-line")];
        push(`${label}:codemirror5`, lines.length ? lines.map((line) => line.textContent || "").join("\n") : editor.innerText || editor.textContent || "", true, 90);
      }
    } catch {}

    try {
      for (const editor of root.querySelectorAll(".monaco-editor .view-lines, .view-lines")) {
        const lines = [...editor.querySelectorAll(":scope > .view-line")];
        push(`${label}:monaco-visible`, lines.length ? lines.map((line) => line.textContent || "").join("\n") : editor.innerText || editor.textContent || "", true, 90);
      }
    } catch {}

    try {
      for (const editor of root.querySelectorAll('[contenteditable="true"], [role="textbox"]')) {
        if (editor.closest?.("header, nav, aside")) continue;
        push(`${label}:editable`, editor.innerText || editor.textContent || "", true, 70);
      }
    } catch {}

    try {
      for (const node of root.querySelectorAll("pre, pre code")) {
        push(`${label}:${node.tagName.toLowerCase()}`, node.innerText || node.textContent || "");
      }
    } catch {}
  }

  return values.sort((a, b) =>
    b.priority - a.priority ||
    b.score - a.score ||
    b.raw.length - a.raw.length
  );
}

function kpopEnsureStatusBadge() {
  let badge = document.getElementById("kpoparkive-raw-status");
  if (badge) return badge;
  badge = document.createElement("div");
  badge.id = "kpoparkive-raw-status";
  badge.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "max-width:420px",
    "padding:10px 12px",
    "border-radius:8px",
    "font:12px/1.45 Arial,sans-serif",
    "white-space:pre-wrap",
    "box-shadow:0 4px 18px rgba(0,0,0,.28)",
    "background:#3b2d63",
    "color:white",
    "border:1px solid rgba(255,255,255,.22)",
  ].join(";");
  badge.textContent = "Kpoparkive RAW: edit page detected · waiting for source…";
  document.documentElement.appendChild(badge);
  return badge;
}

function kpopSetStatus(text, kind = "wait") {
  const badge = kpopEnsureStatusBadge();
  badge.textContent = text;
  badge.style.background = kind === "ok" ? "#0b7a3b" : kind === "bad" ? "#a12626" : kind === "warn" ? "#9a5b00" : "#3b2d63";
}

let kpopReportedVerificationTitle = "";

function kpopExtractEditSource() {
  const sourceTitle = kpopSourceTitleFromPage();
  const expected = kpopExpectedEditorStats();
  const candidates = kpopEditorCandidates();
  const best = candidates[0] || null;
  const blocked = /captcha|cloudflare|cf-chl|challenge-platform|비정상적인 접근|자동화된 접근|사람인지 확인/i.test(document.body?.innerText || "");

  if (!sourceTitle) {
    kpopSetStatus(`Kpoparkive RAW: could not determine the edit document title.\nPath: ${location.pathname}`, "bad");
    return { ok: false, error: "Could not determine the NamuWiki edit document title.", pathname: location.pathname };
  }

  if (blocked) {
    kpopSetStatus(`Kpoparkive RAW: ${sourceTitle}\nNamuWiki verification detected.\nComplete the verification, then leave this tab open.`, "warn");
    if (kpopReportedVerificationTitle !== sourceTitle) {
      kpopReportedVerificationTitle = sourceTitle;
      try {
        chrome.runtime.sendMessage({
          type: "kpoparkive-verification-detected",
          sourceTitle,
        }).catch(() => {});
      } catch {}
    }
  } else if (kpopReportedVerificationTitle) {
    kpopReportedVerificationTitle = "";
  }

  const isTemplate = /^틀:/i.test(sourceTitle);
  const minChars = isTemplate ? 1 : 200;
  const minScore = isTemplate ? 0 : 2;
  const ratio = best?.ratio;
  const looksTruncated = Boolean(best && expected.chars > 1000 && Number.isFinite(ratio) && ratio < 0.7);
  if (!best || best.raw.length < minChars || best.score < minScore || looksTruncated) {
    const candidateInfo = best
      ? `Best candidate: ${best.source}\n${best.raw.length.toLocaleString()} chars · syntax score ${best.score}${expected.chars ? ` · expected ~${expected.chars.toLocaleString()} chars` : ""}`
      : "No editor text candidate detected yet.";
    const reason = looksTruncated ? "Editor text is visible, but only a partial/virtualized slice was detected." : "NamuMark editor source is not ready yet.";
    if (!blocked) kpopSetStatus(`Kpoparkive RAW: ${sourceTitle} · waiting\n${candidateInfo}\n${reason}`, looksTruncated ? "warn" : "wait");
    return {
      ok: false,
      blocked,
      sourceTitle,
      error: blocked ? "NamuWiki verification/challenge is blocking the edit source." : reason,
      candidateCount: candidates.length,
      bestCandidate: best ? { source: best.source, charCount: best.raw.length, score: best.score, ratio: best.ratio, trustedEditor: Boolean(best.trustedEditor) } : null,
      expectedChars: expected.chars,
      expectedLines: expected.lines,
    };
  }

  kpopSetStatus(
    `Kpoparkive RAW: ${sourceTitle} · source detected ✓\n${best.raw.length.toLocaleString()} chars · syntax score ${best.score}\nSaving to local helper…`,
    "ok",
  );

  return {
    ok: true,
    sourceTitle,
    editUrl: location.href,
    extractionMethod: best.source,
    charCount: best.raw.length,
    signalScore: best.score,
    trustedEditor: Boolean(best.trustedEditor),
    expectedChars: expected.chars,
    expectedLines: expected.lines,
    raw: best.raw,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "kpoparkive-extract-namu-edit-source") return;
  try { sendResponse(kpopExtractEditSource()); }
  catch (error) {
    kpopSetStatus(`Kpoparkive RAW error: ${error instanceof Error ? error.message : String(error)}`, "bad");
    sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

kpopEnsureStatusBadge();
let kpopDiagnosticTimer = setInterval(() => {
  try {
    if (!document.documentElement.isConnected) {
      clearInterval(kpopDiagnosticTimer);
      kpopDiagnosticTimer = null;
      return;
    }
    kpopExtractEditSource();
  } catch {}
}, 1000);
