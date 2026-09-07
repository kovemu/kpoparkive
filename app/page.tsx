import WikiBlocks from "../components/wiki/WikiBlocks";
import { getWikiDocument } from "../lib/wiki";

function SectionTitle({ id, number, level, children }: { id: string; number: string; level: number; children: React.ReactNode }) {
  const Tag = level >= 4 ? "h4" : level === 3 ? "h3" : "h2";
  return (
    <Tag id={id} className={`sectionTitle sectionLevel${level}`}>
      <span className="sectionChevron">⌄</span>
      <span className="sectionNumber">{number}.</span> {children}
      <a className="editLink" href="#top" aria-label={`Edit ${children}`}>[edit]</a>
    </Tag>
  );
}

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

export default async function Home() {
  const document = await getWikiDocument("rescene");

  if (!document) {
    return <main className="articleShell"><h1>RESCENE</h1><p>Document not found.</p></main>;
  }

  const numbers = numberSections(document.sections);
  const updated = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(new Date(document.updated_at));

  return (
    <>
      <header className="siteHeader">
        <a className="brand" href="#top">Kpoparkive</a>
        <div className="searchWrap">
          <input aria-label="Search Kpoparkive" placeholder="Search an idol, group, album..." />
          <button type="button">Search</button>
        </div>
      </header>

      <main id="top" className="articleShell" style={{ "--accent": document.accent_color ?? "#ff62c7" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs">Kpoparkive › Girl groups › {document.title}</div>
            <h1>{document.title}</h1>
            <p className="updated">Last updated: {updated}</p>
          </div>
          <div className="articleActions">
            <button type="button">☆</button>
            <button type="button">Edit</button>
            <button type="button">History</button>
          </div>
        </div>

        <div className="introGrid">
          <div className="leadCopy">
            <p><strong>{document.title}</strong> {document.summary?.replace(/^RESCENE\s+/, "")}</p>
            <p className="dbBadge">Live document · Supabase-backed</p>
          </div>

          <aside className="infobox" aria-label="RESCENE profile">
            <div className="infoboxHero">
              <div className="wordmark">Rescene</div>
              <div>
                <strong>RESCENE</strong>
                <span>리센느</span>
              </div>
            </div>
            <div className="photoPlaceholder">RESCENE</div>
            <dl className="facts">
              <div><dt>Debut</dt><dd>🇰🇷 March 26, 2024<br />🇯🇵 August 16, 2024<br />🇺🇸 February 17, 2025</dd></div>
              <div><dt>Debut release</dt><dd><span className="pill pink">Re:Scene</span></dd></div>
              <div><dt>Genre</dt><dd>K-pop, Dance, Pop, R&amp;B / Soul, Ballad</dd></div>
              <div><dt>Leader</dt><dd><a href="/wiki/woni">Woni</a></dd></div>
              <div><dt>Agency</dt><dd>The Muze Entertainment</dd></div>
              <div><dt>Fandom</dt><dd><strong>REMINE</strong></dd></div>
            </dl>
          </aside>
        </div>

        <nav className="toc" aria-label="Contents">
          <div className="tocHeader">Contents <span>⌄</span></div>
          <ol>
            {document.sections.map((section, index) => {
              const level = Math.max(1, section.heading_level - 1);
              return (
                <li key={section.id} className={`tocLevel${level}`}>
                  <a href={`#${section.section_key}`}><span>{numbers[index]}.</span> {section.heading}</a>
                </li>
              );
            })}
          </ol>
        </nav>

        {document.sections.map((section, index) => (
          <section key={section.id}>
            <SectionTitle id={section.section_key} number={numbers[index]} level={section.heading_level}>
              {section.heading}
            </SectionTitle>
            <WikiBlocks blocks={section.content} />
          </section>
        ))}
      </main>

      <div className="floatingNav" aria-label="Page navigation">
        <a href="#top">↑</a>
        <a href="#see-also">↓</a>
      </div>
    </>
  );
}
