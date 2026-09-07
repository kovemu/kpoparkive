import { NextRequest, NextResponse } from "next/server";
import { fetchNamuDirectRaw } from "../../../lib/namuDirectRaw";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const title = request.nextUrl.searchParams.get("title")?.trim();
  if (!title) return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });

  const result = await fetchNamuDirectRaw(title);
  return NextResponse.json({
    ok: result.ok,
    status: result.status,
    httpStatus: result.httpStatus ?? null,
    sourceUrl: result.sourceUrl,
    contentType: result.contentType ?? null,
    rawLength: result.raw?.length ?? 0,
    rawPreview: result.raw?.slice(0, 1200) ?? null,
    reason: result.reason ?? null,
  }, {
    headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow, noarchive" },
  });
}
