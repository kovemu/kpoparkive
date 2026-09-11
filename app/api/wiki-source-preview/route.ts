import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { renderExactNamuPreview } from "../../../lib/thetreeExactPreview";
import { sanitizeExactPreviewHtml } from "../../../lib/thetreePreviewSanitize";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_SOURCE_CHARS = 300_000;
const WINDOW_MS = 60_000;
const MAX_RENDERS_PER_WINDOW = 20;

const rate = new Map<string, { startedAt: number; count: number }>();

function clientKey(request: Request) {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const ua = request.headers.get("user-agent") || "unknown";
  return createHash("sha256").update(`${ip}|${ua}`).digest("hex");
}

function checkRate(request: Request) {
  const key = clientKey(request);
  const now = Date.now();
  const current = rate.get(key);
  if (!current || now - current.startedAt >= WINDOW_MS) {
    rate.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= MAX_RENDERS_PER_WINDOW) {
    throw Object.assign(new Error("Preview refresh limit reached. Wait a moment and try again."), { status: 429 });
  }
  current.count += 1;

  if (rate.size > 500) {
    for (const [entryKey, entry] of rate) {
      if (now - entry.startedAt >= WINDOW_MS * 2) rate.delete(entryKey);
    }
  }
}

function json(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

export async function POST(request: Request) {
  try {
    checkRate(request);
    const body = await request.json() as { title?: string; source?: string };
    const title = String(body.title || "").normalize("NFKC").trim().replace(/^문서:/, "").trim();
    const source = typeof body.source === "string" ? body.source : "";

    if (!title) return json({ ok: false, error: "title is required" }, 400);
    if (!source.trim()) return json({ ok: false, error: "source is empty" }, 400);
    if (source.length > MAX_SOURCE_CHARS) return json({ ok: false, error: "source is too large for preview" }, 413);
    if (source.includes("\u0000")) return json({ ok: false, error: "source contains an unsupported null character" }, 400);

    const started = performance.now();
    const rendered = await renderExactNamuPreview(title, source);
    const html = sanitizeExactPreviewHtml(rendered.html, title);
    const sourceHash = createHash("sha256").update(source).digest("hex");

    return json({
      ok: true,
      html,
      sourceHash,
      renderMs: Math.round(performance.now() - started),
      engineRenderMs: rendered.renderMs,
      hasError: rendered.hasError,
      errorCode: rendered.errorCode,
      stats: {
        links: rendered.links,
        files: rendered.files,
        headings: rendered.headings,
      },
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    return json({
      ok: false,
      error: error instanceof Error ? error.message : "Exact preview render failed",
    }, status);
  }
}
