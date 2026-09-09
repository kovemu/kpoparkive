"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./editor.module.css";

type Revision = {
  revision_no: number;
  content_language: string;
  summary: string | null;
  editor_label: string | null;
  created_at: string;
};

type EditorDocument = {
  id: string;
  source_title: string;
  root_title: string | null;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_language: string;
  content_status: string;
  content_revision_no: number;
  content_updated_at: string | null;
  content_updated_by: string | null;
  source_namumark_rendered_at: string | null;
  content_namumark_rendered_at: string | null;
  effective_wikitext: string;
  has_content_draft: boolean;
  needs_render: boolean;
};

type EditorPayload = {
  document: EditorDocument;
  revisions: Revision[];
};

function titleFromSegments(segments: string[]) {
  return segments.map((segment) => decodeURIComponent(segment)).join("/").normalize("NFKC").trim();
}

function wikiPath(title: string) {
  return `/w/${title.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

function formatTime(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export default function WikiEditorPage({ params }: { params: Promise<{ title: string[] }> }) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [title, setTitle] = useState("");
  const [adminKey, setAdminKey] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [document, setDocument] = useState<EditorDocument | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [content, setContent] = useState("");
  const [language, setLanguage] = useState("ko");
  const [summary, setSummary] = useState("");
  const [status, setStatus] = useState("Enter the admin key.");
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [renderNonce, setRenderNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    params.then(({ title: segments }) => {
      if (!cancelled) setTitle(titleFromSegments(segments));
    });
    return () => {
      cancelled = true;
    };
  }, [params]);

  useEffect(() => {
    const stored = sessionStorage.getItem("kpoparkive-admin-key") || "";
    if (stored) {
      setAdminKey(stored);
      setKeyInput(stored);
    }
  }, []);

  async function loadDocument(key = adminKey, targetTitle = title) {
    if (!key || !targetTitle) return;
    setBusy(true);
    setStatus("Loading document...");
    try {
      const response = await fetch(`/api/admin/wiki-editor?title=${encodeURIComponent(targetTitle)}`, {
        headers: { "x-admin-key": key },
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to load document");
      const payload = result as EditorPayload;
      setDocument(payload.document);
      setRevisions(payload.revisions || []);
      setContent(payload.document.effective_wikitext || "");
      setLanguage(payload.document.content_language || "ko");
      setSummary("");
      setDirty(false);
      setStatus(payload.document.needs_render ? "Draft loaded. Exact render is pending." : "Ready.");
    } catch (error) {
      setDocument(null);
      setStatus(error instanceof Error ? error.message : "Failed to load document");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (title && adminKey) void loadDocument(adminKey, title);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, adminKey]);

  async function submitKey() {
    const next = keyInput.trim();
    if (!next) return;
    sessionStorage.setItem("kpoparkive-admin-key", next);
    setAdminKey(next);
  }

  async function save() {
    if (!document || !adminKey || busy) return;
    setBusy(true);
    setStatus("Saving revision...");
    try {
      const response = await fetch("/api/admin/wiki-editor", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ action: "save", title, content, language, summary }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to save revision");
      await loadDocument(adminKey, title);
      setStatus(`Saved as r${result.revision_no}. Exact The Tree render is now pending.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save revision");
    } finally {
      setBusy(false);
    }
  }

  async function rollback(revisionNo: number) {
    if (!adminKey || busy) return;
    if (!window.confirm(`Create a new revision by rolling back to r${revisionNo}?`)) return;
    setBusy(true);
    setStatus(`Rolling back to r${revisionNo}...`);
    try {
      const response = await fetch("/api/admin/wiki-editor", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ action: "rollback", title, revisionNo }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Rollback failed");
      await loadDocument(adminKey, title);
      setStatus(`Rollback completed as new revision r${result.revision_no}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Rollback failed");
    } finally {
      setBusy(false);
    }
  }

  async function loadRevision(revisionNo: number) {
    if (!adminKey) return;
    setBusy(true);
    setStatus(`Loading r${revisionNo}...`);
    try {
      const response = await fetch(`/api/admin/wiki-editor?title=${encodeURIComponent(title)}&revision=${revisionNo}`, {
        headers: { "x-admin-key": adminKey },
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to load revision");
      setContent(result.revision.content_wikitext || "");
      setLanguage(result.revision.content_language || "ko");
      setSummary(`Based on r${revisionNo}`);
      setDirty(true);
      setStatus(`r${revisionNo} loaded into the editor. Saving will create a new revision.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load revision");
    } finally {
      setBusy(false);
    }
  }

  async function resetToSource() {
    if (!adminKey || busy) return;
    if (!window.confirm("Reset the editable draft to the captured Namu source? The source copy itself is never modified.")) return;
    setBusy(true);
    setStatus("Resetting draft to captured source...");
    try {
      const response = await fetch("/api/admin/wiki-editor", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminKey },
        body: JSON.stringify({ action: "reset-to-source", title }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Reset failed");
      await loadDocument(adminKey, title);
      setStatus(`Captured source copied into editable content as r${result.revision_no}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Reset failed");
    } finally {
      setBusy(false);
    }
  }

  function insertSyntax(before: string, after = "", placeholder = "text") {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = content.slice(start, end) || placeholder;
    const next = `${content.slice(0, start)}${before}${selected}${after}${content.slice(end)}`;
    setContent(next);
    setDirty(true);
    requestAnimationFrame(() => {
      textarea.focus();
      const cursorStart = start + before.length;
      textarea.setSelectionRange(cursorStart, cursorStart + selected.length);
    });
  }

  const currentWikiPath = useMemo(() => wikiPath(title), [title]);

  if (!adminKey || !document) {
    return (
      <main className={styles.loginShell}>
        <meta name="robots" content="noindex,nofollow,noarchive" />
        <section className={styles.loginCard}>
          <div className={styles.eyebrow}>KPOPARKIVE ADMIN</div>
          <h1>Wiki editor</h1>
          <p>{title || "Loading document title..."}</p>
          <label>
            Admin key
            <input
              type="password"
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submitKey();
              }}
            />
          </label>
          <button type="button" onClick={() => void submitKey()} disabled={!keyInput.trim() || busy}>Open editor</button>
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
          <div className={styles.eyebrow}>KPOPARKIVE WIKI EDITOR</div>
          <h1>{document.source_title}</h1>
          <div className={styles.metaRow}>
            <span>r{document.content_revision_no}</span>
            <span>{document.content_status}</span>
            <span>{language.toUpperCase()}</span>
            <span>Updated {formatTime(document.content_updated_at)}</span>
          </div>
        </div>
        <div className={styles.headerActions}>
          <a href={currentWikiPath} target="_blank" rel="noreferrer">Open page</a>
          <button type="button" className={styles.secondaryButton} onClick={() => setRenderNonce((value) => value + 1)}>Refresh render</button>
          <button type="button" onClick={() => void save()} disabled={busy || !dirty}>Save revision</button>
        </div>
      </header>

      <div className={styles.notice} data-pending={document.needs_render ? "true" : "false"}>
        <strong>{document.needs_render ? "Render pending" : "Render synced"}</strong>
        <span>
          Captured Namu source is immutable. Editing only changes Kpoparkive content. The right pane shows the last exact The Tree render until the renderer processes the new revision.
        </span>
      </div>

      <section className={styles.workspace}>
        <div className={styles.editorPane}>
          <div className={styles.toolbar}>
            <button type="button" onClick={() => insertSyntax("'''", "'''", "bold")}>B</button>
            <button type="button" onClick={() => insertSyntax("''", "''", "italic")}>I</button>
            <button type="button" onClick={() => insertSyntax("== ", " ==", "Heading")}>H2</button>
            <button type="button" onClick={() => insertSyntax("[[", "]]", "Target|Label")}>Link</button>
            <button type="button" onClick={() => insertSyntax("[[파일:", "|width=100%]]", "File name")}>File</button>
            <button type="button" onClick={() => insertSyntax("[* ", "]", "footnote")}>Footnote</button>
            <button type="button" onClick={() => insertSyntax("[youtube(", ")]", "VIDEO_ID")}>YouTube</button>
            <button type="button" onClick={() => insertSyntax("|| ", " ||", "cell 1 || cell 2")}>Table</button>
          </div>

          <textarea
            ref={textareaRef}
            className={styles.sourceEditor}
            spellCheck={false}
            value={content}
            onChange={(event) => {
              setContent(event.target.value);
              setDirty(true);
            }}
          />

          <div className={styles.editorFooter}>
            <div>{content.length.toLocaleString()} chars · {content.split("\n").length.toLocaleString()} lines</div>
            <label>
              Language
              <select value={language} onChange={(event) => { setLanguage(event.target.value); setDirty(true); }}>
                <option value="ko">KO</option>
                <option value="en">EN</option>
              </select>
            </label>
          </div>

          <label className={styles.summaryLabel}>
            Edit summary
            <input
              type="text"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What changed?"
            />
          </label>

          <div className={styles.saveRow}>
            <button type="button" onClick={() => void save()} disabled={busy || !dirty}>{busy ? "Working..." : "Save revision"}</button>
            <button type="button" className={styles.secondaryButton} onClick={() => void resetToSource()} disabled={busy}>Reset draft to source</button>
            <span className={styles.status}>{status}</span>
          </div>
        </div>

        <div className={styles.previewPane}>
          <div className={styles.paneTitle}>
            <strong>Current exact render</strong>
            <span>{document.needs_render ? "last rendered version" : "synced"}</span>
          </div>
          <iframe key={renderNonce} title={`${title} current render`} src={`${currentWikiPath}?editorPreview=${renderNonce}`} />
        </div>
      </section>

      <section className={styles.historyPanel}>
        <div className={styles.historyHeader}>
          <div>
            <div className={styles.eyebrow}>REVISION HISTORY</div>
            <h2>{revisions.length ? `${revisions.length} saved revisions` : "No editable revisions yet"}</h2>
          </div>
          <span>Rollback always creates a new revision.</span>
        </div>

        {revisions.length > 0 && (
          <div className={styles.revisionList}>
            {revisions.map((revision) => (
              <article key={revision.revision_no} className={styles.revisionRow}>
                <div className={styles.revisionNumber}>r{revision.revision_no}</div>
                <div className={styles.revisionBody}>
                  <strong>{revision.summary || "No edit summary"}</strong>
                  <span>{formatTime(revision.created_at)} · {revision.editor_label || "admin"} · {revision.content_language.toUpperCase()}</span>
                </div>
                <div className={styles.revisionActions}>
                  <button type="button" className={styles.secondaryButton} onClick={() => void loadRevision(revision.revision_no)} disabled={busy}>Load</button>
                  <button type="button" className={styles.secondaryButton} onClick={() => void rollback(revision.revision_no)} disabled={busy || revision.revision_no === document.content_revision_no}>Rollback</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
