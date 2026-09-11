"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "../../admin/editor/[...title]/editor.module.css";
import { renderPublicNamuMarkPreview } from "./draftPreview";

type EditorSnapshot = {
  content: string;
  selectionStart: number;
  selectionEnd: number;
  scrollTop: number;
  scrollLeft: number;
};

type PublicSourcePayload = {
  ok: true;
  document: {
    title: string;
    publicRevisionNo: number;
    sourceMode: "captured" | "published";
    sourceHash: string;
    source: string;
  };
};

function titleFromSegments(segments: string[]) {
  return segments
    .map((segment) => decodeURIComponent(segment))
    .join("/")
    .normalize("NFKC")
    .trim()
    .replace(/^문서:/, "")
    .trim();
}

function wikiPath(title: string) {
  return `/w/${title.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export default function PublicSourceEditorPage({
  params,
}: {
  params: Promise<{ title: string[] }>;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const undoStackRef = useRef<EditorSnapshot[]>([]);
  const redoStackRef = useRef<EditorSnapshot[]>([]);
  const composingRef = useRef(false);
  const [title, setTitle] = useState("");
  const [payload, setPayload] = useState<PublicSourcePayload | null>(null);
  const [content, setContent] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [summary, setSummary] = useState("");
  const [website, setWebsite] = useState("");
  const [status, setStatus] = useState("Loading source…");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [previewSource, setPreviewSource] = useState("");
  const [previewMode, setPreviewMode] = useState<"draft" | "public">("draft");

  useEffect(() => {
    let cancelled = false;
    params.then(({ title: segments }) => {
      if (!cancelled) setTitle(titleFromSegments(segments));
    });
    return () => { cancelled = true; };
  }, [params]);

  useEffect(() => {
    if (!title) return;
    let cancelled = false;
    setBusy(true);
    setStatus("Loading public NamuMark source…");
    fetch(`/api/wiki-source-edit?title=${encodeURIComponent(title)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Failed to load source");
        return result as PublicSourcePayload;
      })
      .then((result) => {
        if (cancelled) return;
        setPayload(result);
        setContent(result.document.source);
        setPreviewSource(result.document.source);
        undoStackRef.current = [];
        redoStackRef.current = [];
        setDirty(false);
        setSubmitted(false);
        setStatus("Ready. Edit the full NamuMark source and submit it for review.");
      })
      .catch((error) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Failed to load source");
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => { cancelled = true; };
  }, [title]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty || submitted) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, submitted]);

  useEffect(() => {
    const timer = window.setTimeout(() => setPreviewSource(content), 300);
    return () => window.clearTimeout(timer);
  }, [content]);

  function captureSnapshot(value = content): EditorSnapshot {
    const textarea = textareaRef.current;
    return {
      content: value,
      selectionStart: Math.min(textarea?.selectionStart || 0, value.length),
      selectionEnd: Math.min(textarea?.selectionEnd || 0, value.length),
      scrollTop: textarea?.scrollTop || 0,
      scrollLeft: textarea?.scrollLeft || 0,
    };
  }

  function pushUndo(snapshot = captureSnapshot()) {
    undoStackRef.current.push(snapshot);
    if (undoStackRef.current.length > 250) undoStackRef.current.shift();
    redoStackRef.current = [];
  }

  function restoreSnapshot(snapshot: EditorSnapshot, message: string) {
    const viewportX = window.scrollX;
    const viewportY = window.scrollY;
    setContent(snapshot.content);
    setDirty(snapshot.content !== payload?.document.source);
    setStatus(message);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus({ preventScroll: true });
      textarea.setSelectionRange(
        Math.min(snapshot.selectionStart, snapshot.content.length),
        Math.min(snapshot.selectionEnd, snapshot.content.length),
      );
      textarea.scrollTop = snapshot.scrollTop;
      textarea.scrollLeft = snapshot.scrollLeft;
      window.scrollTo(viewportX, viewportY);
    });
  }

  function undo() {
    const previous = undoStackRef.current.pop();
    if (!previous) return;
    redoStackRef.current.push(captureSnapshot());
    restoreSnapshot(previous, "Undo");
  }

  function redo() {
    const next = redoStackRef.current.pop();
    if (!next) return;
    undoStackRef.current.push(captureSnapshot());
    restoreSnapshot(next, "Redo");
  }

  function insertSyntax(before: string, after = "", placeholder = "text") {
    const textarea = textareaRef.current;
    if (!textarea || submitted) return;

    const viewportX = window.scrollX;
    const viewportY = window.scrollY;
    const scrollTop = textarea.scrollTop;
    const scrollLeft = textarea.scrollLeft;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next = `${content.slice(0, start)}${before}${selected}${after}${content.slice(end)}`;

    pushUndo(captureSnapshot(content));
    setContent(next);
    setDirty(next !== payload?.document.source);

    requestAnimationFrame(() => {
      const current = textareaRef.current;
      if (!current) return;
      current.focus({ preventScroll: true });
      const cursorStart = start + before.length;
      current.setSelectionRange(cursorStart, cursorStart + selected.length);
      current.scrollTop = scrollTop;
      current.scrollLeft = scrollLeft;
      window.scrollTo(viewportX, viewportY);
    });
  }

  async function submitEdit() {
    if (!payload || !dirty || busy || submitted) return;
    if (!window.confirm("Submit this full-page source edit for review? The live article will not change until an administrator approves it.")) return;

    setBusy(true);
    setStatus("Submitting edit proposal…");
    try {
      const response = await fetch("/api/wiki-source-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: payload.document.title,
          content,
          baseRevisionNo: payload.document.publicRevisionNo,
          baseSourceHash: payload.document.sourceHash,
          summary,
          displayName,
          website,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to submit edit");

      setSubmitted(true);
      setDirty(false);
      setStatus(result.proposalId
        ? `Submitted for review · proposal ${result.proposalId}`
        : "Submitted for review.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to submit edit");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    if (!payload || submitted) return;
    if (dirty && !window.confirm("Discard your unsaved changes and restore the current public source?")) return;
    setContent(payload.document.source);
    setPreviewSource(payload.document.source);
    undoStackRef.current = [];
    redoStackRef.current = [];
    setSummary("");
    setDirty(false);
    setStatus("Restored current public source.");
  }

  const currentWikiPath = useMemo(() => wikiPath(title), [title]);
  const draftPreviewHtml = useMemo(() => renderPublicNamuMarkPreview(previewSource), [previewSource]);
  const previewPending = previewSource !== content;

  if (!payload) {
    return (
      <main className={styles.loginShell}>
        <meta name="robots" content="noindex,nofollow,noarchive" />
        <section className={styles.loginCard}>
          <div className={styles.eyebrow}>KPOPARKIVE SOURCE EDITOR</div>
          <h1>{title || "Wiki editor"}</h1>
          <p>No login is required. Edits are reviewed before publication.</p>
          <div className={styles.status}>{status}</div>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <meta name="robots" content="noindex,nofollow,noarchive" />

      <header className={styles.header}>
        <div>
          <div className={styles.eyebrow}>KPOPARKIVE PUBLIC SOURCE EDITOR</div>
          <h1>{payload.document.title}</h1>
          <div className={styles.metaRow}>
            <span>{payload.document.sourceMode}</span>
            <span>{content.length.toLocaleString()} chars</span>
            <span>{content.split("\n").length.toLocaleString()} lines</span>
            <span>Review required</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <a href={currentWikiPath}>Back to article</a>
          <button type="button" className={styles.secondaryButton} onClick={reset} disabled={busy || submitted}>Reset</button>
          <button type="button" onClick={() => void submitEdit()} disabled={busy || !dirty || submitted}>
            {submitted ? "Submitted" : busy ? "Submitting…" : "Submit edit"}
          </button>
        </div>
      </header>

      <div className={styles.notice}>
        <strong>{submitted ? "Submitted" : "Public source editing"}</strong>
        <span>
          You are editing the complete NamuMark source. Your submission does not change the live article immediately; it enters the review queue first.
        </span>
      </div>

      <section className={styles.workspace}>
        <div className={styles.editorPane}>
          <div className={styles.toolbar}>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("'''", "'''", "bold")} disabled={submitted}>B</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("''", "''", "italic")} disabled={submitted}>I</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("== ", " ==", "Heading")} disabled={submitted}>H2</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("=== ", " ===", "Subheading")} disabled={submitted}>H3</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("[[", "]]", "Target|Label")} disabled={submitted}>Link</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("[[파일:", "|width=100%]]", "File name")} disabled={submitted}>File</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("[* ", "]", "footnote")} disabled={submitted}>Footnote</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("[youtube(", ")]", "VIDEO_ID")} disabled={submitted}>YouTube</button>
            <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSyntax("|| ", " ||", "cell 1 || cell 2")} disabled={submitted}>Table</button>
          </div>

          <textarea
            ref={textareaRef}
            className={styles.sourceEditor}
            spellCheck={false}
            value={content}
            readOnly={submitted}
            onCompositionStart={() => {
              if (composingRef.current) return;
              pushUndo(captureSnapshot(content));
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(event) => {
              const modifier = event.ctrlKey || event.metaKey;
              if (modifier && event.key.toLowerCase() === "z") {
                event.preventDefault();
                if (event.shiftKey) redo();
                else undo();
                return;
              }
              if (modifier && event.key.toLowerCase() === "y") {
                event.preventDefault();
                redo();
              }
            }}
            onChange={(event) => {
              const next = event.target.value;
              if (!composingRef.current) pushUndo(captureSnapshot(content));
              setContent(next);
              setDirty(next !== payload.document.source);
            }}
          />

          <div className={styles.editorFooter}>
            <div>{content.length.toLocaleString()} chars · {content.split("\n").length.toLocaleString()} lines</div>
            <div>Base revision: {payload.document.publicRevisionNo || "captured source"}</div>
          </div>

          <label className={styles.summaryLabel}>
            Display name <span style={{ fontWeight: 400, color: "#81778b" }}>optional</span>
            <input
              type="text"
              value={displayName}
              disabled={submitted}
              maxLength={80}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder="Name shown to reviewers"
            />
          </label>

          <label className={styles.summaryLabel}>
            Edit summary
            <input
              type="text"
              value={summary}
              disabled={submitted}
              maxLength={500}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What did you change?"
            />
          </label>

          <label aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
            Website
            <input
              tabIndex={-1}
              autoComplete="off"
              value={website}
              onChange={(event) => setWebsite(event.target.value)}
            />
          </label>

          <div className={styles.saveRow}>
            <button type="button" onClick={() => void submitEdit()} disabled={busy || !dirty || submitted}>
              {submitted ? "Submitted for review" : busy ? "Submitting…" : "Submit edit"}
            </button>
            <button type="button" className={styles.secondaryButton} onClick={reset} disabled={busy || submitted}>Reset</button>
            <span className={styles.status}>{status}</span>
          </div>
        </div>

        <div className={styles.previewPane}>
          <div className={styles.paneTitle}>
            <div className={styles.previewTitleGroup}>
              <strong>{previewMode === "draft" ? "Draft preview" : "Current public page"}</strong>
              <span>
                {previewMode === "draft"
                  ? (previewPending ? "Updating…" : "Reflects the source on the left")
                  : "Live page before approval"}
              </span>
            </div>
            <div className={styles.previewTabs}>
              <button
                type="button"
                className={previewMode === "draft" ? styles.previewTabActive : styles.previewTab}
                onClick={() => setPreviewMode("draft")}
              >Draft</button>
              <button
                type="button"
                className={previewMode === "public" ? styles.previewTabActive : styles.previewTab}
                onClick={() => setPreviewMode("public")}
              >Current public</button>
            </div>
          </div>
          {previewMode === "draft" ? (
            <div
              className={styles.draftPreview}
              onClick={(event) => {
                const target = event.target as Element | null;
                if (target?.closest("a")) event.preventDefault();
              }}
              dangerouslySetInnerHTML={{ __html: draftPreviewHtml }}
            />
          ) : (
            <iframe className={styles.publicPreviewFrame} title={`${title} current public page`} src={currentWikiPath} />
          )}
        </div>
      </section>
    </main>
  );
}
