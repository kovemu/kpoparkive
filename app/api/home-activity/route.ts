import { NextResponse } from "next/server";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

type ActivityRow = {
  id: string;
  source_title: string;
  summary: string | null;
  display_name: string | null;
  status: string;
  created_at: string;
};

export async function GET() {
  if (!SERVICE_ROLE_KEY) {
    return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  }

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

  if (!response.ok) {
    return NextResponse.json({ items: [] }, { headers: { "Cache-Control": "no-store" } });
  }

  const items = await response.json() as ActivityRow[];
  return NextResponse.json(
    { items },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
