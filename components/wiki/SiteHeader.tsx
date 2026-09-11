export default function SiteHeader() {
  return (
    <header className="siteTopbar">
      <div className="siteTopbarInner">
        <a className="siteLogo" href="/" aria-label="Kpoparkive home">
          <span className="siteLogoMark" aria-hidden="true">K</span>
          <span>Kpoparkive</span>
        </a>

        <form className="siteSearch" action="/search" method="get" role="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m21 21-4.35-4.35m2.35-5.15A7.5 7.5 0 1 1 4 11.5a7.5 7.5 0 0 1 15 0Z" />
          </svg>
          <input
            name="q"
            type="search"
            placeholder="Search K-pop..."
            aria-label="Search Kpoparkive"
            autoComplete="off"
          />
        </form>

        <a className="siteLogin" href="/login">Log in</a>
      </div>
    </header>
  );
}
