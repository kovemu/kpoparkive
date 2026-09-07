const toc = [
  ["1", "Overview"],
  ["2", "Members"],
  ["2.1", "Member chemistry"],
  ["3", "Characteristics"],
  ["3.1", "Logo"],
  ["3.2", "Group name"],
  ["3.3", "Concept"],
  ["3.4", "Visual"],
  ["4", "Discography"],
  ["5", "Music videos"],
  ["6", "Activities"],
  ["6.1", "Content"],
  ["6.2", "Performances & events"],
  ["6.3", "Music shows"],
  ["6.3.1", "Fancams"],
  ["6.4", "Advertising & pictorials"],
  ["6.5", "YouTube LIVE"],
  ["7", "Fandom"],
  ["7.1", "Fan chants"],
  ["7.2", "Goods"],
  ["8", "Awards"],
  ["9", "Detailed chart performance"],
  ["10", "Trivia"],
  ["11", "Profile photo history"],
  ["12", "See also"],
] as const;

const members = [
  { name: "Woni", born: "May 25, 2004", nationality: "🇰🇷" },
  { name: "Liv", born: "Oct 11, 2006", nationality: "🇰🇷" },
  { name: "Minami", born: "Nov 29, 2006", nationality: "🇯🇵" },
  { name: "May", born: "Aug 19, 2008", nationality: "🇰🇷" },
  { name: "Zena", born: "Nov 27, 2008", nationality: "🇰🇷" },
] as const;

function SectionTitle({ id, number, children }: { id: string; number: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="sectionTitle">
      <span className="sectionChevron">⌄</span>
      <span className="sectionNumber">{number}.</span> {children}
      <a className="editLink" href="#top" aria-label={`Edit ${children}`}>[edit]</a>
    </h2>
  );
}

