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

  const root = String(row.root_title || "").normalize("NFKC").trim();
  const isTopLevelRelatedDocument =
    Boolean(root) &&
    root !== row.source_title &&
    !row.source_title.includes("/") &&
    normalizeSearchKey(title) !== normalizeSearchKey(root);

  if (
    isTopLevelRelatedDocument &&
    !normalizeSearchKey(title).includes(normalizeSearchKey(root))
  ) {
    return `${title} (${root})`;
  }

  return title;
}

function decodeWikiLinks(value: string) {
  return String(value || "")
    .replace(/\[\[(?:파일|File):[^\]]+\]\]/gi, " ")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[br\]/gi, " ")
    .replace(/'''|''/g, "")
    .replace(/\[\*[^\]]*\]/g, " ")
    .replace(/[가-힣]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function overviewBody(value: string) {
  const source = String(value || "").replace(/\r\n?/g, "\n");
  const overview = source.match(/^==\s*Overview\s*==\s*$/im);
  if (!overview || overview.index == null) return source;

  const afterHeading = overview.index + overview[0].length;
  const rest = source.slice(afterHeading);
  const nextHeading = rest.search(/^==\s*[^=].*?\s*==\s*$/m);
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

function searchSnippet(row: SearchRow) {
  if (row.content_language !== "en" || !row.content_wikitext) return "";

  const lines = overviewBody(row.content_wikitext).split("\n");
  const candidates: string[] = [];
  let blockDepth = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const opens = (line.match(/\{\{\{/g) || []).length;
    const closes = (line.match(/\}\}\}/g) || []).length;
    const insideBlock = blockDepth > 0 || opens > 0;

    blockDepth = Math.max(0, blockDepth + opens - closes);

    if (!line || insideBlock) continue;
    if (
      /^\|\|/.test(line) ||
      /^={2,6}/.test(line) ||
      /^\s*[*-]\s+/.test(line) ||
      /^\[(?:include|youtube|목차|clearfix)/i.test(line) ||
      /^##@/.test(line)
    ) {
      continue;
    }

    const text = decodeWikiLinks(line)
      .replace(/\[(?:age|dday)\([^\]]+\)\]/gi, " ")
      .replace(/\[[^\]]+\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (text.length < 45) continue;
    if (!/[A-Za-z]/.test(text)) continue;
    if (!/[.!?]/.test(text)) continue;

    candidates.push(text);
    if (candidates.join(" ").length >= 220) break;
  }

  const text = candidates.join(" ").trim();
  if (!text) return "";
  return text.length > 220 ? `${text.slice(0, 217).trimEnd()}…` : text;
}

function searchRank(row: SearchRow, query: string) {
  const q = normalizeSearchKey(query);
  const translated = normalizeSearchKey(String(row.translated_title || ""));
  const displayTitle = normalizeSearchKey(englishDisplayTitle(row));
  const root = normalizeSearchKey(row.root_title || "");
  const source = normalizeSearchKey(row.source_title);
  const body = normalizeSearchKey(row.content_wikitext || "");
  const isRootDocument =
    Boolean(row.root_title) &&
    row.source_title === row.root_title;

  if (!q || !translated) return 999;

  // Representative documents always win. "rescen" must put RESCENE first,
  // while "liv" must put Liv (RESCENE) ahead of broader RESCENE matches.
  if (translated === q || displayTitle === q) return 0;
  if (isRootDocument && translated.startsWith(q)) return 1;
  if (translated.startsWith(q) || displayTitle.startsWith(q)) return 2;
  if (isRootDocument && root.startsWith(q)) return 3;
  if (root.startsWith(q)) return 4;
  if (translated.includes(q) || displayTitle.includes(q)) return 5;
  if (root.includes(q)) return 6;

  // Canonical Korean titles may still be used as hidden aliases, but never as
  // display text. This lets a Korean query find the English result.
  if (source.includes(q)) return 7;

  // Full English body match is intentionally last.
  if (body.includes(q)) return 8;
  return 50;
}

async function fetchSearchRows(path: string): Promise<SearchRow[]> {
  if (!SERVICE_ROLE_KEY) return [];
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    },
    cache: "no-store",
  });
  if (!response.ok) return [];
  return response.json() as Promise<SearchRow[]>;
}

async function searchDocuments(query: string): Promise<SearchRow[]> {
  if (!SERVICE_ROLE_KEY || !query) return [];

  const clean = query.replace(/[*,]/g, " ").replace(/\s+/g, " ").trim();
  if (!clean) return [];

  const pattern = `*${clean}*`;
  const encodedPattern = encodeURIComponent(pattern);
  const select =
    "source_title,translated_title,root_title,content_language,content_status," +
    "published_revision_no,content_wikitext";

  // Filter to English-ready documents in PostgREST BEFORE applying result
  // limits. root_title=RESCENE can match hundreds of captured Korean support
  // documents, which previously filled limit=100 and pushed the actual RESCENE
  // page and members out of the candidate set.
  const englishReady =
    "source=eq.namu_mirror" +
    "&content_language=eq.en" +
    "&content_wikitext=not.is.null" +
    "&translated_title=not.is.null";

  try {
    const [titleRows, rootRows] = await Promise.all([
      // Title/canonical matches are the high-precision lane. These must never
      // compete for the same SQL limit with broad root/group matches.
      fetchSearchRows(
        `source_documents?${englishReady}` +
          `&or=(translated_title.ilike.${encodedPattern},source_title.ilike.${encodedPattern})` +
          `&select=${select}&limit=60`,
      ),
      // Group/root expansion is a secondary discovery lane.
      fetchSearchRows(
        `source_documents?${englishReady}` +
          `&root_title=ilike.${encodedPattern}` +
          `&select=${select}&limit=60`,
      ),
    ]);

    // Body recall is last and intentionally bounded.
    const bodyRows = clean.length >= 3
      ? await fetchSearchRows(
          `source_documents?${englishReady}` +
            `&content_wikitext=ilike.${encodedPattern}` +
            `&select=${select}&limit=40`,
        )
      : [];

    const merged = new Map<string, SearchRow>();
    for (const row of [...titleRows, ...rootRows, ...bodyRows]) {
      if (!merged.has(row.source_title)) merged.set(row.source_title, row);
    }

    return [...merged.values()]
      .filter((row) =>
        Boolean(englishDisplayTitle(row)) &&
        !/^(?:틀|Template|파일|File):/i.test(row.source_title)
      )
      .sort((a, b) => {
        const rankDiff = searchRank(a, query) - searchRank(b, query);
        if (rankDiff) return rankDiff;

        const aPublished = Number(a.published_revision_no || 0) > 0 ? 0 : 1;
        const bPublished = Number(b.published_revision_no || 0) > 0 ? 0 : 1;
        if (aPublished !== bPublished) return aPublished - bPublished;

        const aTitle = englishDisplayTitle(a);
        const bTitle = englishDisplayTitle(b);
        if (aTitle.length !== bTitle.length) return aTitle.length - bTitle.length;
        return aTitle.localeCompare(bTitle, "en");
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
