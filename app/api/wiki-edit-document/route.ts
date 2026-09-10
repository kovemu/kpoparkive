import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { findEasyEditBlock, parseEasyEditSections } from "../../../lib/wikiEasyEdit";
import { applyWikiInfoboxChanges } from "../../../lib/wikiInfoboxEdit";
import { applyWikiTableChanges, parseWikiTables } from "../../../lib/wikiTableEdit";
import { buildWikiTemplate, parseWikiTemplates, replaceWikiTemplate } from "../../../lib/wikiTemplateEdit";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RATE_SALT = process.env.KPOPARKIVE_ADMIN_KEY || SERVICE_ROLE_KEY || "kpoparkive-page-visual-edit";
const MAX_PROPOSALS_PER_HOUR = 6;
const MAX_DOCUMENT_CHARS = 1_500_000;
const HEADING_RE = /^(={2,6})\s*(.*?)\s*\1\s*$/;

type SourceDocument = {
  id: string;
  source_title: string;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_status: string;
  content_revision_no: number;
};

type BlockChange = { blockKey?: string; proposedWikitext?: string };
type TableChange = { blockKey?: string; changes?: Array<{ key?: string; proposedWikitext?: string }> };
type TemplateChange = { templateKey?: string; name?: string; params?: Array<{ name?: string | null; value?: string }> };
type Insertion = { sectionKey?: string; wikitext?: string };

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

function normalizeWiki(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
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
  if (rows.length >= MAX_PROPOSALS_PER_HOUR) throw Object.assign(new Error("Too many edit suggestions. Please try again later."), { status: 429 });
}

function replaceExactOnce(source: string, original: string, replacement: string) {
  const at = source.indexOf(original);
  if (at < 0) throw new Error("The edited source fragment no longer exists. Reload and try again.");
  return `${source.slice(0, at)}${replacement}${source.slice(at + original.length)}`;
}

