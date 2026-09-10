"use client";

import { useEffect, useMemo, useState } from "react";
import styles from "./easy-edit.module.css";

type EasyBlock = {
  key: string;
  blockIndex: number;
  plainText: string;
  editable: boolean;
  lockedReason: string | null;
};

type EasySection = {
  key: string;
  level: number;
  heading: string;
  editableCount: number;
  lockedCount: number;
  blocks: EasyBlock[];
};

type EasyPayload = {
  document: {
    title: string;
    publicRevisionNo: number;
    sourceMode: string;
  };
  sections: EasySection[];
};

function titleFromSegments(segments: string[]) {
  return segments.map((segment) => decodeURIComponent(segment)).join("/").normalize("NFKC").trim();
}

function wikiPath(title: string) {
  return `/w/${title.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

export default function EasyWikiEditPage({ params }: { params: Promise<{ title: string[] }> }) {
  const [title, setTitle] = useState("");
  const [payload, setPayload] = useState<EasyPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState("");
  const [submitted, setSubmitted] = useState<Record<string, boolean>>({});
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({});
  const [website, setWebsite] = useState("");

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
    if (!title) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/wiki-edit?title=${encodeURIComponent(title)}`, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "Failed to load Easy Edit");
        return result as EasyPayload;
      })
      .then((result) => {
        if (cancelled) return;
        setPayload(result);
        const nextDrafts: Record<string, string> = {};
        const nextOpen: Record<string, boolean> = {};
        let openedOne = false;
        for (const section of result.sections) {
          for (const block of section.blocks) nextDrafts[block.key] = block.plainText;
          if (!openedOne && section.editableCount > 0) {
            nextOpen[section.key] = true;
            openedOne = true;
          }
        }
        setDrafts(nextDrafts);
        setOpenSections(nextOpen);
      })
      .catch((caught) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : "Failed to load Easy Edit");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [title]);

  const editableTotal = useMemo(
    () => payload?.sections.reduce((sum, section) => sum + section.editableCount, 0) || 0,
    [payload],
  );

  const lockedTotal = useMemo(
    () => payload?.sections.reduce((sum, section) => sum + section.lockedCount, 0) || 0,
    [payload],
  );

  async function submitBlock(section: EasySection, block: EasyBlock) {
    if (!payload || busyKey) return;
    const proposedText = (drafts[block.key] || "").trim();
    if (!proposedText || proposedText === block.plainText.trim()) return;

    setBusyKey(block.key);
    setError("");
    try {
      const response = await fetch("/api/wiki-edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: payload.document.title,
          blockKey: block.key,
          proposedText,
          summary: summaries[block.key] || "",
          displayName,
          baseRevisionNo: payload.document.publicRevisionNo,
          website,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to submit suggestion");
      setSubmitted((current) => ({ ...current, [block.key]: true }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to submit suggestion");
    } finally {
      setBusyKey("");
    }
  }

  if (loading) {
    return <main className={styles.stateShell}>Loading Easy Edit…</main>;
  }

  if (!payload || error && !title) {
    return <main className={styles.stateShell}>{error || "Document not found."}</main>;
  }

  return (
    <main className={styles.page}>
      <meta name="robots" content="noindex,nofollow,noarchive" />
      <header className={styles.topbar}>
        <a className={styles.brand} href="/">Kpoparkive</a>
        <div className={styles.topActions}>
          <a href={wikiPath(payload.document.title)}>Back to article</a>
        </div>
      </header>

      <section className={styles.hero}>
        <div className={styles.eyebrow}>EASY EDIT</div>
        <h1>{payload.document.title}</h1>
        <p>
          Edit the readable text only. You do not need to learn wiki syntax. Tables, templates, media and other fragile blocks stay locked and are preserved automatically.
        </p>
        <div className={styles.stats}>
          <span><strong>{editableTotal}</strong> editable text blocks</span>
          <span><strong>{lockedTotal}</strong> protected blocks</span>
          <span>Changes are reviewed before publication</span>
        </div>
      </section>

      <section className={styles.identityCard}>
        <label>
          Display name <span>optional</span>
          <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} placeholder="Name shown to reviewers" />
        </label>
        <label className={styles.honeypot} aria-hidden="true">
          Website
          <input tabIndex={-1} autoComplete="off" value={website} onChange={(event) => setWebsite(event.target.value)} />
        </label>
        <p>Your suggestion does not change the live article immediately. An editor reviews it first.</p>
      </section>

      {error ? <div className={styles.errorBanner}>{error}</div> : null}

      <div className={styles.sections}>
        {payload.sections.map((section) => {
          const open = Boolean(openSections[section.key]);
          return (
            <section className={styles.sectionCard} key={section.key}>
              <button
                type="button"
                className={styles.sectionHeader}
                onClick={() => setOpenSections((current) => ({ ...current, [section.key]: !open }))}
              >
                <span className={styles.sectionTitle} style={{ paddingLeft: `${Math.max(0, section.level - 2) * 18}px` }}>
                  {section.heading}
                </span>
                <span className={styles.sectionMeta}>
                  {section.editableCount ? `${section.editableCount} editable` : "protected"}
                  <span className={styles.chevron}>{open ? "−" : "+"}</span>
                </span>
              </button>

              {open ? (
                <div className={styles.sectionBody}>
                  {section.blocks.map((block) => {
                    if (!block.editable) {
                      return (
                        <div className={styles.lockedBlock} key={block.key}>
                          <span>Protected block</span>
                          <small>{block.lockedReason || "Complex wiki structure is preserved automatically."}</small>
                        </div>
                      );
                    }

                    const changed = (drafts[block.key] || "").trim() !== block.plainText.trim();
                    const isSubmitted = Boolean(submitted[block.key]);
                    return (
                      <article className={styles.editBlock} key={block.key}>
                        <div className={styles.blockTopline}>
                          <span>Text block</span>
                          {isSubmitted ? <strong className={styles.submitted}>Submitted for review</strong> : null}
                        </div>
                        <textarea
                          value={drafts[block.key] ?? block.plainText}
                          disabled={isSubmitted}
                          onChange={(event) => setDrafts((current) => ({ ...current, [block.key]: event.target.value }))}
                          rows={Math.min(14, Math.max(4, (drafts[block.key] || block.plainText).split("\n").length + 2))}
                        />
                        <div className={styles.blockFooter}>
                          <input
                            type="text"
                            value={summaries[block.key] || ""}
                            disabled={isSubmitted}
                            onChange={(event) => setSummaries((current) => ({ ...current, [block.key]: event.target.value }))}
                            maxLength={500}
                            placeholder="Short reason for this change (optional)"
                          />
                          <button
                            type="button"
                            disabled={!changed || isSubmitted || Boolean(busyKey)}
                            onClick={() => void submitBlock(section, block)}
                          >
                            {busyKey === block.key ? "Submitting…" : isSubmitted ? "Submitted" : "Submit suggestion"}
                          </button>
                          {!isSubmitted && changed ? (
                            <button
                              type="button"
                              className={styles.resetButton}
                              onClick={() => setDrafts((current) => ({ ...current, [block.key]: block.plainText }))}
                            >
                              Reset
                            </button>
                          ) : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })}
      </div>

      <footer className={styles.footer}>
        <strong>Why are some parts locked?</strong>
        <p>Kpoparkive preserves complex imported tables, templates and media as protected source blocks. Easy Edit only exposes text that can be changed without breaking the article layout.</p>
      </footer>
    </main>
  );
}
