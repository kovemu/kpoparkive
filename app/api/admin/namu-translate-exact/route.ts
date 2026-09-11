import { NextResponse } from "next/server";
import {
  namuMarkTranslationVersion,
  translateNamuMarkToEnglish,
} from "../../../../lib/namuExactTranslate";
import { renderExactNamuPreview } from "../../../../lib/thetreeExactPreview";

const SUPABASE_URL = (
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  "https://hukrrzhltiyirtkxmotj.supabase.co"
)
  .trim()
  .replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ADMIN_KEY = process.env.KPOPARKIVE_ADMIN_KEY;

type SourceDocument = {
  id: string;
  source_title: string;
  source_wikitext: string | null;
  raw_extracted_at: string | null;
  content_wikitext: string | null;
  content_language: string | null;
  content_revision_no: number;
  content_updated_by: string | null;
  content_namumark_html: string | null;
  content_namumark_rendered_at: string | null;
  translation_status: string | null;
  translation_version: string | null;
  translated_at: string | null;
};

function adminAuthorized(request: Request) {
  return Boolean(
    ADMIN_KEY && request.headers.get("x-admin-key") === ADMIN_KEY,
  );
}

function dbHeaders(extra: Record<string, string> = {}) {
  if (!SERVICE_ROLE_KEY) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  }
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
    headers: { ...dbHeaders(), ...(init.headers || {}) },
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : null) as T;
}

async function findDocument(title: string) {
  const rows = await db<SourceDocument[]>(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}` +
      "&select=id,source_title,source_wikitext,raw_extracted_at,content_wikitext,content_language,content_revision_no,content_updated_by,content_namumark_html,content_namumark_rendered_at,translation_status,translation_version,translated_at&limit=1",
  );
  return rows[0] || null;
}

async function patchDocument(
  documentId: string,
  payload: Record<string, unknown>,
) {
  await db<unknown>(
    `source_documents?id=eq.${encodeURIComponent(documentId)}`,
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        ...payload,
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

async function saveEnglishRevision(
  documentId: string,
  content: string,
  summary: string,
) {
  const rows = await db<{ revision_no: number; updated_at: string }[]>(
    "rpc/save_source_document_revision",
    {
      method: "POST",
      body: JSON.stringify({
        p_document_id: documentId,
        p_content_wikitext: content,
        p_content_language: "en",
        p_summary: summary,
        p_editor_label: "ai-translation",
      }),
    },
  );
  if (!rows[0]) throw new Error("Revision RPC did not return a saved revision");
  return rows[0];
}

function sourceIsNewer(document: SourceDocument) {
  if (!document.raw_extracted_at || !document.translated_at) return true;
  const sourceTime = Date.parse(document.raw_extracted_at);
  const translatedTime = Date.parse(document.translated_at);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(translatedTime)) {
    return true;
  }
  return sourceTime > translatedTime;
}

function errorResponse(error: unknown, status = 500) {
  return NextResponse.json(
    {
      ok: false,
      error: error instanceof Error ? error.message : "Unknown translation error",
    },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
      },
    },
  );
}

export async function POST(request: Request) {
  if (!adminAuthorized(request)) {
    return errorResponse(new Error("Unauthorized"), 401);
  }

  let document: SourceDocument | null = null;

  try {
    const body = (await request.json()) as {
      title?: string;
      force?: boolean;
    };
    const title = String(body.title || "").normalize("NFKC").trim();
    if (!title) return errorResponse(new Error("title is required"), 400);

    document = await findDocument(title);
    if (!document) {
      return errorResponse(new Error("Source document not found"), 404);
    }
    if (!document.source_wikitext?.trim()) {
      return errorResponse(
        new Error("Captured source_wikitext is unavailable"),
        409,
      );
    }

    const translationCurrent =
      !body.force &&
      document.content_language === "en" &&
      document.content_updated_by === "ai-translation" &&
      document.translation_status === "translated" &&
      document.translation_version === namuMarkTranslationVersion &&
      Boolean(document.content_wikitext) &&
      !sourceIsNewer(document);

    if (
      translationCurrent &&
      document.content_namumark_html &&
      document.content_namumark_rendered_at
    ) {
      return NextResponse.json(
        {
          ok: true,
          status: "unchanged",
          title: document.source_title,
          revisionNo: document.content_revision_no,
          translationVersion: document.translation_version,
          translatedAt: document.translated_at,
          renderedAt: document.content_namumark_rendered_at,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }

    let englishWikitext = document.content_wikitext || "";
    let revisionNo = document.content_revision_no;
    let revisionUpdatedAt: string | null = null;
    let translatedAt = document.translated_at;
    let model: string | null = null;
    let chunks: number | null = null;
    let sourceChars: number | null = null;
    let translatedChars: number | null = null;

    if (!translationCurrent) {
      await patchDocument(document.id, {
        translation_status: "translating",
      });

      const translated = await translateNamuMarkToEnglish(
        document.source_title,
        document.source_wikitext,
      );

      const saved = await saveEnglishRevision(
        document.id,
        translated.wikitext,
        `AI English translation from captured NamuMark (${translated.version}, ${translated.model})`,
      );

      englishWikitext = translated.wikitext;
      revisionNo = saved.revision_no;
      revisionUpdatedAt = saved.updated_at;
      translatedAt = new Date().toISOString();
      model = translated.model;
      chunks = translated.chunks;
      sourceChars = translated.sourceChars;
      translatedChars = translated.translatedChars;

      await patchDocument(document.id, {
        translation_status: "translated",
        translation_version: translated.version,
        translated_at: translatedAt,
      });
    }

    if (!englishWikitext.trim()) {
      throw new Error("English content_wikitext is unavailable for exact render");
    }

    const rendered = await renderExactNamuPreview(
      document.source_title,
      englishWikitext,
    );
    if (rendered.hasError) {
      throw new Error(
        `The Tree exact renderer reported an error${rendered.errorCode ? `: ${rendered.errorCode}` : ""}`,
      );
    }

    const renderedAt = new Date().toISOString();
    await patchDocument(document.id, {
      content_namumark_html: rendered.html,
      content_namumark_meta: {
        exactRender: {
          renderMs: rendered.renderMs,
          links: rendered.links,
          files: rendered.files,
          headings: rendered.headings,
          translationVersion:
            document.translation_version || namuMarkTranslationVersion,
          source: "content_wikitext",
        },
      },
      content_namumark_engine: "thetree-exact-server",
      content_namumark_engine_version: "v1",
      content_namumark_rendered_at: renderedAt,
      content_status: "draft",
    });

    return NextResponse.json(
      {
        ok: true,
        status: translationCurrent ? "rendered" : "translated-rendered",
        title: document.source_title,
        revisionNo,
        revisionUpdatedAt,
        translatedAt,
        renderedAt,
        model,
        translationVersion:
          document.translation_version || namuMarkTranslationVersion,
        chunks,
        sourceChars,
        translatedChars,
        renderMs: rendered.renderMs,
        links: rendered.links,
        files: rendered.files,
        headings: rendered.headings,
        contentLanguage: "en",
        contentStatus: "draft",
        next: "publish",
      },
      {
        headers: {
          "Cache-Control": "no-store",
          "X-Robots-Tag": "noindex, nofollow, noarchive",
        },
      },
    );
  } catch (error) {
    if (document?.id) {
      try {
        await patchDocument(document.id, {
          translation_status: "failed",
        });
      } catch {
        // Keep the original translation error as the response.
      }
    }
    return errorResponse(error);
  }
}
