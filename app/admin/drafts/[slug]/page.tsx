"use client";

import { useState } from "react";
import WikiBlocks from "../../../../components/wiki/WikiBlocks";

type Section = {
  id: string;
  section_key: string;
  heading: string;
  heading_level: number;
  sort_order: number;
  content: Parameters<typeof WikiBlocks>[0]["blocks"];
};

type DraftDocument = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  accent_color: string | null;
  status: string;
  updated_at: string;
  sections: Section[];
};

function numberSections(sections: { heading_level: number }[]) {
  let major = 0;
  let minor = 0;
  let patch = 0;
  return sections.map((section) => {
    if (section.heading_level <= 2) {
      major += 1;
      minor = 0;
      patch = 0;
      return `${major}`;
    }
    if (section.heading_level === 3) {
      minor += 1;
      patch = 0;
      return `${major}.${minor}`;
    }
    patch += 1;
    return `${major}.${minor}.${patch}`;
  });
}

export default function AdminDraftPreviewPage({ params }: { params: Promise<{ slug: string }> }) {
  const [adminKey, setAdminKey] = useState("");
  const [document, setDocument] = useState<DraftDocument | null>(null);
  const [status, setStatus] = useState("Enter the admin key to load this draft.");
  const [busy, setBusy] = useState(false);

  async function loadDraft() {
    setBusy(true);
    try {
      const { slug } = await params;
      const response = await fetch(`/api/admin/draft-preview?slug=${encodeURIComponent(slug)}`, {
        headers: { "x-admin-key": adminKey },
        cache: "no-store",
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Failed to load draft");
      setDocument(result.document);
      setStatus("");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to load draft");
    } finally {
      setBusy(false);
    }
  }

  if (!document) {
    return (
      <main className="adminShell">
        <section className="adminPanel">
          <h1>Draft preview</h1>
          <p className="adminIntro">This route reads draft documents with the service role and is protected by the Kpoparkive admin key.</p>
          <div className="adminForm">
            <label>Admin key<input type="password" value={adminKey} onChange={(e) => setAdminKey(e.target.value)} /></label>
            <button type="button" disabled={busy || !adminKey} onClick={loadDraft}>{busy ? "Loading..." : "Open draft"}</button>
          </div>
          <pre className="adminStatus">{status}</pre>
        </section>
      </main>
    );
  }

  const numbers = numberSections(document.sections);

  return (
    <>
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="draftBadge">ADMIN DRAFT · {document.status}</div>
      </header>

      <main id="top" className="articleShell" style={{ "--accent": document.accent_color ?? "#8d7cff" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › Admin draft › {document.title}</div>
            <h1>{document.title}</h1>
            {document.summary && <p>{document.summary}</p>}
          </div>
        </div>

        <nav className="toc" aria-label="Contents">
          <div className="tocHeader">Contents <span>⌄</span></div>
          <ol>
            {document.sections.map((section, index) => (
              <li key={section.id} className={`tocLevel${Math.max(1, section.heading_level - 1)}`}>
                <a href={`#${section.section_key}`}><span>{numbers[index]}.</span> {section.heading}</a>
              </li>
            ))}
          </ol>
        </nav>

        {document.sections.map((section, index) => {
          const Tag = section.heading_level >= 4 ? "h4" : section.heading_level === 3 ? "h3" : "h2";
          return (
            <section key={section.id}>
              <Tag id={section.section_key} className={`sectionTitle sectionLevel${section.heading_level}`}>
                <span className="sectionChevron">⌄</span>
                <span className="sectionNumber">{numbers[index]}.</span> {section.heading}
              </Tag>
              <WikiBlocks blocks={section.content} />
            </section>
          );
        })}
      </main>
    </>
  );
}
