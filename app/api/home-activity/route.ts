import { NextResponse } from "next/server";
import { getPublicRecentActivity } from "../../../lib/publicWikiRead";

export async function GET() {
  try {
    const items = await getPublicRecentActivity();
    return NextResponse.json(
      { items },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  } catch {
    return NextResponse.json(
      { items: [] },
      { headers: { "Cache-Control": "no-store, max-age=0" } },
    );
  }
}
