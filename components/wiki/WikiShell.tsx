import type { ReactNode } from "react";

function encodeWikiTitle(title: string) {
  return title
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

export default function WikiShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const encodedTitle = encodeWikiTitle(title);

  return (
    <div className="wikiSiteShell">
      <header className="wikiSiteHeader">
        <div className="wikiHeaderInner">
          <a className="wikiBrand" href="/" aria-label="Kpoparkive home">
            <span className="wikiBrandMark" aria-hidden="true">K</span>
            <span className="wikiBrandText">Kpoparkive</span>
          </a>

          <form className="wikiGlobalSearch" action="/search" method="get" role="search">
            <svg className="wikiSearchIcon" viewBox="0 0 24 24" aria-hidden="true">
              <path d="m21 21-4.35-4.35m2.35-5.15A7.5 7.5 0 1 1 4 11.5a7.5 7.5 0 0 1 15 0Z" />
            </svg>
            <input
              name="q"
              type="search"
              placeholder="Search K-pop artists, groups, albums..."
              aria-label="Search Kpoparkive"
              autoComplete="off"
            />
            <button type="submit">Search</button>
          </form>

          <nav className="wikiHeaderNav" aria-label="Global navigation">
            <a href="/recent">Recent changes</a>
            <a href="/random">Random</a>
            <button className="wikiLanguageButton" type="button" aria-label="Language options" title="Language options">
              EN
            </button>
          </nav>
        </div>
      </header>

      <div className="wikiWorkspace">
        <aside className="wikiUtilityRail" aria-label="Wiki navigation">
          <div className="wikiUtilitySection">
            <div className="wikiUtilityLabel">Explore</div>
            <a className="is-active" href="/">Main page</a>
            <a href="/recent">Recent changes</a>
            <a href="/random">Random article</a>
          </div>
          <div className="wikiUtilitySection">
            <div className="wikiUtilityLabel">K-pop</div>
            <a href="/categories/groups">Groups</a>
            <a href="/categories/artists">Artists</a>
            <a href="/categories/discography">Discography</a>
          </div>
          <div className="wikiUtilitySection wikiUtilityMuted">
            <div className="wikiUtilityLabel">Kpoparkive</div>
            <a href="/about">About</a>
            <a href="/help">Help</a>
          </div>
        </aside>

        <main className="wikiDocumentColumn">
          <header className="wikiDocumentHeader">
            <div className="wikiDocumentHeading">
              <div className="wikiDocumentEyebrow">Kpoparkive</div>
              <h1>{title}</h1>
              <p>K-pop wiki article</p>
            </div>
            <div className="wikiDocumentTools" aria-label="Document tools">
              <button type="button" className="wikiWatchButton" title="Watch this article" aria-label="Watch this article">☆</button>
            </div>
          </header>

          <nav className="wikiDocumentTabs" aria-label="Document navigation">
            <a className="is-active" href={`/w/${encodedTitle}`}>Article</a>
            <a href={`/discussion/${encodedTitle}`}>Discussion</a>
            <span className="wikiTabsSpacer" />
            <a href={`/history/${encodedTitle}`}>History</a>
            <a className="wikiEditTab" href={`/edit/${encodedTitle}`}>Edit</a>
          </nav>

          <div className="wikiArticleFrame">{children}</div>
        </main>
      </div>
    </div>
  );
}
