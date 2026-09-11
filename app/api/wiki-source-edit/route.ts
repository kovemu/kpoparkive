import { createHash } from "node:crypto";
import { NextResponse } from "next/server";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RATE_SALT = process.env.KPOPARKIVE_ADMIN_KEY || SERVICE_ROLE_KEY || "kpoparkive-public-source-edit";
const MAX_SOURCE_CHARS = 1_500_000;
const MAX_PROPOSALS_PER_HOUR = 6;

type SourceDocument = {
  id: string;
  source_title: string;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_status: string;
  content_revision_no: number;
  source_format: string | null;
  source_fidelity_meta: Record<string, unknown> | null;
};

function headers(extra?: Record<string, string>) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: headers(init?.headers as Record<string, string> | undefined),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function normalizeTitle(value: string | null | undefined) {
  return (value || "").normalize("NFKC").trim().replace(/^문서:/, "").trim();
}

async function findDocument(title: string) {
  const rows = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      "&select=id,source_title,source_wikitext,content_wikitext,content_status,content_revision_no,source_format,source_fidelity_meta&limit=1",
  );
  return rows[0] || null;
}

function publicSource(document: SourceDocument) {
  const synthetic = document.source_format === "namumark-synthetic-dom";
  const verified = String(document.source_fidelity_meta?.stage || "") === "verified";
  if (synthetic && !verified) return "";
  if (document.content_status === "published" && document.content_wikitext) return document.content_wikitext;
  return document.source_wikitext || "";
}

function publicRevisionNo(document: SourceDocument) {
  return document.content_status === "published" ? Number(document.content_revision_no || 0) : 0;
}

function sourceHash(source: string) {
  return createHash("sha256").update(source).digest("hex");
}

function submitterHash(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const agent = request.headers.get("user-agent") || "unknown";
  return createHash("sha256").update(`${forwarded}|${agent}|${RATE_SALT}`).digest("hex");
}

async function enforceRateLimit(hash: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const rows = await db<Array<{ id: string }>>(
    `source_edit_proposals?submitter_hash=eq.${encodeURIComponent(hash)}&created_at=gte.${encodeURIComponent(since)}&select=id&limit=${MAX_PROPOSALS_PER_HOUR + 1}`,
  );
  if (rows.length >= MAX_PROPOSALS_PER_HOUR) {
    throw Object.assign(new Error("Too many edit suggestions. Please try again later."), { status: 429 });
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const title = normalizeTitle(url.searchParams.get("title"));
    if (!title) return json({ error: "title is required" }, 400);

    const document = await findDocument(title);
    if (!document) return json({ error: "Document not found" }, 404);

    const source = publicSource(document);
    if (!source) return json({ error: "Public source is unavailable" }, 404);
    if (source.length > MAX_SOURCE_CHARS) return json({ error: "Document is too large for public source editing" }, 413);

    return json({
      ok: true,
      document: {
        title: document.source_title,
        publicRevisionNo: publicRevisionNo(document),
        sourceMode: document.content_status === "published" ? "published" : "captured",
        sourceHash: sourceHash(source),
        source,
      },
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    return json({ error: error instanceof Error ? error.message : "Could not load public source editor" }, status);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      title?: string;
      content?: string;
      baseRevisionNo?: number;
      baseSourceHash?: string;
      summary?: string;
      displayName?: string;
      website?: string;
    };

    if (body.website) return json({ ok: true, submitted: true });

    const title = normalizeTitle(body.title);
    if (!title) return json({ error: "title is required" }, 400);

    const document = await findDocument(title);
    if (!document) return json({ error: "Document not found" }, 404);

    const revision = publicRevisionNo(document);
    if (Number(body.baseRevisionNo || 0) !== revision) {
      return json({ error: "This page changed while you were editing. Reload and try again." }, 409);
    }

    const original = publicSource(document);
    if (!original) return json({ error: "Public source is unavailable" }, 404);
    if (String(body.baseSourceHash || "") !== sourceHash(original)) {
      return json({ error: "The underlying source changed while you were editing. Reload and try again." }, 409);
    }

    const proposed = typeof body.content === "string" ? body.content : "";
    if (!proposed.trim()) return json({ error: "Content cannot be empty" }, 400);
    if (proposed.includes("\u0000")) return json({ error: "Content contains an unsupported null character" }, 400);
    if (proposed.length > MAX_SOURCE_CHARS) return json({ error: "Edited document is too large" }, 413);
    if (proposed === original) return json({ error: "No changes were made" }, 400);

    const hash = submitterHash(request);
    await enforceRateLimit(hash);

    const summary = String(body.summary || "").trim().slice(0, 500) || "Public full-source edit";
    const displayName = String(body.displayName || "").trim().slice(0, 80) || null;

    const inserted = await db<Array<{ id: string; created_at: string }>>("source_edit_proposals", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        source_document_id: document.id,
        source_title: document.source_title,
        section_key: "document:source",
        section_heading: "Full page source",
        block_index: -4,
        base_revision_no: revision,
        original_wikitext: original,
        original_plain_text: `Full-source edit ${document.source_title}`,
        proposed_plain_text: `Full source: ${original.length.toLocaleString()} → ${proposed.length.toLocaleString()} chars`,
        proposed_wikitext: proposed,
        summary,
        display_name: displayName,
        submitter_hash: hash,
        status: "pending",
      }),
    });

    return json({
      ok: true,
      submitted: true,
      proposalId: inserted[0]?.id || null,
      baseRevisionNo: revision,
      proposedSourceHash: sourceHash(proposed),
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error
      ? Number((error as { status?: number }).status) || 500
      : 500;
    return json({ error: error instanceof Error ? error.message : "Could not submit source edit" }, status);
  }
}
