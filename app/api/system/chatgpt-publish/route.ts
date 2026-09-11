import { NextResponse } from "next/server";
import { renderExactNamuPreview } from "../../../../lib/thetreeExactPreview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co")
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TRANSLATION_VERSION = "chatgpt-en-v1";
const RENDER_ENGINE = "thetree-exact-assistant-publish";
const RENDER_VERSION = "assistant-publish-v1";

type SourceDocument = {
  id: string;
  source_title: string;
  source_wikitext: string | null;
  translation_status: string | null;
  translation_version: string | null;
  content_wikitext: string | null;
  content_language: string | null;
  content_status: string | null;
  content_revision_no: number;
  content_namumark_html: string | null;
  published_revision_no: number | null;
};

function normalizeTitle(value: string) {
  return String(value || "").normalize("NFKC").trim();
}

function headers(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function findDocument(title: string) {
  const exact = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      "&select=id,source_title,source_wikitext,translation_status,translation_version,content_wikitext,content_language,content_status,content_revision_no,content_namumark_html,published_revision_no&limit=1",
  );
  if (exact[0]) return exact[0];

  const candidates = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=ilike.${encodeURIComponent(title)}` +
      "&select=id,source_title,source_wikitext,translation_status,translation_version,content_wikitext,content_language,content_status,content_revision_no,content_namumark_html,published_revision_no&limit=10",
  );
  const folded = normalizeTitle(title).toLocaleLowerCase();
  return candidates.find((row) => normalizeTitle(row.source_title).toLocaleLowerCase() === folded) || null;
}

function count(source: string, needle: string) {
  return source.split(needle).length - 1;
}

function validateTranslation(source: string, translated: string) {
  if (!source.trim()) throw new Error("Captured source is empty");
  if (!translated.trim()) throw new Error("Translated NamuMark is empty");

  const ratio = translated.length / Math.max(1, source.length);
  if (ratio < 0.55 || ratio > 2.6) {
    throw new Error(`Translation size ratio ${ratio.toFixed(2)} is outside the safe range`);
  }

  const structuralTokens = ["[[", "]]", "{{{", "}}}", "[include("];
  for (const token of structuralTokens) {
    const before = count(source, token);
    const after = count(translated, token);
    if (before !== after) {
      throw new Error(`NamuMark structure changed for ${token}: source=${before}, translated=${after}`);
    }
  }

  const sourceHeadings = source.split("\n").filter((line) => /^={1,6}(?:#)?\s?.+?\s?(?:#)?={1,6}$/.test(line.trim())).length;
  const translatedHeadings = translated.split("\n").filter((line) => /^={1,6}(?:#)?\s?.+?\s?(?:#)?={1,6}$/.test(line.trim())).length;
  if (sourceHeadings !== translatedHeadings) {
    throw new Error(`Heading structure changed: source=${sourceHeadings}, translated=${translatedHeadings}`);
  }
}

async function publishDocument(document: SourceDocument) {
  const source = String(document.source_wikitext || "");
  const translated = String(document.content_wikitext || "");

  if (document.translation_status === "published" && document.content_status === "published") {
    return {
      status: "already-published",
      title: document.source_title,
      revisionNo: document.published_revision_no || document.content_revision_no,
    };
  }

  if (document.translation_status !== "translated_by_chatgpt") {
    throw new Error(
      `Document is not approved for assistant publish (translation_status=${document.translation_status || "null"})`,
    );
  }
  if (document.translation_version !== TRANSLATION_VERSION) {
    throw new Error(`Unexpected translation version: ${document.translation_version || "null"}`);
  }
  if (document.content_language !== "en") {
    throw new Error(`Translated content language must be en, got ${document.content_language || "null"}`);
  }
  if (!document.content_revision_no || document.content_revision_no < 1) {
    throw new Error("Translated content has no revision");
  }

  validateTranslation(source, translated);

  const rendered = await renderExactNamuPreview(document.source_title, translated);
  if (rendered.hasError) {
    throw new Error(`The Tree renderer reported ${rendered.errorCode || "an unknown error"}`);
  }
  if (!rendered.html || rendered.html.length < 100) {
    throw new Error("The Tree renderer returned an unexpectedly small document");
  }

  const now = new Date().toISOString();
  const meta = {
    translationVersion: TRANSLATION_VERSION,
    revisionNo: document.content_revision_no,
    renderedBy: RENDER_ENGINE,
    renderVersion: RENDER_VERSION,
    renderMs: rendered.renderMs,
    links: rendered.links,
    files: rendered.files,
    headings: rendered.headings,
  };

  await db(`source_documents?id=eq.${encodeURIComponent(document.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      content_namumark_html: rendered.html,
      content_namumark_meta: meta,
      content_namumark_engine: RENDER_ENGINE,
      content_namumark_engine_version: RENDER_VERSION,
      content_namumark_rendered_at: now,
      content_status: "published",
      published_content_wikitext: translated,
      published_content_language: "en",
      published_revision_no: document.content_revision_no,
      published_namumark_html: rendered.html,
      published_namumark_meta: meta,
      published_namumark_engine: RENDER_ENGINE,
      published_namumark_engine_version: RENDER_VERSION,
      published_at: now,
      translation_status: "published",
      translated_at: now,
      updated_at: now,
    }),
  });

  return {
    status: "published",
    title: document.source_title,
    revisionNo: document.content_revision_no,
    renderMs: rendered.renderMs,
    htmlBytes: Buffer.byteLength(rendered.html, "utf8"),
    links: rendered.links,
    files: rendered.files,
    headings: rendered.headings,
    publishedAt: now,
  };
}

export async function GET(request: Request) {
  try {
    const title = normalizeTitle(new URL(request.url).searchParams.get("title") || "");
    if (!title) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }

    const document = await findDocument(title);
    if (!document) {
      return NextResponse.json({ error: "Source document not found" }, { status: 404 });
    }

    const result = await publishDocument(document);
    return NextResponse.json(
      { ok: true, translationVersion: TRANSLATION_VERSION, ...result },
      { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown assistant publish error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 409, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow, noarchive" } },
    );
  }
}
