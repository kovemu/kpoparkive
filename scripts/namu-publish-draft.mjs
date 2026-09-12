import fs from "node:fs";
import path from "node:path";
import { findVisibleKoreanLinkLabels } from "./namu-english-link-localizer.mjs";

const ROOT = process.cwd();

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadEnv(path.join(ROOT, ".env.local"));
loadEnv(path.join(ROOT, ".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const titles = process.argv.slice(2).map((value) => decodeURIComponent(value).normalize("NFKC").trim()).filter(Boolean);

if (!SERVICE_ROLE_KEY) {
  console.error("Manual publish: SUPABASE_SERVICE_ROLE_KEY is missing.");
  process.exit(1);
}
if (!titles.length) {
  console.error('Usage: npm.cmd run namu:publish -- "원이"');
  process.exit(1);
}

function headers(extra = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: { ...headers(), ...(init.headers || {}) },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function fetchDraft(title) {
  const rows = await db(
    "source_documents?source=eq.namu_mirror" +
      `&source_title=eq.${encodeURIComponent(title)}` +
      "&select=id,source_title,translated_title,translation_status,content_status,content_revision_no,content_wikitext,content_language,content_namumark_html,content_namumark_meta,content_namumark_engine,content_namumark_engine_version,content_namumark_rendered_at,published_revision_no" +
      "&limit=1",
  );
  return rows?.[0] || null;
}

function validateDraft(row) {
  if (!row) throw new Error("document not found");
  if (row.content_language !== "en") throw new Error("content_language is not en");

  const isTemplateDocument = /^(?:틀|Template):/i.test(String(row.source_title || ""));
  if (!isTemplateDocument) {
    const translatedTitle = String(row.translated_title || "").normalize("NFKC").trim();
    if (!translatedTitle) throw new Error("English title QA: translated_title is missing");
    if (/[가-힣]/.test(translatedTitle)) {
      throw new Error(`English title QA: translated_title still contains Korean: ${translatedTitle}`);
    }
  }

  if (!["translated_by_chatgpt", "reviewed"].includes(String(row.translation_status || ""))) {
    throw new Error(`translation_status=${row.translation_status || "null"} is not publishable`);
  }

  const revision = Number(row.content_revision_no || 0) || 0;
  if (!revision) throw new Error("content_revision_no is missing");
  if (typeof row.content_wikitext !== "string" || !row.content_wikitext.trim()) {
    throw new Error("content_wikitext is missing");
  }
  if (typeof row.content_namumark_html !== "string" || row.content_namumark_html.length < 100) {
    throw new Error("rendered draft HTML is missing");
  }
  if (!row.content_namumark_rendered_at) throw new Error("rendered draft timestamp is missing");

  const meta = row.content_namumark_meta && typeof row.content_namumark_meta === "object"
    ? row.content_namumark_meta
    : {};
  const renderedRevision = Number(meta?.editableContent?.revisionNo || 0) || 0;
  if (renderedRevision !== revision) {
    throw new Error(`draft render is stale: rendered r${renderedRevision || "?"}, content r${revision}`);
  }
  if (meta?.hasError) throw new Error(`The Tree reported render error ${meta?.errorCode || "unknown"}`);
  if (Number(meta?.missingTemplateCount || 0) > 0) {
    throw new Error(`The Tree render has ${meta.missingTemplateCount} missing template(s)`);
  }
  if (Number(meta?.missingFileCount || 0) > 0) {
    throw new Error(`The Tree render has ${meta.missingFileCount} missing file(s)`);
  }
  if (Array.isArray(meta?.missingYouTubeEmbeds) && meta.missingYouTubeEmbeds.length > 0) {
    throw new Error(`The Tree render has ${meta.missingYouTubeEmbeds.length} missing YouTube embed(s)`);
  }

  const unresolvedTemplateLabels = Array.isArray(meta?.englishLinkLocalization?.unresolved)
    ? meta.englishLinkLocalization.unresolved
    : [];
  if (unresolvedTemplateLabels.length > 0) {
    const preview = unresolvedTemplateLabels
      .slice(0, 5)
      .map((item) => `${item?.template || "template"}:${item?.target || "?"}`)
      .join(" | ");
    throw new Error(
      `English link-label QA: ${unresolvedTemplateLabels.length} template-generated label(s) unresolved: ${preview}`,
    );
  }

  const visibleKoreanLinks = findVisibleKoreanLinkLabels(row.content_namumark_html, { limit: 20 });
  if (visibleKoreanLinks.length > 0) {
    const preview = visibleKoreanLinks
      .slice(0, 5)
      .map((item) => `${item.visible} -> ${item.href || "?"}`)
      .join(" | ");
    throw new Error(
      `English link-label QA: ${visibleKoreanLinks.length} visible Korean link label(s) remain: ${preview}`,
    );
  }

  return { revision, meta };
}

async function publishTitle(title) {
  const row = await fetchDraft(title);
  const { revision, meta } = validateDraft(row);
  const now = new Date().toISOString();

  await db(`source_documents?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      content_status: "published",
      published_content_wikitext: row.content_wikitext,
      published_content_language: "en",
      published_revision_no: revision,
      published_namumark_html: row.content_namumark_html,
      published_namumark_meta: meta,
      published_namumark_engine: row.content_namumark_engine,
      published_namumark_engine_version: row.content_namumark_engine_version,
      published_at: now,
      translation_status: "reviewed",
      updated_at: now,
    }),
  });

  console.log(`PUBLISHED ${title} r${revision}`);
  console.log(`Public: https://kpoparkive.vercel.app/w/${title.split("/").map(encodeURIComponent).join("/")}`);
}

let failed = false;
for (const title of titles) {
  try {
    await publishTitle(title);
  } catch (error) {
    failed = true;
    console.error(`PUBLISH FAILED ${title}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failed) process.exitCode = 1;
