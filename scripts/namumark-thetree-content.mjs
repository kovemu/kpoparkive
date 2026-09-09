// Exact renderer for editable Kpoparkive content.
//
// This wrapper keeps the public integration code separate from the permitted
// private/local The Tree cache. It reuses the compatibility renderer while:
// 1) substituting content_wikitext for captured source_wikitext at render time,
// 2) writing the exact result to content_namumark_* columns instead of the
//    immutable captured-source render columns.

const nativeFetch = globalThis.fetch.bind(globalThis);
const targetTitle = decodeURIComponent(process.argv[2] || "RESCENE").normalize("NFKC").trim();
let targetRevisionNo = 0;

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function requestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input?.url || "";
}

function requestMethod(input, init) {
  return String(init?.method || input?.method || "GET").toUpperCase();
}

function responseWithJson(value, original) {
  const headers = new Headers(original.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Response(JSON.stringify(value), {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}

function withContentColumns(rawUrl) {
  const url = new URL(rawUrl);
  const select = String(url.searchParams.get("select") || "");
  if (!select) return url.toString();
  const fields = new Set(select.split(",").map((item) => item.trim()).filter(Boolean));
  fields.add("content_wikitext");
  fields.add("content_revision_no");
  fields.add("content_language");
  url.searchParams.set("select", [...fields].join(","));
  return url.toString();
}

function replaceInputUrl(input, nextUrl) {
  if (typeof input === "string" || input instanceof URL) return nextUrl;
  return new Request(nextUrl, input);
}

globalThis.fetch = async (input, init = undefined) => {
  const url = requestUrl(input);
  const method = requestMethod(input, init);

  const isRawDocumentLoad = method === "GET"
    && url.includes("/rest/v1/source_documents?")
    && url.includes("source=eq.namu_mirror")
    && url.includes("source_wikitext=not.is.null");

  if (isRawDocumentLoad) {
    const nextUrl = withContentColumns(url);
    const response = await nativeFetch(replaceInputUrl(input, nextUrl), init);
    if (!response.ok) return response;
    const rows = await response.json();
    if (!Array.isArray(rows)) return responseWithJson(rows, response);

    const transformed = rows.map((row) => {
      const isTarget = normalizeTitle(row?.source_title) === normalizeTitle(targetTitle);
      const hasEditableContent = typeof row?.content_wikitext === "string" && row.content_wikitext.length > 0;
      if (isTarget) {
        targetRevisionNo = Number(row?.content_revision_no || 0) || 0;
        if (!hasEditableContent) {
          return { ...row, source_wikitext: null };
        }
      }

      return {
        ...row,
        source_wikitext: hasEditableContent ? row.content_wikitext : row.source_wikitext,
      };
    });

    return responseWithJson(transformed, response);
  }

  const isRenderSave = method === "PATCH" && url.includes("/rest/v1/source_documents?id=eq.");
  if (isRenderSave && typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body);
      if (typeof body.source_namumark_html === "string") {
        const renderedAt = body.source_namumark_rendered_at || new Date().toISOString();
        const contentMeta = body.source_namumark_meta && typeof body.source_namumark_meta === "object"
          ? {
              ...body.source_namumark_meta,
              editableContent: {
                revisionNo: targetRevisionNo,
                note: "Rendered from content_wikitext; captured source_wikitext and source_namumark_* remain unchanged.",
              },
            }
          : {
              editableContent: {
                revisionNo: targetRevisionNo,
                note: "Rendered from content_wikitext; captured source_wikitext and source_namumark_* remain unchanged.",
              },
            };

        const contentBody = {
          content_namumark_html: body.source_namumark_html,
          content_namumark_meta: contentMeta,
          content_namumark_engine: body.source_namumark_engine || "thetree-modern-namu-compat-content",
          content_namumark_engine_version: body.source_namumark_engine_version || null,
          content_namumark_rendered_at: renderedAt,
          content_status: "draft",
          updated_at: body.updated_at || renderedAt,
        };

        const response = await nativeFetch(input, { ...init, body: JSON.stringify(contentBody) });
        if (response.ok) {
          console.log(`EDITABLE CONTENT RENDER SAVED ${targetTitle} r${targetRevisionNo || "?"}`);
        }
        return response;
      }
    } catch {
      // Fall through unchanged if the base renderer changes its save payload.
    }
  }

  return nativeFetch(input, init);
};

process.env.KPOPARKIVE_RENDER_CONTENT = "1";
console.log(`Kpoparkive editable-content render: ${targetTitle}`);
await import("./namumark-thetree-compat-poc.mjs");
