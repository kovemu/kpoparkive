import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { applyNamuAstOperationsComplete, type NamuAstCompleteEditOperation } from "../../../lib/namumarkAstEditComplete";
import { assertEditingAstLossless, parseNamuMarkAstForEditing } from "../../../lib/namumarkAstEditing";
import { parseNamuTableAstLossless as parseNamuTableAst } from "../../../lib/namumarkTableAstLossless";
import { scanNamuMediaCalls } from "../../../lib/namumarkMediaScan";
import { parseNamuMediaAst } from "../../../lib/namumarkMediaAst";
import { parseNamuTemplateAst, scanNamuTemplateCalls } from "../../../lib/namumarkTemplateAst";
import type { NamuAstInlineNode } from "../../../lib/namumarkAst";

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
  return (value || "").normalize("NFKC").trim();
}

async function findDocument(title: string) {
  const rows = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      `&select=id,source_title,source_wikitext,content_wikitext,content_status,content_revision_no,source_format,source_fidelity_meta&limit=1`,
  );
  return rows[0] || null;
}

function publicWikitext(document: SourceDocument) {
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

type PublicMedia = {
  ownerType: "document" | "table";
  ownerNodeId: string;
  nodeId: string | null;
  callId: string | null;
  sectionIndex: number;
  sourceStart: number;
  sourceEnd: number;
  kind: string;
  macroName: string;
  target: string;
  targetStart: number;
  targetEnd: number;
  paramCount: number;
  editableParamCount: number;
  params: ReturnType<typeof parseNamuMediaAst>["params"];
};

function publicEditorModel(source: string) {
  const ast = parseNamuMarkAstForEditing(source);
  assertEditingAstLossless(source, ast);
  const { source: _source, raw: _raw, ...publicAst } = ast;
  const tables: Array<{
    nodeId: string;
    sectionIndex: number;
    sourceStart: number;
    sourceEnd: number;
    rowCount: number;
    cellCount: number;
    editableFieldCount: number;
    lockedCellCount: number;
    rows: ReturnType<typeof parseNamuTableAst>["rows"];
    templateCalls: Array<{
      id: string;
      index: number;
      sourceStart: number;
      sourceEnd: number;
      name: string;
      paramCount: number;
      editableParamCount: number;
      params: ReturnType<typeof scanNamuTemplateCalls>[number]["params"];
    }>;
  }> = [];
  const templates: Array<{
    nodeId: string;
    sectionIndex: number;
    sourceStart: number;
    sourceEnd: number;
    name: string;
    paramCount: number;
    editableParamCount: number;
    params: ReturnType<typeof parseNamuTemplateAst>["params"];
  }> = [];
  const media: PublicMedia[] = [];

  const addInlineMedia = (nodes: NamuAstInlineNode[], ownerNodeId: string, sectionIndex: number) => {
    for (const node of nodes) {
      if (node.type === "inline-media") {
        try {
          const model = parseNamuMediaAst(node.raw);
          media.push({
            ownerType: "document",
            ownerNodeId,
            nodeId: node.id,
            callId: null,
            sectionIndex,
            sourceStart: node.sourceStart,
            sourceEnd: node.sourceEnd,
            kind: model.kind,
            macroName: model.macroName,
            target: model.target,
            targetStart: node.sourceStart + model.targetStart,
            targetEnd: node.sourceStart + model.targetEnd,
            paramCount: model.paramCount,
            editableParamCount: model.editableParamCount,
            params: model.params,
          });
        } catch {
          // Keep unsupported media syntax lossless and protected.
        }
      }
      if ((node.type === "link" || node.type === "external-link" || node.type === "format") && node.children?.length) {
        addInlineMedia(node.children, ownerNodeId, sectionIndex);
      }
    }
  };

  let sectionIndex = 0;
  for (const block of ast.blocks) {
    if (block.type === "heading") {
      sectionIndex += 1;
      addInlineMedia(block.children, block.id, sectionIndex);
      continue;
    }
    if (block.type === "table") {
      const model = parseNamuTableAst(block.raw);
      const templateCalls = scanNamuTemplateCalls(block.raw).map(({ raw: _callRaw, ...call }) => call);
      tables.push({
        nodeId: block.id,
        sectionIndex,
        sourceStart: block.sourceStart,
        sourceEnd: block.sourceEnd,
        rowCount: model.rowCount,
        cellCount: model.cellCount,
        editableFieldCount: model.editableFieldCount,
        lockedCellCount: model.lockedCellCount,
        rows: model.rows,
        templateCalls,
      });
      for (const call of scanNamuMediaCalls(block.raw)) {
        media.push({
          ownerType: "table",
          ownerNodeId: block.id,
          nodeId: null,
          callId: call.id,
          sectionIndex,
          sourceStart: block.sourceStart + call.sourceStart,
          sourceEnd: block.sourceStart + call.sourceEnd,
          kind: call.kind,
          macroName: call.macroName,
          target: call.target,
          targetStart: block.sourceStart + call.targetStart,
          targetEnd: block.sourceStart + call.targetEnd,
          paramCount: call.paramCount,
          editableParamCount: call.editableParamCount,
          params: call.params,
        });
      }
      continue;
    }
    if (block.type === "template") {
      try {
        const model = parseNamuTemplateAst(block.raw);
        templates.push({
          nodeId: block.id,
          sectionIndex,
          sourceStart: block.sourceStart,
          sourceEnd: block.sourceEnd,
          name: model.name,
          paramCount: model.paramCount,
          editableParamCount: model.editableParamCount,
          params: model.params,
        });
      } catch {
        // Preserve unusual template source as an atomic AST block rather than failing the whole editor.
      }
      continue;
    }
    if (block.type === "media") {
      try {
        const model = parseNamuMediaAst(block.raw);
        media.push({
          ownerType: "document",
          ownerNodeId: block.id,
          nodeId: block.id,
          callId: null,
          sectionIndex,
          sourceStart: block.sourceStart,
          sourceEnd: block.sourceEnd,
          kind: model.kind,
          macroName: model.macroName,
          target: model.target,
          targetStart: block.sourceStart + model.targetStart,
          targetEnd: block.sourceStart + model.targetEnd,
          paramCount: model.paramCount,
          editableParamCount: model.editableParamCount,
          params: model.params,
        });
      } catch {
        // Preserve unsupported media source as an atomic block.
      }
      continue;
    }
    if (block.type === "paragraph") addInlineMedia(block.children, block.id, sectionIndex);
    if (block.type === "list") for (const line of block.lines) addInlineMedia(line.children, block.id, sectionIndex);
  }

  return { ast: publicAst, tables, templates, media };
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

    const editor = publicEditorModel(source);
    return json({
      ok: true,
      editorVersion: "ast-visual-v3",
      document: {
        title: document.source_title,
        publicRevisionNo: publicRevisionNo(document),
        sourceMode: document.content_status === "published" ? "published" : "captured",
        sourceHash: sourceHash(source),
      },
      ast: editor.ast,
      tables: editor.tables,
      templates: editor.templates,
      media: editor.media,
      capabilities: {
        direct: [
          "text",
          "heading",
          "link",
          "external-link",
          "footnote",
          "table-field",
          "atomic-inline-text",
        ],
        structuredBridge: [
          "table",
          "table-template-parameter",
          "template-parameter",
          "media",
          "inline-media",
          "table-media",
          "media-delete",
          "table-cell-style",
          "table-layout",
          "block-insert",
          "block-delete",
        ],
        sourceFallback: [
          "styled-block",
          "raw-block",
          "table",
          "template",
          "media",
          "protected-inline-parent",
          "unmapped-text-block",
        ],
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
      operations?: NamuAstCompleteEditOperation[];
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

    const result = applyNamuAstOperationsComplete(original, Array.isArray(body.operations) ? body.operations : []);
    const proposed = result.proposed;
    if (proposed.length > MAX_DOCUMENT_CHARS) return json({ error: "Edited document is too large" }, 413);
    assertEditingAstLossless(proposed, result.afterAst);

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
