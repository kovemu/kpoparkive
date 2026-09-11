import SiteHeader from "../components/wiki/SiteHeader";
import HomeActivity from "../components/wiki/HomeActivity";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type Activity = {
  id: string;
  source_title: string;
  summary: string | null;
  display_name: string | null;
  status: string;
  created_at: string;
};

async function getRecentActivity(): Promise<Activity[]> {
  if (!SERVICE_ROLE_KEY) return [];

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/source_edit_proposals?select=id,source_title,summary,display_name,status,created_at&order=created_at.desc&limit=30`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return [];
    return response.json() as Promise<Activity[]>;
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
        <div className="homeIntro">
          <h1>Kpoparkive</h1>
          <p>A community-edited K-pop wiki.</p>
        </div>

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
