import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { applyNamuAstOperations, type NamuAstEditOperation } from "../../../lib/namumarkAstEdit";
import { assertNamuMarkAstLossless, parseNamuMarkAst } from "../../../lib/namumarkAst";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RATE_SALT = process.env.KPOPARKIVE_ADMIN_KEY || SERVICE_ROLE_KEY || "kpoparkive-ast-visual-edit";
const MAX_PROPOSALS_PER_HOUR = 6;
const MAX_DOCUMENT_CHARS = 1_500_000;

type SourceDocument = {
  id: string;
  source_title: string;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_status: string;
  content_revision_no: number;
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
  return (value || "").normalize("NFKC").trim();
}

async function findDocument(title: string) {
  const rows = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      `&select=id,source_title,source_wikitext,content_wikitext,content_status,content_revision_no&limit=1`,
  );
  return rows[0] || null;
}

function publicWikitext(document: SourceDocument) {
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

function publicAst(source: string) {
  const ast = parseNamuMarkAst(source);
  assertNamuMarkAstLossless(source, ast);
  const { source: _source, raw: _raw, ...payload } = ast;
  return payload;
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const title = normalizeTitle(url.searchParams.get("title"));
    if (!title) return json({ error: "title is required" }, 400);

    const document = await findDocument(title);
    if (!document) return json({ error: "Document not found" }, 404);
    const source = publicWikitext(document);
    if (!source) return json({ error: "Public source is unavailable" }, 404);
    if (source.length > MAX_DOCUMENT_CHARS) return json({ error: "Document is too large for visual editing" }, 413);

    const ast = publicAst(source);
    return json({
      ok: true,
      editorVersion: "ast-visual-v3",
      document: {
        title: document.source_title,
        publicRevisionNo: publicRevisionNo(document),
        sourceMode: document.content_status === "published" ? "published" : "captured",
        sourceHash: sourceHash(source),
      },
      ast,
      capabilities: {
        direct: ["text", "heading", "link", "external-link"],
        structuredBridge: ["table", "template", "media"],
        sourceFallback: ["styled-block", "raw-block"],
      },
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) || 500 : 500;
    return json({ error: error instanceof Error ? error.message : "Could not load AST visual editor" }, status);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      title?: string;
      baseRevisionNo?: number;
      baseSourceHash?: string;
      operations?: NamuAstEditOperation[];
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

    const original = publicWikitext(document);
    if (!original) return json({ error: "Public source is unavailable" }, 404);
    if (String(body.baseSourceHash || "") !== sourceHash(original)) {
      return json({ error: "The underlying NamuMark source changed while you were editing. Reload and try again." }, 409);
    }

    const hash = submitterHash(request);
    await enforceRateLimit(hash);

    const result = applyNamuAstOperations(original, Array.isArray(body.operations) ? body.operations : []);
    const proposed = result.proposed;
    if (proposed.length > MAX_DOCUMENT_CHARS) return json({ error: "Edited document is too large" }, 413);
    assertNamuMarkAstLossless(proposed, result.afterAst);

    const summary = String(body.summary || "").trim().slice(0, 500) || "Visual editor V3 AST edit";
    const displayName = String(body.displayName || "").trim().slice(0, 80) || null;
    const labels = result.changes.map((change) => `${change.op}: ${change.nodeType} @ ${change.sourceStart}-${change.sourceEnd}`);

    const inserted = await db<Array<{ id: string; created_at: string }>>("source_edit_proposals", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        source_document_id: document.id,
        source_title: document.source_title,
        section_key: "document:ast-v3",
        section_heading: "Full page (AST Visual Editor V3)",
        block_index: -3,
        base_revision_no: revision,
        original_wikitext: original,
        original_plain_text: `AST visual edit ${document.source_title}`,
        proposed_plain_text: labels.join("\n").slice(0, 12000),
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
      editorVersion: "ast-visual-v3",
      changes: labels,
      nextSourceHash: sourceHash(proposed),
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) || 500 : 500;
    return json({ error: error instanceof Error ? error.message : "Could not submit AST visual edit" }, status);
  }
}
