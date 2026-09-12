const SUPABASE_URL = (
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://hukrrzhltiyirtkxmotj.supabase.co"
).trim().replace(/\/$/, "");

// This is a public Supabase publishable key, not a secret. Production public wiki
// reads are restricted by SECURITY DEFINER RPCs that expose published rows only.
const SUPABASE_PUBLISHABLE_KEY = (
  process.env.SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  "sb_publishable_WPR5wzzAKuEaxkiPI7lUjQ_lHzNYq3l"
).trim();

export type PublicWikiAsset = {
  source_ref: string;
  label: string | null;
  status: string;
  resolved_url: string | null;
  storage_path: string | null;
  metadata: Record<string, unknown> | null;
};

export type PublicWikiDocument = {
  id: string;
  source_title: string;
  root_title: string;
  translated_title: string | null;
  published_revision_no: number;
  published_namumark_html: string | null;
  published_content_wikitext: string | null;
  published_content_language: string | null;
};

export type PublicWikiPagePayload = {
  document: PublicWikiDocument;
  assets: PublicWikiAsset[];
};

export type PublicWikiMeta = {
  source_title: string;
  translated_title: string | null;
  published_revision_no: number;
};

export type PublicWikiIndexRow = {
  source_title: string;
  translated_title: string | null;
  published_at: string | null;
  published_revision_no: number;
};

export type PublicWikiSearchRow = {
  source_title: string;
  translated_title: string | null;
  root_title: string | null;
  content_language: string | null;
  published_revision_no: number | null;
  content_wikitext: string | null;
};

export type PublicWikiActivity = {
  id: string;
  source_title: string;
  summary: string | null;
  display_name: string | null;
  status: string;
  created_at: string;
};

async function rpc<T>(name: string, body: Record<string, unknown>): Promise<T | null> {
  if (!SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Supabase publishable key is not configured");
  }

  const delays = [250, 700, 1500];
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_PUBLISHABLE_KEY,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });

      const text = await response.text();
      if (response.ok) {
        if (!text || text === "null") return null;
        const value = JSON.parse(text) as T | T[] | null;
        if (Array.isArray(value)) return (value[0] ?? null) as T | null;
        return value;
      }

      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;

      const error = new Error(`${response.status} ${text}`);
      lastError = error;
      if (!retryable || attempt >= delays.length) throw error;
    } catch (error) {
      const current = error instanceof Error ? error : new Error(String(error));
      lastError = current;
      if (attempt >= delays.length) throw current;
      if (!/(?:fetch failed|network|ECONN|ETIMEDOUT|502|503|504|429|408)/i.test(current.message)) {
        throw current;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
  }

  throw lastError || new Error("Supabase public RPC request failed");
}

async function rpcList<T>(name: string, body: Record<string, unknown> = {}): Promise<T[]> {
  if (!SUPABASE_PUBLISHABLE_KEY) {
    throw new Error("Supabase publishable key is not configured");
  }

  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${text}`);
  if (!text) return [];
  const value = JSON.parse(text);
  return Array.isArray(value) ? value as T[] : [];
}

export async function getPublicWikiPage(sourceTitle: string) {
  return rpc<PublicWikiPagePayload>("get_public_wiki_page", {
    p_source_title: sourceTitle.normalize("NFKC").trim(),
  });
}

export async function getPublicWikiMeta(sourceTitle: string) {
  return rpc<PublicWikiMeta>("get_public_wiki_meta", {
    p_source_title: sourceTitle.normalize("NFKC").trim(),
  });
}

export async function getPublicWikiIndex() {
  return rpcList<PublicWikiIndexRow>("get_public_wiki_index");
}

export async function searchPublicWiki(query: string) {
  const clean = query.normalize("NFKC").trim().slice(0, 120);
  if (!clean) return [];
  return rpcList<PublicWikiSearchRow>("search_public_wiki", { p_query: clean });
}

export async function getPublicRecentActivity() {
  return rpcList<PublicWikiActivity>("get_public_recent_activity");
}
