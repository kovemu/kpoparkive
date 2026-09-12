import SiteHeader from "../../components/wiki/SiteHeader";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type SearchRow = {
  source_title: string;
  translated_title: string | null;
  root_title: string | null;
  content_language: string | null;
  content_status: string | null;
  published_revision_no: number | null;
  content_wikitext: string | null;
};


function normalizeSearchKey(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function hasHangul(value: string) {
  return /[가-힣]/.test(value);
}

function englishDisplayTitle(row: SearchRow) {
  const title = String(row.translated_title || "").normalize("NFKC").trim();
  if (!title || hasHangul(title)) return "";
  return title;
}

function stripNamuMarkup(value: string) {
  return String(value || "")
    .replace(/\[include\([^\]]*\)\]/gi, " ")
    .replace(/\[\[분류:[^\]]+\]\]/gi, " ")
    .replace(/\[\[(?:파일|File):[^\]]+\]\]/gi, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[youtube\([^\]]*\)\]/gi, " ")
    .replace(/\[(?:목차|tableofcontents)\]/gi, " ")
    .replace(/\[br\]/gi, " ")
    .replace(/\{\{\{[#!+\-0-9a-zA-Z_="':;,.%()\s-]*\n?/g, " ")
    .replace(/\}\}\}/g, " ")
    .replace(/^={2,6}\s*(.*?)\s*={2,6}$/gm, "$1. ")
    .replace(/\|\|/g, " ")
    .replace(/'''|''/g, "")
    .replace(/\[\*[^\]]*\]/g, " ")
    .replace(/[#*]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function searchSnippet(row: SearchRow) {
  if (row.content_language !== "en" || !row.content_wikitext) return "";
  const text = stripNamuMarkup(row.content_wikitext);
  if (!text) return "";
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
}

function searchRank(row: SearchRow, query: string) {
  const q = normalizeSearchKey(query);
  const title = normalizeSearchKey(englishDisplayTitle(row));
  const source = normalizeSearchKey(row.source_title);
  const root = normalizeSearchKey(row.root_title || "");

  if (!q || !title) return 999;
  if (title === q) return 0;
  if (source === q) return 1;
  if (title.startsWith(q + " ") || title.startsWith(q + "(")) return 2;
  if (title.startsWith(q)) return 3;
  if (root === q && title !== root) return 4;
  if (title.includes(q)) return 5;
  if (source.includes(q)) return 6;
  if (root.includes(q)) return 7;
  return 50;
}

async function searchDocuments(query: string): Promise<SearchRow[]> {
  if (!SERVICE_ROLE_KEY || !query) return [];
  const pattern = `*${query.replace(/[*,]/g, " ").trim()}*`;
  if (pattern === "**") return [];

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/source_documents?source=eq.namu_mirror&or=(source_title.ilike.${encodeURIComponent(pattern)},translated_title.ilike.${encodeURIComponent(pattern)})&select=source_title,translated_title,root_title,content_language,content_status,published_revision_no,content_wikitext&limit=100`,
      {
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        },
        cache: "no-store",
      },
    );
    if (!response.ok) return [];
    const rows = await response.json() as SearchRow[];
    return rows
      .filter((row) => Boolean(englishDisplayTitle(row)))
      .sort((a, b) => {
        const rankDiff = searchRank(a, query) - searchRank(b, query);
        if (rankDiff) return rankDiff;
        const aPublished = Number(a.published_revision_no || 0) > 0 ? 0 : 1;
        const bPublished = Number(b.published_revision_no || 0) > 0 ? 0 : 1;
        if (aPublished !== bPublished) return aPublished - bPublished;
        return englishDisplayTitle(a).localeCompare(englishDisplayTitle(b), "en");
      })
      .slice(0, 50);
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
                const primaryTitle = englishDisplayTitle(row);
                const snippet = searchSnippet(row);

                return (
                  <a className="searchResult" key={row.source_title} href={`/w/${encoded}`}>
                    <span className="searchResultTitle">{primaryTitle}</span>
                    {snippet ? (
                      <span className="searchResultSnippet">{snippet}</span>
                    ) : null}
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
