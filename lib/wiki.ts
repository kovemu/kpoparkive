export type RichWikiCell = {
  text: string;
  rowspan?: number;
  colspan?: number;
  header?: boolean;
  background?: string;
  color?: string;
  align?: "left" | "center" | "right";
  image_url?: string;
  image_alt?: string;
  link_url?: string;
  link_label?: string;
};

export type WikiBlock =
  | { type: "paragraph"; text: string }
  | { type: "members"; items: { name: string; birthday: string; nationality: string }[] }
  | { type: "related"; label: string; target: string }
  | { type: "internal-link"; target: string; label: string; slug?: string }
  | { type: "external-link"; url: string; label: string }
  | { type: "image"; source_ref: string; url?: string; storage_path?: string; alt?: string; caption?: string; role?: string }
  | { type: "video"; provider: string; url: string; video_id?: string; label?: string }
  | { type: "quote"; text: string }
  | { type: "callout"; paragraphs: string[] }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "rich-table"; rows: RichWikiCell[][] }
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

export type WikiMedia = {
  id: string;
  document_id: string | null;
  bucket: string;
  storage_path: string;
  role: string | null;
  caption: string | null;
  alt_text: string | null;
  source_credit: string | null;
  width: number | null;
  height: number | null;
  mime_type: string | null;
  sort_order: number;
};

const DEFAULT_SUPABASE_URL = "https://hukrrzhltiyirtkxmotj.supabase.co";
const DEFAULT_SUPABASE_KEY = "sb_publishable_WPR5wzzAKuEaxkiPI7lUjQ_lHzNYq3l";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL;
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim() || DEFAULT_SUPABASE_KEY;

async function supabaseGet<T>(path: string): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: SUPABASE_KEY }, next: { revalidate: 300 } });
  if (!response.ok) throw new Error(`Supabase request failed: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

export async function getWikiDocument(slug: string): Promise<WikiDocument | null> {
  const documents = await supabaseGet<Omit<WikiDocument, "sections">[]>(`documents?slug=eq.${encodeURIComponent(slug)}&status=eq.published&select=id,slug,title,summary,accent_color,updated_at&limit=1`);
  const document = documents[0];
  if (!document) return null;
  const sections = await supabaseGet<WikiSection[]>(`document_sections?document_id=eq.${document.id}&select=id,section_key,heading,heading_level,sort_order,content&order=sort_order.asc`);
  return { ...document, sections };
}

export async function getWikiMedia(documentId: string): Promise<WikiMedia[]> {
  return supabaseGet<WikiMedia[]>(`media?document_id=eq.${documentId}&select=id,document_id,bucket,storage_path,role,caption,alt_text,source_credit,width,height,mime_type,sort_order&order=sort_order.asc,created_at.asc`);
}

export function getStoragePublicUrl(path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/wiki-media/${path}`;
}
