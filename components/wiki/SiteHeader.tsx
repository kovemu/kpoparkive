export default function SiteHeader() {
  return (
    <header className="siteTopbar">
      <div className="siteTopbarInner">
        <a className="siteLogo" href="/" aria-label="Kpoparkive home">
          <span className="siteLogoMark" aria-hidden="true">
            <svg viewBox="0 0 36 36" role="presentation">
              <rect x="2" y="2" width="32" height="32" rx="10" fill="white" />
              <path
                d="M12 10.5v15"
                stroke="url(#kpoparkive-mark-gradient)"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
              <path
                d="M13.5 18 23 10.8"
                stroke="url(#kpoparkive-mark-gradient)"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
              <path
                d="M13.5 18 23 25.2"
                stroke="url(#kpoparkive-mark-gradient)"
                strokeWidth="2.8"
                strokeLinecap="round"
              />
              <circle cx="25.2" cy="9.8" r="1.8" fill="#c026d3" />
              <defs>
                <linearGradient
                  id="kpoparkive-mark-gradient"
                  x1="10"
                  y1="10"
                  x2="26"
                  y2="26"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop stopColor="#5b21b6" />
                  <stop offset="1" stopColor="#c026d3" />
                </linearGradient>
              </defs>
            </svg>
          </span>
          <span className="siteLogoText">Kpoparkive</span>
        </a>

        <form className="siteSearch" action="/search" method="get" role="search">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m21 21-4.35-4.35m2.35-5.15A7.5 7.5 0 1 1 4 11.5a7.5 7.5 0 0 1 15 0Z" />
          </svg>
          <input
            name="q"
            type="search"
            placeholder="Search K-pop groups, artists, albums..."
            aria-label="Search Kpoparkive"
            autoComplete="off"
          />
        </form>

        <a className="siteLogin" href="/login">Log in</a>
      </div>
    </header>
  );
}
