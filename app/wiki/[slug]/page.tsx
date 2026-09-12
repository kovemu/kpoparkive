import { notFound } from "next/navigation";
import WikiBlocks from "../../../components/wiki/WikiBlocks";
import { getStoragePublicUrl, getWikiDocument, getWikiMedia } from "../../../lib/wiki";

export const metadata = {
  robots: { index: false, follow: false },
};

const albumCoverBySlug: Record<string, string> = {
  "re-scene": "rescene/albums/re-scene.jpg",
  scenedrome: "rescene/albums/scenedrome.jpg",
  "glow-up": "rescene/albums/glow-up.jpg",
  dearest: "rescene/albums/dearest.jpg",
  "heart-drop": "rescene/albums/heart-drop.jpg",
  "lip-bomb": "rescene/albums/lip-bomb.jpg",
  runaway: "rescene/albums/runaway.jpg",
  "pretty-girl": "rescene/albums/pretty-girl.jpg",
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

export default async function WikiPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const document = await getWikiDocument(slug);
  if (!document) notFound();

  const media = await getWikiMedia(document.id);
  const infoboxImage = [...media].reverse().find((item) => item.role === "infobox");
  const albumCover = albumCoverBySlug[slug];
  const leadImage = infoboxImage ? getStoragePublicUrl(infoboxImage.storage_path) : albumCover ? getStoragePublicUrl(albumCover) : null;
  const leadCaption = infoboxImage?.caption ?? (albumCover ? `${document.title} — official release artwork` : null);
  const numbers = numberSections(document.sections);

  return (
    <>
      <header className="siteHeader">
        <a className="brand" href="/">Kpoparkive</a>
        <div className="searchWrap">
          <input aria-label="Search Kpoparkive" placeholder="Search an idol, group, album..." />
          <button type="button">Search</button>
        </div>
      </header>

      <main id="top" className="articleShell" style={{ "--accent": document.accent_color ?? "#8d7cff" } as React.CSSProperties}>
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs"><a href="/">Kpoparkive</a> › <a href="/">RESCENE</a> › {document.title}</div>
            <h1>{document.title}</h1>
            {document.summary && <p>{document.summary}</p>}
          </div>
        </div>

        {leadImage && (
          <div className="memberLead">
            <figure className="memberLeadPhotoWrap">
              <img
                className="memberLeadPhoto"
                src={leadImage}
                alt={infoboxImage?.alt_text ?? `${document.title} artwork`}
              />
              {leadCaption && <figcaption>{leadCaption}</figcaption>}
            </figure>
          </div>
        )}

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
