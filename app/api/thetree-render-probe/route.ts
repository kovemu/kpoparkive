import { NextResponse } from "next/server";
import {
  currentExactSourceSnapshot,
  hashHtml,
  renderExactNamuPreview,
} from "../../../lib/thetreeExactPreview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
// Runtime verification endpoint for exact editor preview integration.

export async function GET(request: Request) {
  try {
    const title = new URL(request.url).searchParams.get("title")?.normalize("NFKC").trim() || "";
    if (!title) return NextResponse.json({ ok: false, error: "title is required" }, { status: 400 });

    const snapshot = await currentExactSourceSnapshot(title);
    if (!snapshot?.source) return NextResponse.json({ ok: false, error: "source not found" }, { status: 404 });

    const rendered = await renderExactNamuPreview(title, snapshot.source);
    const stored = snapshot.exactHtml || "";

    return NextResponse.json({
      ok: true,
      title,
      render: {
        htmlChars: rendered.html.length,
        htmlHash: hashHtml(rendered.html),
        renderMs: rendered.renderMs,
        hasError: rendered.hasError,
        errorCode: rendered.errorCode,
        links: rendered.links,
        files: rendered.files,
        headings: rendered.headings,
      },
      stored: {
        htmlChars: stored.length,
        htmlHash: stored ? hashHtml(stored) : null,
      },
      exactByteMatch: Boolean(stored) && stored === rendered.html,
    }, {
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null,
    }, { status: 500 });
  }
}
