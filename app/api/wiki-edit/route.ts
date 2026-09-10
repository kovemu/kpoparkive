import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { findEasyEditBlock, parseEasyEditSections } from "../../../lib/wikiEasyEdit";
import { applyWikiInfoboxChanges, parseWikiInfobox } from "../../../lib/wikiInfoboxEdit";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RATE_SALT = process.env.KPOPARKIVE_ADMIN_KEY || SERVICE_ROLE_KEY || "kpoparkive-easy-edit";
const MAX_PROPOSALS_PER_HOUR = 10;
const MAX_PROPOSAL_CHARS = 12000;

const UNSAFE_VISUAL_SYNTAX: Array<[RegExp, string]> = [
  [/^\s*={2,6}.*={2,6}\s*$/m, "Section headings cannot be changed from the visual paragraph editor yet."],
  [/^\s*\|\|/m, "Tables must be edited with the table editor."],
  [/\{\{\{|\}\}\}/, "Styled/raw wiki blocks are protected."],
  [/\[include\(/i, "Templates are protected."],
  [/\[youtube\(/i, "Embedded media is protected."],
  [/\[\[(?:파일|File):/i, "Files must be edited with the media editor."],
  [/\[\[(?:분류|Category):/i, "Document metadata is protected."],
];

type SourceDocument = {
  id: string;
  source_title: string;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_status: string;
  content_revision_no: number;
};

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

function response(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
    },
  });
}

function errorResponse(error: unknown, status = 500) {
  return response({ error: error instanceof Error ? error.message : "Unknown visual edit error" }, status);
}

function normalizeTitle(value: string | null | undefined) {
  return (value || "").normalize("NFKC").trim();
}

function normalizeWiki(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function validateVisualWikitext(value: string) {
  for (const [pattern, message] of UNSAFE_VISUAL_SYNTAX) {
    if (pattern.test(value)) throw Object.assign(new Error(message), { status: 400 });
  }
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

function submitterHash(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const userAgent = request.headers.get("user-agent") || "unknown";
  return createHash("sha256").update(`${forwarded}|${userAgent}|${RATE_SALT}`).digest("hex");
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
    if (!title) return errorResponse(new Error("title is required"), 400);

    const document = await findDocument(title);
    if (!document) return errorResponse(new Error("Document not found"), 404);

    const source = publicWikitext(document);
    if (!source) return errorResponse(new Error("Public source is unavailable"), 404);

    const sections = parseEasyEditSections(source).map((section) => ({
      key: section.key,
      level: section.level,
      heading: section.heading,
      editableCount: section.blocks.filter((block) => block.editable).length,
      lockedCount: section.blocks.filter((block) => !block.editable).length,
      blocks: section.blocks.map((block) => ({
        key: block.key,
        blockIndex: block.blockIndex,
        plainText: block.plainText,
        originalWikitext: block.editable ? block.originalWikitext : "",
        editable: block.editable,
        lockedReason: block.lockedReason,
      })),
    }));

    const infobox = parseWikiInfobox(source);

    return response({
      ok: true,
      editorVersion: "visual-v1.2",
      document: {
        title: document.source_title,
        publicRevisionNo: document.content_status === "published" ? document.content_revision_no : 0,
        sourceMode: document.content_status === "published" ? "published" : "captured",
      },
      sections,
      infobox: infobox ? {
        key: infobox.key,
        editableCount: infobox.editableCount,
        lockedCount: infobox.lockedCount,
        fields: infobox.fields.map((field) => ({
          key: field.key,
          label: field.label,
          group: field.group,
          inputKind: field.inputKind,
          valueWikitext: field.editable ? field.valueWikitext : "",
          plainText: field.plainText,
          editable: field.editable,
          lockedReason: field.lockedReason,
        })),
      } : null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      kind?: "block" | "infobox";
      title?: string;
      blockKey?: string;
      proposedText?: string;
      proposedWikitext?: string;
      infoboxChanges?: Array<{ key?: string; proposedWikitext?: string }>;
      summary?: string;
      displayName?: string;
      baseRevisionNo?: number;
      website?: string;
    };

    if (body.website) return response({ ok: true, submitted: true });

    const title = normalizeTitle(body.title);
    const summary = (body.summary || "").trim().slice(0, 500) || null;
    const displayName = (body.displayName || "").trim().slice(0, 80) || null;
    if (!title) return errorResponse(new Error("title is required"), 400);

    const hash = submitterHash(request);
    await enforceRateLimit(hash);

    const document = await findDocument(title);
    if (!document) return errorResponse(new Error("Document not found"), 404);

    const source = publicWikitext(document);
    const publicRevisionNo = document.content_status === "published" ? document.content_revision_no : 0;
    if (Number(body.baseRevisionNo || 0) !== publicRevisionNo) {
      return errorResponse(new Error("This page changed while you were editing. Reload the editor and try again."), 409);
    }

    if (body.kind === "infobox") {
      const changes = (Array.isArray(body.infoboxChanges) ? body.infoboxChanges : [])
        .map((change) => ({
          key: String(change?.key || "").trim(),
          proposedWikitext: normalizeWiki(String(change?.proposedWikitext || "")),
        }))
        .filter((change) => change.key && change.proposedWikitext);

      if (!changes.length) return errorResponse(new Error("No infobox changes were supplied"), 400);
      if (changes.length > 60) return errorResponse(new Error("Too many infobox fields were changed at once"), 400);

      let result: ReturnType<typeof applyWikiInfoboxChanges>;
      try {
        result = applyWikiInfoboxChanges(source, changes);
      } catch (error) {
        return errorResponse(error, 400);
      }

      const originalPlainText = result.parsed.fields
        .map((field) => `${field.label}: ${field.plainText}`)
        .join("\n")
        .slice(0, MAX_PROPOSAL_CHARS);
      const proposedPlainText = result.changedFields
        .map((field) => `${field.label}: ${field.proposed}`)
        .join("\n")
        .slice(0, MAX_PROPOSAL_CHARS);

      const inserted = await db<Array<{ id: string; created_at: string }>>("source_edit_proposals", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          source_document_id: document.id,
          source_title: document.source_title,
          section_key: "infobox:lead",
          section_heading: "Infobox",
          block_index: -1,
          base_revision_no: publicRevisionNo,
          original_wikitext: result.parsed.originalWikitext,
          original_plain_text: originalPlainText,
          proposed_plain_text: proposedPlainText,
          proposed_wikitext: result.proposedInfobox,
          summary,
          display_name: displayName,
          submitter_hash: hash,
          status: "pending",
        }),
      });

      return response({
        ok: true,
        submitted: true,
        proposalId: inserted[0]?.id || null,
        editorVersion: "visual-v1.2",
        changedFields: result.changedFields.map((field) => field.label),
      });
    }

    const blockKey = (body.blockKey || "").trim();
    const proposedText = (typeof body.proposedText === "string" ? body.proposedText : "").replace(/\r\n?/g, "\n").trim();
    const proposedWikitext = normalizeWiki(typeof body.proposedWikitext === "string" ? body.proposedWikitext : proposedText);

    if (!blockKey) return errorResponse(new Error("blockKey is required"), 400);
    if (!proposedText || !proposedWikitext) return errorResponse(new Error("Suggested content cannot be empty"), 400);
    if (proposedText.length > MAX_PROPOSAL_CHARS || proposedWikitext.length > MAX_PROPOSAL_CHARS) {
      return errorResponse(new Error("Suggested content is too long"), 413);
    }
    validateVisualWikitext(proposedWikitext);

    const found = findEasyEditBlock(source, blockKey);
    if (!found) return errorResponse(new Error("Editable block no longer exists"), 409);
    if (!found.block.editable) return errorResponse(new Error("This block is protected from Visual Edit"), 403);
    if (normalizeWiki(proposedWikitext) === normalizeWiki(found.block.originalWikitext)) {
      return errorResponse(new Error("No changes were made"), 400);
    }

    const inserted = await db<Array<{ id: string; created_at: string }>>("source_edit_proposals", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        source_document_id: document.id,
        source_title: document.source_title,
        section_key: found.section.key,
        section_heading: found.section.heading,
        block_index: found.block.blockIndex,
        base_revision_no: publicRevisionNo,
        original_wikitext: found.block.originalWikitext,
        original_plain_text: found.block.plainText,
        proposed_plain_text: proposedText,
        proposed_wikitext: proposedWikitext,
        summary,
        display_name: displayName,
        submitter_hash: hash,
        status: "pending",
      }),
    });

    return response({ ok: true, submitted: true, proposalId: inserted[0]?.id || null, editorVersion: "visual-v1.2" });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) || 500 : 500;
    return errorResponse(error, status);
  }
}
