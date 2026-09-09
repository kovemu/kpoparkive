import { NextResponse } from "next/server";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;
const MAX_SOURCE_CHARS = 2_000_000;

type SourceDocument = {
  id: string;
  source_title: string;
  root_title: string | null;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_language: string;
  content_status: string;
  content_revision_no: number;
  content_updated_at: string | null;
  content_updated_by: string | null;
  source_namumark_rendered_at: string | null;
  content_namumark_rendered_at: string | null;
};

function adminAuthorized(request: Request) {
  return Boolean(ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY);
}

function supabaseHeaders(extra?: Record<string, string>) {
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
    headers: supabaseHeaders(init?.headers as Record<string, string> | undefined),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function findDocument(title: string) {
  const rows = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      `&select=id,source_title,root_title,source_wikitext,content_wikitext,content_language,content_status,content_revision_no,content_updated_at,content_updated_by,source_namumark_rendered_at,content_namumark_rendered_at&limit=1`,
  );
  return rows[0] || null;
}

async function saveRevision(documentId: string, content: string, language: string, summary: string | null) {
  const rows = await db<{ revision_no: number; updated_at: string }[]>("rpc/save_source_document_revision", {
    method: "POST",
    body: JSON.stringify({
      p_document_id: documentId,
      p_content_wikitext: content,
      p_content_language: language || "ko",
      p_summary: summary,
      p_editor_label: "admin",
    }),
  });
  return rows[0];
}

function errorResponse(error: unknown, status = 500) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : "Unknown wiki editor error" },
    { status, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" } },
  );
}

export async function GET(request: Request) {
  if (!adminAuthorized(request)) return errorResponse(new Error("Unauthorized"), 401);

  try {
    const url = new URL(request.url);
    const title = url.searchParams.get("title")?.normalize("NFKC").trim();
    if (!title) return errorResponse(new Error("title is required"), 400);

    const document = await findDocument(title);
    if (!document) return errorResponse(new Error("Document not found"), 404);

    const revisionParam = url.searchParams.get("revision");
    if (revisionParam) {
      const revisionNo = Number(revisionParam);
      if (!Number.isInteger(revisionNo) || revisionNo < 1) return errorResponse(new Error("Invalid revision"), 400);
      const revisions = await db<{
        revision_no: number;
        content_wikitext: string;
        content_language: string;
        summary: string | null;
        editor_label: string | null;
        created_at: string;
      }[]>(
        `source_document_revisions?source_document_id=eq.${document.id}&revision_no=eq.${revisionNo}` +
          `&select=revision_no,content_wikitext,content_language,summary,editor_label,created_at&limit=1`,
      );
      if (!revisions[0]) return errorResponse(new Error("Revision not found"), 404);
      return NextResponse.json({ ok: true, revision: revisions[0] }, { headers: { "Cache-Control": "no-store" } });
    }

    const revisions = await db<{
      revision_no: number;
      content_language: string;
      summary: string | null;
      editor_label: string | null;
      created_at: string;
    }[]>(
      `source_document_revisions?source_document_id=eq.${document.id}` +
        `&select=revision_no,content_language,summary,editor_label,created_at&order=revision_no.desc&limit=50`,
    );

    return NextResponse.json(
      {
        ok: true,
        document: {
          ...document,
          effective_wikitext: document.content_wikitext ?? document.source_wikitext ?? "",
          has_content_draft: document.content_wikitext !== null,
          needs_render: Boolean(document.content_wikitext && !document.content_namumark_rendered_at),
        },
        revisions,
      },
      { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  if (!adminAuthorized(request)) return errorResponse(new Error("Unauthorized"), 401);

  try {
    const body = await request.json() as {
      action?: string;
      title?: string;
      content?: string;
      language?: string;
      summary?: string;
      revisionNo?: number;
    };

    const title = body.title?.normalize("NFKC").trim();
    if (!title) return errorResponse(new Error("title is required"), 400);
    const document = await findDocument(title);
    if (!document) return errorResponse(new Error("Document not found"), 404);

    if (body.action === "save") {
      const content = typeof body.content === "string" ? body.content : "";
      if (!content.trim()) return errorResponse(new Error("Content cannot be empty"), 400);
      if (content.length > MAX_SOURCE_CHARS) return errorResponse(new Error("Content is too large"), 413);
      const saved = await saveRevision(document.id, content, body.language || document.content_language || "ko", body.summary?.trim() || null);
      return NextResponse.json({ ok: true, action: "save", ...saved }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "rollback") {
      const revisionNo = Number(body.revisionNo);
      if (!Number.isInteger(revisionNo) || revisionNo < 1) return errorResponse(new Error("Invalid revision"), 400);
      const revisions = await db<{
        revision_no: number;
        content_wikitext: string;
        content_language: string;
      }[]>(
        `source_document_revisions?source_document_id=eq.${document.id}&revision_no=eq.${revisionNo}` +
          `&select=revision_no,content_wikitext,content_language&limit=1`,
      );
      const target = revisions[0];
      if (!target) return errorResponse(new Error("Revision not found"), 404);
      const saved = await saveRevision(
        document.id,
        target.content_wikitext,
        target.content_language,
        `Rollback to r${revisionNo}`,
      );
      return NextResponse.json({ ok: true, action: "rollback", rolledBackTo: revisionNo, ...saved }, { headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "reset-to-source") {
      if (!document.source_wikitext) return errorResponse(new Error("Source wikitext is unavailable"), 400);
      const saved = await saveRevision(document.id, document.source_wikitext, "ko", "Reset draft to captured source");
      return NextResponse.json({ ok: true, action: "reset-to-source", ...saved }, { headers: { "Cache-Control": "no-store" } });
    }

    return errorResponse(new Error("Unsupported action"), 400);
  } catch (error) {
    return errorResponse(error);
  }
}
