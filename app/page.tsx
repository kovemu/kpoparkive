import SiteHeader from "../components/wiki/SiteHeader";
import HomeActivity from "../components/wiki/HomeActivity";
import { getPublicRecentActivity } from "../lib/publicWikiRead";

type Activity = {
  id: string;
  source_title: string;
  summary: string | null;
  display_name: string | null;
  status: string;
  created_at: string;
};

async function getRecentActivity(): Promise<Activity[]> {
  try {
    return await getPublicRecentActivity();
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function Home() {
  const activity = await getRecentActivity();

  return (
    <>
      <SiteHeader />
      <main className="homePage">
        <div className="homeGrid">
          <section className="homeCard" aria-labelledby="recent-edits-title">
            <header className="homeCardHeader">
              <h2 id="recent-edits-title">Recent edits</h2>
              <span className="liveBadge">LIVE</span>
            </header>
            <HomeActivity initialItems={activity} />
          </section>

          <section className="homeCard" aria-labelledby="discussion-title">
            <header className="homeCardHeader">
              <h2 id="discussion-title">Discussions</h2>
            </header>
            <div className="discussionSoon">Coming soon.</div>
          </section>
        </div>
      </main>
    </>
  );
}