function sectionIndexFromKey(key: string) {
  const match = key.match(/^section:(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function insertAtSectionEnd(source: string, sectionKey: string, wikitext: string) {
  const wanted = sectionIndexFromKey(sectionKey);
  if (wanted < 0) throw new Error("Invalid insertion section");
  const lines = source.split("\n");
  let sectionIndex = 0;
  let sectionStart = 0;
  let sectionEnd = lines.length;
  let found = wanted === 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (!HEADING_RE.test(lines[i])) continue;
    sectionIndex += 1;
    if (sectionIndex === wanted) {
      sectionStart = i + 1;
      found = true;
      continue;
    }
    if (found && sectionIndex > wanted) {
      sectionEnd = i;
      break;
    }
  }

  if (!found) throw new Error("Insertion section no longer exists");
  if (wanted === 0) {
    sectionStart = 0;
    sectionEnd = lines.findIndex((line) => HEADING_RE.test(line));
    if (sectionEnd < 0) sectionEnd = lines.length;
  }

  const before = lines.slice(0, sectionEnd);
  const after = lines.slice(sectionEnd);
  while (before.length && !before[before.length - 1].trim()) before.pop();
  before.push("", wikitext.trim(), "");
  return [...before, ...after].join("\n").replace(/\n{4,}/g, "\n\n\n");
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

    const sections = parseEasyEditSections(source).map((section) => ({
      key: section.key,
      sectionIndex: section.sectionIndex,
      level: section.level,
      heading: section.heading,
      blocks: section.blocks.map((block) => ({
        key: block.key,
        blockIndex: block.blockIndex,
        plainText: block.plainText,
        originalWikitext: block.originalWikitext,
        editable: block.editable,
        lockedReason: block.lockedReason,
      })),
    }));

    const tables = parseWikiTables(source).map((table) => {
      const found = findEasyEditBlock(source, table.blockKey);
      return { ...table, originalWikitext: found?.block.originalWikitext || "" };
    });

    return json({
      ok: true,
      editorVersion: "page-visual-v1",
      document: {
        title: document.source_title,
        publicRevisionNo: publicRevisionNo(document),
        sourceMode: document.content_status === "published" ? "published" : "captured",
      },
      sourceWikitext: source,
      sections,
      tables,
      templates: parseWikiTemplates(source),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not load full-page editor" }, 500);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      title?: string;
      baseRevisionNo?: number;
      summary?: string;
      displayName?: string;
      website?: string;
      blockChanges?: BlockChange[];
      tableChanges?: TableChange[];
      infoboxChanges?: Array<{ key?: string; proposedWikitext?: string }>;
      templateChanges?: TemplateChange[];
      insertions?: Insertion[];
    };

    if (body.website) return json({ ok: true, submitted: true });
    const title = normalizeTitle(body.title);
    if (!title) return json({ error: "title is required" }, 400);
    const document = await findDocument(title);
    if (!document) return json({ error: "Document not found" }, 404);
    const revision = publicRevisionNo(document);
    if (Number(body.baseRevisionNo || 0) !== revision) return json({ error: "This page changed while you were editing. Reload and try again." }, 409);

    const hash = submitterHash(request);
    await enforceRateLimit(hash);
    const original = publicWikitext(document);
    let proposed = original;
    const changeLabels: string[] = [];

    for (const change of body.blockChanges || []) {
      const blockKey = String(change.blockKey || "").trim();
      const value = normalizeWiki(String(change.proposedWikitext || ""));
      if (!blockKey || !value) continue;
      const found = findEasyEditBlock(proposed, blockKey);
      if (!found || !found.block.editable) throw Object.assign(new Error("An edited text block no longer exists"), { status: 409 });
      if (normalizeWiki(found.block.originalWikitext) === value) continue;
      proposed = replaceExactOnce(proposed, found.block.originalWikitext, value);
      changeLabels.push(`Text: ${found.section.heading}`);
    }

    for (const tableChange of body.tableChanges || []) {
      const blockKey = String(tableChange.blockKey || "").trim();
      const changes = (tableChange.changes || [])
        .map((item) => ({ key: String(item.key || "").trim(), proposedWikitext: String(item.proposedWikitext || "").trim() }))
        .filter((item) => item.key && item.proposedWikitext);
      if (!blockKey || !changes.length) continue;
      const result = applyWikiTableChanges(proposed, blockKey, changes);
      proposed = replaceExactOnce(proposed, result.found.block.originalWikitext, result.proposedTable);
      changeLabels.push(`Table: ${result.found.section.heading}`);
    }

    if ((body.infoboxChanges || []).length) {
      const changes = (body.infoboxChanges || [])
        .map((item) => ({ key: String(item.key || "").trim(), proposedWikitext: String(item.proposedWikitext || "").trim() }))
        .filter((item) => item.key && item.proposedWikitext);
      if (changes.length) {
        const result = applyWikiInfoboxChanges(proposed, changes);
        proposed = replaceExactOnce(proposed, result.parsed.originalWikitext, result.proposedInfobox);
        changeLabels.push("Infobox");
      }
    }

    for (const templateChange of body.templateChanges || []) {
      const templateKey = String(templateChange.templateKey || "").trim();
      if (!templateKey) continue;
      const name = String(templateChange.name || "").trim();
      const params = (templateChange.params || []).map((param) => ({ name: param.name || null, value: String(param.value || "") }));
      const result = replaceWikiTemplate(proposed, templateKey, name, params);
      proposed = result.source;
      changeLabels.push(`Template: ${name}`);
    }

    for (const insertion of body.insertions || []) {
      const sectionKey = String(insertion.sectionKey || "").trim();
      const wikitext = String(insertion.wikitext || "").trim();
      if (!sectionKey || !wikitext) continue;
      if (wikitext.length > 100_000) throw Object.assign(new Error("Inserted block is too large"), { status: 413 });
      proposed = insertAtSectionEnd(proposed, sectionKey, wikitext);
      changeLabels.push(`Insert in ${sectionKey}`);
    }

    proposed = normalizeWiki(proposed);
    if (proposed === normalizeWiki(original)) return json({ error: "No changes were made" }, 400);
    if (proposed.length > MAX_DOCUMENT_CHARS) return json({ error: "Edited document is too large" }, 413);

    const summary = String(body.summary || "").trim().slice(0, 500) || "Full-page visual edit";
    const displayName = String(body.displayName || "").trim().slice(0, 80) || null;
    const inserted = await db<Array<{ id: string; created_at: string }>>("source_edit_proposals", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        source_document_id: document.id,
        source_title: document.source_title,
        section_key: "document:full",
        section_heading: "Full page",
        block_index: -2,
        base_revision_no: revision,
        original_wikitext: original,
        original_plain_text: `Full page ${document.source_title}`,
        proposed_plain_text: changeLabels.join("\n").slice(0, 12000),
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
      editorVersion: "page-visual-v1",
      changes: changeLabels,
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number((error as { status?: number }).status) || 500 : 500;
    return json({ error: error instanceof Error ? error.message : "Could not submit full-page edit" }, status);
  }
}