export default function Home() {
  return (
    <>
      <header className="siteHeader">
        <a className="brand" href="#top">Kpoparkive</a>
        <div className="searchWrap">
          <input aria-label="Search Kpoparkive" placeholder="Search an idol, group, album..." />
          <button type="button">Search</button>
        </div>
      </header>

      <main id="top" className="articleShell">
        <div className="articleHeader">
          <div>
            <div className="breadcrumbs">Kpoparkive › Girl groups › RESCENE</div>
            <h1>RESCENE</h1>
            <p className="updated">Last updated: September 7, 2026</p>
          </div>
          <div className="articleActions">
            <button type="button">☆</button>
            <button type="button">Edit</button>
            <button type="button">History</button>
          </div>
        </div>

        <div className="introGrid">
          <div className="leadCopy">
            <p>
              <strong>RESCENE</strong> is a five-member South Korean girl group under The Muze Entertainment.
              The group debuted on March 26, 2024 with the single album <em>Re:Scene</em>.
            </p>
            <p>
              Their identity centers on the idea of scent and memory: music that can bring a scene back to mind
              the way a familiar fragrance can revive a forgotten moment.
            </p>
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
              <div><dt>Genre</dt><dd>K-pop, Dance, Pop, R&B / Soul, Ballad</dd></div>
              <div><dt>Leader</dt><dd><a href="#members">Woni</a></dd></div>
              <div><dt>Agency</dt><dd>The Muze Entertainment</dd></div>
              <div><dt>Fandom</dt><dd><strong>REMINE</strong></dd></div>
            </dl>
          </aside>
        </div>

        <nav className="toc" aria-label="Contents">
          <div className="tocHeader">Contents <span>⌄</span></div>
          <ol>
            {toc.map(([number, label]) => {
              const level = number.split(".").length;
              const id = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
              return (
                <li key={`${number}-${label}`} className={`tocLevel${level}`}>
                  <a href={`#${id}`}><span>{number}.</span> {label}</a>
                </li>
              );
            })}
          </ol>
        </nav>

        <section>
          <SectionTitle id="overview" number="1">Overview</SectionTitle>
          <div className="videoPlaceholder">
            <span>RESCENE — Debut Trailer</span>
            <small>YouTube embed placeholder</small>
          </div>
          <p>
            RESCENE debuted as a multinational five-member girl group composed of Woni, Liv, Minami, May and Zena.
            Their name combines <strong>RE</strong> and <strong>SCENE</strong>, expressing the idea of recalling a scene again.
          </p>
        </section>

        <section>
          <SectionTitle id="members" number="2">Members</SectionTitle>
          <div className="memberGrid">
            {members.map((member) => (
              <article className="memberCard" key={member.name}>
                <div className="memberPortrait">{member.name.slice(0, 1)}</div>
                <a href="#members" className="memberName">{member.name}</a>
                <div className="memberMeta">{member.born}</div>
                <div className="flag">{member.nationality}</div>
              </article>
            ))}
          </div>

          <SectionTitle id="member-chemistry" number="2.1">Member chemistry</SectionTitle>
          <div className="subdocNotice">Detailed article: <a href="#member-chemistry">RESCENE / Member chemistry</a></div>
        </section>

        <section>
          <SectionTitle id="characteristics" number="3">Characteristics</SectionTitle>
          <SectionTitle id="logo" number="3.1">Logo</SectionTitle>
          <p>The group uses a fragrance-inspired wordmark that changes subtly across releases.</p>

          <SectionTitle id="group-name" number="3.2">Group name</SectionTitle>
          <blockquote className="accentQuote">
            RESCENE combines “RE” and “SCENE,” carrying the ambition to present a musical fragrance that remains
            in the listener&apos;s memory for a long time.
          </blockquote>

          <SectionTitle id="concept" number="3.3">Concept</SectionTitle>
          <div className="accentBox">
            <p>
              The group&apos;s central motif connects <strong>scene</strong> and <strong>scent</strong>. Their releases use fragrance
              as a metaphor for memory, drawing on the familiar experience of a smell suddenly bringing a past moment back.
            </p>
            <p>
              Rather than treating the motif as a one-off debut concept, RESCENE has continued to build album imagery,
              styling and storytelling around different impressions of scent.
            </p>
          </div>

          <SectionTitle id="visual" number="3.4">Visual</SectionTitle>
          <ul className="wikiList">
            <li>The group is frequently noted for a cohesive visual image when all five members appear together.</li>
            <li>Minami and Zena had some pre-debut public exposure, while Woni, Liv and May were comparatively less known before member reveals.</li>
          </ul>
        </section>

        <section>
          <SectionTitle id="discography" number="4">Discography</SectionTitle>
          <div className="simpleTable">
            <div className="tableHead"><span>Release</span><span>Type</span><span>Date</span></div>
            <div><strong>Re:Scene</strong><span>Single album</span><span>Mar 26, 2024</span></div>
            <div><strong>SCENEDROME</strong><span>Mini album</span><span>Aug 27, 2024</span></div>
          </div>
        </section>

        <section>
          <SectionTitle id="music-videos" number="5">Music videos</SectionTitle>
          <p>Music video tables and view milestones will be rendered here.</p>
        </section>

        <section>
          <SectionTitle id="activities" number="6">Activities</SectionTitle>
          <div className="subdocNotice">Detailed article: <a href="#activities">RESCENE / Activities</a></div>
          <SectionTitle id="content" number="6.1">Content</SectionTitle>
          <SectionTitle id="performances-events" number="6.2">Performances &amp; events</SectionTitle>
          <SectionTitle id="music-shows" number="6.3">Music shows</SectionTitle>
          <SectionTitle id="fancams" number="6.3.1">Fancams</SectionTitle>
          <SectionTitle id="advertising-pictorials" number="6.4">Advertising &amp; pictorials</SectionTitle>
          <SectionTitle id="youtube-live" number="6.5">YouTube LIVE</SectionTitle>
          <ul className="wikiList">
            <li>RESCENE is known for using YouTube Live frequently, including late-night and extended broadcasts.</li>
            <li>Long-form live streams and casual communication with fans form a notable part of the group&apos;s ongoing content.</li>
          </ul>
        </section>

        <section>
          <SectionTitle id="fandom" number="7">Fandom</SectionTitle>
          <p>The official fandom name is <strong>REMINE</strong>.</p>
          <SectionTitle id="fan-chants" number="7.1">Fan chants</SectionTitle>
          <SectionTitle id="goods" number="7.2">Goods</SectionTitle>
          <SectionTitle id="awards" number="8">Awards</SectionTitle>
          <SectionTitle id="detailed-chart-performance" number="9">Detailed chart performance</SectionTitle>
          <SectionTitle id="trivia" number="10">Trivia</SectionTitle>
          <SectionTitle id="profile-photo-history" number="11">Profile photo history</SectionTitle>
          <div className="profileHistory">
            <div>Re:Scene</div><div>YoYo</div><div>SCENEDROME</div><div>Glow Up</div><div>Dearest</div><div>Recent</div>
          </div>
          <SectionTitle id="see-also" number="12">See also</SectionTitle>
        </section>
      </main>

      <div className="floatingNav" aria-label="Page navigation">
        <a href="#top">↑</a>
        <a href="#see-also">↓</a>
      </div>
    </>
  );
}
