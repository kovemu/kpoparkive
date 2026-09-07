import { NextResponse } from "next/server";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim();
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;

function headers() {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function db(path: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: headers(),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

export async function GET(request: Request) {
  if (!ADMIN_KEY || request.headers.get("x-admin-key") !== ADMIN_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const slug = new URL(request.url).searchParams.get("slug")?.trim();
    if (!slug) return NextResponse.json({ error: "slug is required" }, { status: 400 });

    const documents = await db(
      `documents?slug=eq.${encodeURIComponent(slug)}&select=id,slug,title,summary,accent_color,status,updated_at&limit=1`,
    ) as { id: string; slug: string; title: string; summary: string | null; accent_color: string | null; status: string; updated_at: string }[];

    const document = documents[0];
    if (!document) return NextResponse.json({ error: "Draft not found" }, { status: 404 });

    const sections = await db(
      `document_sections?document_id=eq.${document.id}&select=id,section_key,heading,heading_level,sort_order,content&order=sort_order.asc`,
    );

    const media = await db(
      `media?document_id=eq.${document.id}&select=id,bucket,storage_path,role,caption,alt_text,source_credit,width,height,mime_type,sort_order&order=sort_order.asc,created_at.asc`,
    );

    return NextResponse.json({ ok: true, document: { ...document, sections }, media });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown preview error" }, { status: 500 });
  }
}
