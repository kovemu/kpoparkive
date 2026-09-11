import SiteHeader from "../../components/wiki/SiteHeader";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type SearchRow = {
  source_title: string;
  translated_title: string | null;
  content_language: string | null;
  content_status: string | null;
};

async function searchDocuments(query: string): Promise<SearchRow[]> {
  if (!SERVICE_ROLE_KEY || !query) return [];
  const pattern = `*${query.replace(/[*,]/g, " ").trim()}*`;
  if (pattern === "**") return [];

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/source_documents?source=eq.namu_mirror&or=(source_title.ilike.${encodeURIComponent(pattern)},translated_title.ilike.${encodeURIComponent(pattern)})&select=source_title,translated_title,content_language,content_status&order=source_title.asc&limit=50`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return [];
    return response.json() as Promise<SearchRow[]>;
  } catch {
    return [];
  }
}

export const dynamic = "force-dynamic";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const params = await searchParams;
  const query = String(params.q || "").normalize("NFKC").trim().slice(0, 120);
  const results = await searchDocuments(query);

  return (
    <>
      <SiteHeader />
      <main className="searchPage">
        <h1>Search</h1>

        <form className="searchFormLarge" action="/search" method="get">
          <input
            name="q"
            type="search"
            defaultValue={query}
            placeholder="Search groups, artists, albums..."
            autoFocus
          />
          <button type="submit">Search</button>
        </form>

        {query ? (
          results.length ? (
            <div className="searchResults">
              {results.map((row) => {
                const encoded = row.source_title.split("/").map(encodeURIComponent).join("/");
                return (
                  <a className="searchResult" key={row.source_title} href={`/w/${encoded}`}>
                    {row.content_status === "published" && row.content_language === "en" && row.translated_title
                      ? row.translated_title
                      : row.source_title}
                  </a>
                );
              })}
            </div>
          ) : (
            <div className="homeEmpty">No results for “{query}”.</div>
          )
        ) : (
          <div className="homeEmpty">Type a K-pop group, artist, album, or topic.</div>
        )}
      </main>
    </>
  );
}
