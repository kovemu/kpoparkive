export type WikiBlock =
  | { type: "paragraph"; text: string }
  | { type: "members"; items: { name: string; birthday: string; nationality: string }[] }
  | { type: "related"; label: string; target: string }
  | { type: "quote"; text: string }
  | { type: "callout"; paragraphs: string[] }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "gallery-placeholder"; labels: string[] };

export type WikiSection = {
  id: string;
  section_key: string;
  heading: string;
  heading_level: number;
  sort_order: number;
  content: WikiBlock[];
};

export type WikiDocument = {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  accent_color: string | null;
  updated_at: string;
  sections: WikiSection[];
};

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://hukrrzhltiyirtkxmotj.supabase.co";
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  "sb_publishable_WPR5wzzAKuEaxkiPI7lUjQ_lHzNYq3l";

async function supabaseGet<T>(path: string): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_KEY,
    },
    next: { revalidate: 300 },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Supabase request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

export async function getWikiDocument(slug: string): Promise<WikiDocument | null> {
  const documents = await supabaseGet<Omit<WikiDocument, "sections">[]>(
    `documents?slug=eq.${encodeURIComponent(slug)}&status=eq.published&select=id,slug,title,summary,accent_color,updated_at&limit=1`,
  );

  const document = documents[0];
  if (!document) return null;

  const sections = await supabaseGet<WikiSection[]>(
    `document_sections?document_id=eq.${document.id}&select=id,section_key,heading,heading_level,sort_order,content&order=sort_order.asc`,
  );

  return { ...document, sections };
}

export function getStoragePublicUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/wiki-media/${path}`;
}
