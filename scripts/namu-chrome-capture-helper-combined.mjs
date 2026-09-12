import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = Number(process.env.NAMU_CAPTURE_PORT || 43117) || 43117;
const ASSET_WORKER_PORT = PORT + 1;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 40 * 1024 * 1024;
const MAX_RAW_SOURCE_BYTES = 4 * 1024 * 1024;
const DOCUMENT_CAPTURE_VERSION = "chrome-rendered-artifact-v3";

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

loadEnvFile(path.resolve(".env.local"));
loadEnvFile(path.resolve(".env"));

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_HOST = (() => {
  try { return new URL(SUPABASE_URL).host; } catch { return SUPABASE_URL; }
})();

if (!SERVICE_ROLE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY is missing in .env.local");
  process.exit(1);
}

function dbHeaders(extra = {}) {
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
    headers: { ...dbHeaders(), ...(init.headers || {}) },
  });
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": payload.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Kpoparkive-Meta",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error(`request exceeds ${(maxBytes / 1024 / 1024).toFixed(0)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function validateNamuPageUrl(value) {
  const url = new URL(String(value || ""));
  if (!/(^|\.)namu\.wiki$/i.test(url.hostname)) throw new Error("capture page is not namu.wiki");
  if (!/^\/w\//.test(url.pathname)) throw new Error("capture page is not a NamuWiki document");
  return url.toString();
}

function cleanInternalLinks(value) {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const item of value) {
    const title = String(item?.title || item || "").normalize("NFKC").trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    output.push({
      title,
      href: String(item?.href || `https://namu.wiki/w/${encodeURIComponent(title)}`).trim(),
      text: String(item?.text || "").replace(/\s+/g, " ").trim().slice(0, 240),
    });
    if (output.length >= 2000) break;
  }
  return output;
}

const stats = {
  documentsSaved: 0,
  documentsCreated: 0,
  documentErrors: 0,
  proxiedAssets: 0,
  proxyErrors: 0,
};

async function ensureSourceDocument({ rootTitle, sourceTitle, pageUrl, crawlDepth, internalLinks }) {
  const docs = await db(
    `source_documents?source=eq.namu_mirror` +
    `&root_title=eq.${encodeURIComponent(rootTitle)}` +
    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +
    `&select=id,source_title,root_title&limit=1`,
  );
  if (docs?.[0]?.id) return docs[0];

  const created = await db("source_documents", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      source: "namu_mirror",
      source_title: sourceTitle,
      source_url: pageUrl,
      root_title: rootTitle,
      crawl_depth: Math.max(0, Number(crawlDepth || 0) || 0),
      discovered_links: internalLinks,
      source_format: "browser_rendered",
      source_extraction_version: DOCUMENT_CAPTURE_VERSION,
    }),
  });
  const doc = created?.[0];
  if (!doc?.id) throw new Error(`Could not create source_document for ${sourceTitle}`);
  stats.documentsCreated += 1;
  console.log(`SOURCE DOCUMENT CREATED ${sourceTitle} under ${rootTitle}`);
  return doc;
}

async function saveRenderedDocument(payload) {
  const rootTitle = String(payload?.rootTitle || "").normalize("NFKC").trim();
  const sourceTitle = String(payload?.sourceTitle || "").normalize("NFKC").trim();
  const articleHtml = String(payload?.articleHtml || "");
  const styleCss = String(payload?.styleCss || "");
  const pageUrl = validateNamuPageUrl(payload?.pageUrl);
  const captureVersion = String(payload?.captureVersion || DOCUMENT_CAPTURE_VERSION).trim() || DOCUMENT_CAPTURE_VERSION;
  const crawlDepth = Math.max(0, Number(payload?.meta?.crawlDepth || 0) || 0);
  const internalLinks = cleanInternalLinks(payload?.meta?.internalLinks);

  if (!rootTitle || !sourceTitle) throw new Error("document capture is missing rootTitle/sourceTitle");
  if (articleHtml.length < 200) throw new Error("rendered article HTML is unexpectedly small");
  if (!/data-kpop-capture-root=["']true["']/i.test(articleHtml) && !/<(?:article|main)\b/i.test(articleHtml)) {
    throw new Error("rendered capture does not contain a trusted captured content root");
  }
  if (captureVersion !== DOCUMENT_CAPTURE_VERSION) throw new Error(`capture version mismatch: expected ${DOCUMENT_CAPTURE_VERSION}, got ${captureVersion}`);

  const doc = await ensureSourceDocument({ rootTitle, sourceTitle, pageUrl, crawlDepth, internalLinks });

  const capturedAt = new Date().toISOString();
  const articleBytes = Buffer.byteLength(articleHtml, "utf8");
  const styleBytes = Buffer.byteLength(styleCss, "utf8");
  const meta = {
    ...(payload?.meta && typeof payload.meta === "object" ? payload.meta : {}),
    page_url: pageUrl,
    page_title: String(payload?.pageTitle || ""),
    article_bytes: articleBytes,
    style_bytes: styleBytes,
    crawlDepth,
    internalLinkCount: internalLinks.length,
    captured_by: "normal-chrome-extension",
    presentation_mode: "final-dom-plus-computed-layout",
  };

  await db(`source_documents?id=eq.${encodeURIComponent(doc.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_url: pageUrl,
      crawl_depth: crawlDepth,
      discovered_links: internalLinks,
      source_browser_article_html: articleHtml,
      source_browser_style_css: styleCss || null,
      source_browser_capture_meta: meta,
      source_browser_capture_version: captureVersion,
      source_browser_captured_at: capturedAt,
      updated_at: capturedAt,
    }),
  });

  stats.documentsSaved += 1;
  console.log(`BROWSER ARTIFACT SAVED ${sourceTitle} -> HTML ${(articleBytes / 1024).toFixed(1)} KB + CSS ${(styleBytes / 1024).toFixed(1)} KB + ${internalLinks.length} links`);
  return {
    ok: true,
    status: "saved",
    sourceTitle,
    rootTitle,
    captureVersion,
    capturedAt,
    articleBytes,
    styleBytes,
    nodeCount: Number(meta.nodeCount || 0),
    styledNodes: Number(meta.styledNodes || 0),
    pseudoRuleCount: Number(meta.pseudoRuleCount || 0),
    imageCount: Number(meta.imageCount || 0),
    tableCount: Number(meta.tableCount || 0),
    internalLinkCount: internalLinks.length,
  };
}

async function saveRawSource(payload) {
  const rootTitle = String(payload?.rootTitle || payload?.sourceTitle || "").normalize("NFKC").trim();
  const sourceTitle = String(payload?.sourceTitle || "").normalize("NFKC").trim();
  const pageUrl = validateNamuPageUrl(payload?.pageUrl);
  const raw = String(payload?.raw || "").replace(/\r\n?/g, "\n").replace(/^\uFEFF/, "").trim();
  const internalLinks = cleanInternalLinks(payload?.internalLinks);

  if (!rootTitle || !sourceTitle) throw new Error("raw source capture is missing rootTitle/sourceTitle");
  const signals = [
    /\[\[[^\]]+\]\]/,
    /^={1,6}[^=\n].*={1,6}$/m,
    /^\|\|/m,
    /\[include\(/i,
    /\{\{\{#!/,
  ].filter((pattern) => pattern.test(raw)).length;
  const isTemplate = /^틀:/i.test(sourceTitle);
  const trustedEditor = Boolean(payload?.trustedEditor);
  const validTemplate = isTemplate && (
    (trustedEditor && raw.length >= 1) ||
    (raw.length >= 20 && signals >= 1)
  );
  const validDocument = !isTemplate && raw.length >= 200 && signals >= 2;
  if (!validTemplate && !validDocument) {
    throw new Error(
      `captured raw source does not look like complete NamuMark (${raw.length} chars, ${signals} signals, trustedSource=${trustedEditor})`
    );
  }

  const doc = await ensureSourceDocument({ rootTitle, sourceTitle, pageUrl, crawlDepth: 0, internalLinks: [] });
  const capturedAt = new Date().toISOString();
  const isOperationalTemplate = /^틀:\s*접근\s*제한(?:$|\/)/i.test(sourceTitle);
  const shouldTranslate =
    !isOperationalTemplate &&
    (
      payload?.translate === true ||
      rootTitle === sourceTitle ||
      isTemplate ||
      process.env.KPOPARKIVE_TRANSLATE_RELATED === "1"
    );

  // Browser retries may POST the exact same canonical RAW multiple times.
  // Do not advance raw_extracted_at or reset translation_status unless the
  // source text actually changed, otherwise the render watcher sees a false
  // "RAW newer than render" condition and loops forever.
  const existingRows = await db(
    `source_documents?id=eq.${encodeURIComponent(doc.id)}` +
    "&select=source_wikitext,source_format,source_extraction_version,raw_extracted_at,translation_status&limit=1",
  );
  const existing = existingRows?.[0] || null;
  const existingRaw = typeof existing?.source_wikitext === "string"
    ? existing.source_wikitext.replace(/\\r\\n?/g, "\\n").replace(/^\\uFEFF/, "").trim()
    : "";
  const bytes = Buffer.byteLength(raw, "utf8");

  if (existingRaw && existingRaw === raw) {
    const canonicalExtractionVersion = String(payload?.extractionMethod || "").startsWith("normal-chrome-raw-page:")
      ? "normal-chrome-raw-view-v1"
      : "normal-chrome-edit-source-v1";
    const provenanceNeedsUpgrade =
      existing?.source_format !== "namuwiki_raw" ||
      existing?.source_extraction_version !== canonicalExtractionVersion;

    if (provenanceNeedsUpgrade) {
      await db(`source_documents?id=eq.${encodeURIComponent(doc.id)}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          source_format: "namuwiki_raw",
          source_extraction_version: canonicalExtractionVersion,
          raw_extracted_at: capturedAt,
          discovered_links: internalLinks,
          translation_status: shouldTranslate ? "pending_chatgpt" : (existing?.translation_status || "ready"),
          translation_version: shouldTranslate ? "chatgpt-en-v1" : null,
          updated_at: capturedAt,
        }),
      });
      await kpopMarkRawRequirementCaptured(doc, rootTitle, sourceTitle, capturedAt);
      console.log(`RAW SOURCE VERIFIED ${sourceTitle} -> canonical provenance upgraded without changing source text`);
      return {
        ok: true,
        status: "verified",
        sourceTitle,
        rootTitle,
        charCount: raw.length,
        bytes,
        capturedAt,
        sourceFormat: "namuwiki_raw",
        internalLinkCount: internalLinks.length,
        translation: shouldTranslate ? "pending_chatgpt" : (existing?.translation_status || "ready"),
      };
    }

    await kpopMarkRawRequirementCaptured(doc, rootTitle, sourceTitle, existing?.raw_extracted_at || capturedAt);
    console.log(`RAW SOURCE UNCHANGED ${sourceTitle} -> ${(bytes / 1024).toFixed(1)} KB; keeping raw_extracted_at/status`);
    return {
      ok: true,
      status: "unchanged",
      sourceTitle,
      rootTitle,
      charCount: raw.length,
      bytes,
      capturedAt: existing?.raw_extracted_at || null,
      sourceFormat: "namuwiki_raw",
      internalLinkCount: internalLinks.length,
      translation: existing?.translation_status || (shouldTranslate ? "pending_chatgpt" : "ready"),
    };
  }

  await db(`source_documents?id=eq.${encodeURIComponent(doc.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_wikitext: raw,
      source_format: "namuwiki_raw",
      source_extraction_version: String(payload?.extractionMethod || "").startsWith("normal-chrome-raw-page:")
        ? "normal-chrome-raw-view-v1"
        : "normal-chrome-edit-source-v1",
      raw_extracted_at: capturedAt,
      discovered_links: internalLinks,
      translation_status: shouldTranslate ? "pending_chatgpt" : "ready",
      translation_version: shouldTranslate ? "chatgpt-en-v1" : null,
      updated_at: capturedAt,
    }),
  });

  await kpopMarkRawRequirementCaptured(doc, rootTitle, sourceTitle, capturedAt);
  console.log(`RAW SOURCE SAVED ${sourceTitle} -> ${(bytes / 1024).toFixed(1)} KB via ${String(payload?.extractionMethod || "normal-chrome-edit")}`);
  if (shouldTranslate) {
    console.log(`CHATGPT TRANSLATION PENDING ${sourceTitle}`);
  }

  return {
    ok: true,
    sourceTitle,
    rootTitle,
    charCount: raw.length,
    bytes,
    capturedAt,
    sourceFormat: "namuwiki_raw",
    internalLinkCount: internalLinks.length,
    translation: shouldTranslate ? "pending_chatgpt" : "skipped-related",
  };
}

async function clusterDocuments(rootTitle) {
  const title = String(rootTitle || "").normalize("NFKC").trim();
  if (!title) throw new Error("rootTitle is required");
  return db(
    `source_documents?source=eq.namu_mirror&root_title=eq.${encodeURIComponent(title)}` +
    `&select=source_title,source_url,crawl_depth,source_browser_captured_at` +
    `&order=crawl_depth.asc,source_title.asc&limit=500`,
  );
}

async function documentStatus(rootTitle, sourceTitle) {
  const rows = await db(
    `source_documents?source=eq.namu_mirror` +
    `&root_title=eq.${encodeURIComponent(rootTitle)}` +
    `&source_title=eq.${encodeURIComponent(sourceTitle)}` +
    `&select=id,source_browser_captured_at,source_browser_capture_version&limit=1`,
  );
  const row = rows?.[0] || null;
  return {
    exists: Boolean(row),
    captured: Boolean(row?.source_browser_captured_at),
    capturedAt: row?.source_browser_captured_at || null,
    captureVersion: row?.source_browser_capture_version || null,
  };
}

async function invalidateSourceRender(sourceTitle) {
  const title = String(sourceTitle || "").normalize("NFKC").trim();
  if (!title) throw new Error("sourceTitle is required");
  const rows = await db(
    `source_documents?source=eq.namu_mirror&source_title=eq.${encodeURIComponent(title)}&select=id&limit=1`,
  );
  const row = rows?.[0] || null;
  if (!row?.id) throw new Error(`source document not found for render invalidation: ${title}`);

  const invalidatedAt = new Date().toISOString();
  await db(`source_documents?id=eq.${encodeURIComponent(row.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_namumark_html: null,
      source_namumark_meta: null,
      source_namumark_engine: null,
      source_namumark_engine_version: null,
      source_namumark_rendered_at: null,
      updated_at: invalidatedAt,
    }),
  });
  console.log(`SOURCE RENDER INVALIDATED ${title} -> dependency refresh`);
  return { ok: true, sourceTitle: title, invalidatedAt };
}

async function rawSourceStatus(sourceTitle) {
  const title = String(sourceTitle || "").normalize("NFKC").trim();
  if (!title) throw new Error("sourceTitle is required");
  const rows = await db(
    `source_documents?source=eq.namu_mirror` +
    `&source_title=eq.${encodeURIComponent(title)}` +
    `&source_wikitext=not.is.null&raw_extracted_at=not.is.null` +
    `&select=id,source_title,root_title,source_wikitext,source_format,source_extraction_version,raw_extracted_at,translation_status,source_namumark_rendered_at,source_namumark_html,source_namumark_meta` +
    `&order=raw_extracted_at.desc.nullslast&limit=1`,
  );
  const row = rows?.[0] || null;
  return {
    exists: Boolean(row),
    rawCaptured: Boolean(row?.source_wikitext && row?.raw_extracted_at && row?.source_format === "namuwiki_raw" && /^normal-chrome-(?:raw-view|edit-source)-v1$/.test(String(row?.source_extraction_version || ""))),
    rawExtractedAt: row?.raw_extracted_at || null,
    sourceRenderedAt: row?.source_namumark_rendered_at || null,
    sourceRendered: Boolean(row?.source_namumark_html && row?.source_namumark_rendered_at),
    translationStatus: row?.translation_status || null,
    renderMeta: row?.source_namumark_meta || null,
    missingFiles: Array.isArray(row?.source_namumark_meta?.missingFiles) ? row.source_namumark_meta.missingFiles : [],
    missingTemplates: Array.isArray(row?.source_namumark_meta?.missingTemplates) ? row.source_namumark_meta.missingTemplates : [],
    raw: row?.source_wikitext || null,
  };
}


const RAW_REQUIREMENT_DETECTOR_VERSION = "raw-required-v3";

function kpopCanonicalRawCaptured(row) {
  return Boolean(
    row?.source_wikitext &&
    row?.raw_extracted_at &&
    row?.source_format === "namuwiki_raw" &&
    /^normal-chrome-(?:raw-view|edit-source)-v1$/.test(String(row?.source_extraction_version || ""))
  );
}

function kpopRawRequirementRelationRank(value) {
  const relation = String(value || "");
  if (relation === "subdocument") return 5;
  if (relation === "member") return 4;
  if (relation === "core_kpop_document") return 3;
  if (relation === "related") return 2;
  return 1;
}

function kpopBuildInboundRelationMap(rows) {
  const known = new Set((rows || []).map((row) => String(row?.source_title || "").normalize("NFKC").trim()).filter(Boolean));
  const map = new Map();

  for (const row of rows || []) {
    const links = Array.isArray(row?.source_browser_capture_meta?.internalLinks)
      ? row.source_browser_capture_meta.internalLinks
      : [];
    for (const link of links) {
      const title = String(link?.title || "").normalize("NFKC").trim();
      if (!title || !known.has(title)) continue;
      const candidate = {
        relation: String(link?.relation || ""),
        crawlMode: String(link?.crawlMode || ""),
        priority: Number(link?.priority || 0) || 0,
        tocOrder: Number.isFinite(Number(link?.tocOrder)) ? Number(link.tocOrder) : null,
        sourceArea: String(link?.sourceArea || ""),
        sectionTitle: String(link?.sectionTitle || ""),
        crawlPolicyVersion: Number(link?.crawlPolicyVersion || 0) || 0,
      };
      const existing = map.get(title);
      if (
        !existing ||
        kpopRawRequirementRelationRank(candidate.relation) > kpopRawRequirementRelationRank(existing.relation) ||
        (
          kpopRawRequirementRelationRank(candidate.relation) === kpopRawRequirementRelationRank(existing.relation) &&
          candidate.priority > existing.priority
        )
      ) {
        map.set(title, candidate);
      }
    }
  }
  return map;
}


function kpopBuildDirectRootRelationMap(rootRow, rows) {
  const known = new Set(
    (rows || [])
      .map((row) => String(row?.source_title || "").normalize("NFKC").trim())
      .filter(Boolean)
  );
  const map = new Map();
  const links = Array.isArray(rootRow?.source_browser_capture_meta?.internalLinks)
    ? rootRow.source_browser_capture_meta.internalLinks
    : [];

  for (const link of links) {
    const title = String(link?.title || "").normalize("NFKC").trim();
    if (!title || !known.has(title)) continue;
    const candidate = {
      relation: String(link?.relation || ""),
      crawlMode: String(link?.crawlMode || ""),
      priority: Number(link?.priority || 0) || 0,
      tocOrder: Number.isFinite(Number(link?.tocOrder)) ? Number(link.tocOrder) : null,
      sourceArea: String(link?.sourceArea || ""),
      sectionTitle: String(link?.sectionTitle || ""),
      crawlPolicyVersion: Number(link?.crawlPolicyVersion || 0) || 0,
    };
    const existing = map.get(title);
    if (
      !existing ||
      kpopRawRequirementRelationRank(candidate.relation) > kpopRawRequirementRelationRank(existing.relation) ||
      (
        kpopRawRequirementRelationRank(candidate.relation) === kpopRawRequirementRelationRank(existing.relation) &&
        candidate.priority > existing.priority
      )
    ) {
      map.set(title, candidate);
    }
  }
  return map;
}

function kpopClassifyRawRequirement(row, rootTitle, fallbackRows, inbound, directRoot) {
  const sourceTitle = String(row?.source_title || "").normalize("NFKC").trim();
  const reasons = [];
  let score = 0;

  const isRoot = sourceTitle === rootTitle;
  const isDirectSubdocument = sourceTitle.startsWith(rootTitle + "/");
  const directRelation = String(directRoot?.relation || "");
  const directPolicyVersion = Number(directRoot?.crawlPolicyVersion || 0) || 0;
  const isExplicitTocDocument = directRelation === "toc_document";
  const legacyDirectSectionLeaf = Boolean(
    directPolicyVersion < 3 &&
    directRelation === "related" &&
    String(directRoot?.crawlMode || "") === "leaf" &&
    String(directRoot?.sourceArea || "") === "section" &&
    Number.isFinite(Number(directRoot?.tocOrder)) &&
    Number(directRoot.tocOrder) <= 20
  );

  const inTeamCoreScope = Boolean(
    isRoot ||
    isDirectSubdocument ||
    isExplicitTocDocument ||
    directRelation === "member" ||
    legacyDirectSectionLeaf
  );

  if (!inTeamCoreScope) {
    return {
      status: "ignored",
      score: 0,
      priority: 0,
      reasons: ["outside_team_core_scope"],
      rawCapturedAt: null,
    };
  }

  if (kpopCanonicalRawCaptured(row)) {
    return {
      status: "captured",
      score: 0,
      priority: 0,
      reasons: ["canonical_raw_present"],
      rawCapturedAt: row.raw_extracted_at || null,
    };
  }

  const depth = Math.max(0, Number(row?.crawl_depth || 0) || 0);
  const captureMeta = row?.source_browser_capture_meta && typeof row.source_browser_capture_meta === "object"
    ? row.source_browser_capture_meta
    : {};
  const fidelity = row?.source_fidelity_meta && typeof row.source_fidelity_meta === "object"
    ? row.source_fidelity_meta
    : {};
  const renderMeta = row?.source_namumark_meta && typeof row.source_namumark_meta === "object"
    ? row.source_namumark_meta
    : {};

  if (!row?.source_browser_captured_at) {
    reasons.push("browser_dom_missing");
    return {
      status: "review",
      score: 50,
      priority: isRoot ? 100 : isDirectSubdocument ? 85 : 60,
      reasons,
      rawCapturedAt: null,
    };
  }

  if (isRoot) {
    score += 100;
    reasons.push("root_canonical_anchor");
  }

  const promotionGate = fidelity?.promotionGate || fidelity?.promotion_gate || null;
  if (promotionGate?.eligible === false || String(fidelity?.visualPromotionEligible || "").toLowerCase() === "false") {
    score += 85;
    reasons.push("dom_promotion_blocked");
    if (promotionGate?.structuralLoss === true) reasons.push("dom_structural_loss");
    if (promotionGate?.interactiveLayout === true) reasons.push("interactive_layout");
  }

  const summary = fidelity?.summary && typeof fidelity.summary === "object" ? fidelity.summary : {};
  if (Number(summary?.leakedMarkerCount || 0) > 0) {
    score += 80;
    reasons.push("render_leaked_markers");
  }
  if (Number(summary?.tableGeometryMismatches || 0) >= 2) {
    score += 45;
    reasons.push("table_geometry_mismatch");
  }
  if (Number(summary?.unmatchedOriginalTables || 0) >= 4) {
    score += 40;
    reasons.push("unmatched_original_tables");
  }

  const missingTemplates = Array.isArray(renderMeta?.missingTemplates) ? renderMeta.missingTemplates.length : 0;
  const missingFiles = Array.isArray(renderMeta?.missingFiles) ? renderMeta.missingFiles.length : 0;
  if (renderMeta?.hasError === true || String(renderMeta?.hasError || "").toLowerCase() === "true") {
    score += 80;
    reasons.push("source_render_error");
  }
  if (missingTemplates > 0) {
    score += 70;
    reasons.push("source_render_missing_templates");
  }
  if (missingFiles > 0) {
    score += 25;
    reasons.push("source_render_missing_files");
  }

  for (const fallback of fallbackRows || []) {
    const gate = fallback?.recovery_meta?.promotionGate || null;
    const htmlOnly = fallback?.recovery_meta?.htmlFallbackRequired === true;
    const badGate = gate?.eligible === false;
    const unresolved = !["converted", "verified"].includes(String(fallback?.recovery_status || ""));
    if (badGate || htmlOnly) {
      score += 85;
      reasons.push("complex_template_fallback");
      if (gate?.structuralLoss === true) reasons.push("template_structural_loss");
      if (gate?.interactiveLayout === true) reasons.push("template_interactive_layout");
    } else if (unresolved) {
      score += 45;
      reasons.push("template_fallback_unverified");
    }
  }

  const tables = Number(captureMeta?.tableCount || captureMeta?.rootMetrics?.tables || 0) || 0;
  const headings = Number(captureMeta?.headingCount || captureMeta?.rootMetrics?.headings || 0) || 0;
  const articleBytes = Number(captureMeta?.article_bytes || captureMeta?.articleBytes || 0) || 0;
  const linkCount = Number(captureMeta?.internalLinkCount || 0) || 0;

  // Complexity alone never forces RAW. It only escalates otherwise-simple DOM
  // documents to REVIEW so humans do not spend verification time unnecessarily.
  if (tables >= 24) {
    score += 20;
    reasons.push("dense_tables");
  }
  if (headings >= 24) {
    score += 10;
    reasons.push("many_sections");
  }
  if (articleBytes >= 8 * 1024 * 1024) {
    score += 15;
    reasons.push("large_dom_capture");
  }
  if (linkCount >= 180) {
    score += 10;
    reasons.push("dense_link_graph");
  }

  let status = "ready";
  if (isRoot || score >= 80) status = "needs_raw";
  else if (score >= 40) status = "review";

  const relation = String(inbound?.relation || "");
  let priority = isRoot ? 100 : isDirectSubdocument ? 88 : depth <= 1 ? 72 : 45;
  if (relation === "subdocument") priority = Math.max(priority, 90);
  else if (relation === "member") priority = Math.max(priority, 86);
  else if (relation === "core_kpop_document") priority = Math.max(priority, 82);
  else if (String(inbound?.crawlMode || "") === "leaf") priority = Math.min(priority, 55);

  priority += Math.min(9, Math.floor(score / 20));

  return {
    status,
    score,
    priority,
    reasons: [...new Set(reasons)],
    rawCapturedAt: null,
  };
}

async function kpopListRawRequirements(rootTitle) {
  const title = String(rootTitle || "").normalize("NFKC").trim();
  if (!title) throw new Error("rootTitle is required");

  const rows = await db(
    "namu_raw_requirements?root_title=eq." + encodeURIComponent(title) +
    "&select=id,root_title,source_document_id,source_title,status,priority,score,reason_codes,detector_version,detected_at,raw_captured_at,updated_at" +
    "&order=priority.desc,source_title.asc&limit=500"
  );

  const items = Array.isArray(rows) ? rows : [];
  const counts = { captured: 0, needs_raw: 0, review: 0, ready: 0, ignored: 0 };
  for (const item of items) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  const next = items.find((item) => item.status === "needs_raw") || null;

  return {
    ok: true,
    rootTitle: title,
    detectorVersion: RAW_REQUIREMENT_DETECTOR_VERSION,
    counts,
    total: items.length,
    next,
    items,
  };
}

async function kpopPlanRawRequirements(rootTitle) {
  const title = String(rootTitle || "").normalize("NFKC").trim();
  if (!title) throw new Error("rootTitle is required");

  const rows = await db(
    "source_documents?source=eq.namu_mirror&root_title=eq." + encodeURIComponent(title) +
    "&select=id,source_title,root_title,crawl_depth,source_format,source_extraction_version,source_wikitext,raw_extracted_at,source_browser_captured_at,source_browser_capture_meta,source_fidelity_meta,source_namumark_meta,source_render_manifest" +
    "&order=crawl_depth.asc,source_title.asc&limit=500"
  );
  const docs = Array.isArray(rows) ? rows : [];
  if (!docs.length) return { ...(await kpopListRawRequirements(title)), planned: 0 };

  const docIds = new Set(docs.map((row) => String(row?.id || "")).filter(Boolean));
  const allFallbacks = await db(
    "template_dom_fallbacks?source_document_id=not.is.null" +
    "&select=source_document_id,template_title,recovery_status,translation_status,recovery_meta&limit=3000"
  );
  const fallbackMap = new Map();
  for (const row of Array.isArray(allFallbacks) ? allFallbacks : []) {
    const id = String(row?.source_document_id || "");
    if (!docIds.has(id)) continue;
    if (!fallbackMap.has(id)) fallbackMap.set(id, []);
    fallbackMap.get(id).push(row);
  }

  const existingQueue = await db(
    "namu_raw_requirements?root_title=eq." + encodeURIComponent(title) +
    "&select=source_title,status,reason_codes&limit=500"
  );
  const manuallyIgnored = new Set(
    (Array.isArray(existingQueue) ? existingQueue : [])
      .filter((row) =>
        row?.status === "ignored" &&
        Array.isArray(row?.reason_codes) &&
        row.reason_codes.includes("manual_ignore")
      )
      .map((row) => String(row?.source_title || ""))
  );

  const inboundMap = kpopBuildInboundRelationMap(docs);
  const rootRow = docs.find(
    (row) => String(row?.source_title || "").normalize("NFKC").trim() === title
  ) || null;
  const directRootMap = kpopBuildDirectRootRelationMap(rootRow, docs);
  const detectedAt = new Date().toISOString();
  const payload = docs.map((row) => {
    const sourceTitle = String(row?.source_title || "").normalize("NFKC").trim();
    const classified = kpopClassifyRawRequirement(
      row,
      title,
      fallbackMap.get(String(row?.id || "")) || [],
      inboundMap.get(sourceTitle) || null,
      directRootMap.get(sourceTitle) || null
    );
    const status = manuallyIgnored.has(sourceTitle) && classified.status !== "captured"
      ? "ignored"
      : classified.status;
    const reasonCodes = manuallyIgnored.has(sourceTitle) && classified.status !== "captured"
      ? ["manual_ignore"]
      : classified.reasons;
    return {
      root_title: title,
      source_document_id: row.id,
      source_title: sourceTitle,
      status,
      priority: classified.priority,
      score: classified.score,
      reason_codes: reasonCodes,
      detector_version: RAW_REQUIREMENT_DETECTOR_VERSION,
      detected_at: detectedAt,
      raw_captured_at: classified.rawCapturedAt,
      updated_at: detectedAt,
    };
  });

  if (payload.length) {
    await db("namu_raw_requirements?on_conflict=root_title,source_title", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(payload),
    });
  }

  const result = await kpopListRawRequirements(title);
  console.log(
    "RAW REQUIREMENTS PLANNED " + title +
    " -> captured=" + result.counts.captured +
    " needs_raw=" + result.counts.needs_raw +
    " review=" + result.counts.review +
    " ready=" + result.counts.ready +
    " ignored=" + result.counts.ignored
  );
  return { ...result, planned: payload.length };
}

async function kpopMarkRawRequirementCaptured(doc, rootTitle, sourceTitle, capturedAt) {
  if (!doc?.id || !rootTitle || !sourceTitle) return;
  const now = capturedAt || new Date().toISOString();
  try {
    await db("namu_raw_requirements?on_conflict=root_title,source_title", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify([{
        root_title: rootTitle,
        source_document_id: doc.id,
        source_title: sourceTitle,
        status: "captured",
        priority: 0,
        score: 0,
        reason_codes: ["canonical_raw_present"],
        detector_version: RAW_REQUIREMENT_DETECTOR_VERSION,
        detected_at: now,
        raw_captured_at: now,
        updated_at: now,
      }]),
    });
  } catch (error) {
    console.warn("RAW REQUIREMENT CAPTURE MARK FAILED " + sourceTitle + ": " + (error?.message || error));
  }
}

async function kpopIgnoreRawRequirement(rootTitle, sourceTitle) {
  const root = String(rootTitle || "").normalize("NFKC").trim();
  const source = String(sourceTitle || "").normalize("NFKC").trim();
  if (!root || !source) throw new Error("rootTitle/sourceTitle are required");
  await db(
    "namu_raw_requirements?root_title=eq." + encodeURIComponent(root) +
    "&source_title=eq." + encodeURIComponent(source),
    {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: "ignored",
        reason_codes: ["manual_ignore"],
        updated_at: new Date().toISOString(),
      }),
    }
  );
  return kpopListRawRequirements(root);
}

async function proxyAsset(req, res) {
  const body = await readBody(req, MAX_IMAGE_BYTES);
  let lastError = "asset worker unavailable";

  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(`http://${HOST}:${ASSET_WORKER_PORT}/asset`, {
        method: "POST",
        headers: {
          "Content-Type": req.headers["content-type"] || "application/octet-stream",
          "X-Kpoparkive-Meta": req.headers["x-kpoparkive-meta"] || "",
        },
        body,
      });
      const bytes = Buffer.from(await response.arrayBuffer());
      res.writeHead(response.status, {
        "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
        "Content-Length": bytes.length,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(bytes);
      stats.proxiedAssets += 1;
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  stats.proxyErrors += 1;
  throw new Error(lastError);
}

const assetWorker = spawn(process.execPath, [path.resolve("scripts/namu-chrome-capture-helper-v3.mjs")], {
  env: { ...process.env, NAMU_CAPTURE_PORT: String(ASSET_WORKER_PORT) },
  stdio: ["ignore", "inherit", "inherit"],
});

assetWorker.on("exit", (code, signal) => {
  if (code !== 0 && signal !== "SIGTERM" && signal !== "SIGINT") {
    console.error(`Asset worker exited unexpectedly (code=${code}, signal=${signal || "none"}).`);
  }
});

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, X-Kpoparkive-Meta",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      service: "kpoparkive-namu-chrome-capture-helper-v7",
      port: PORT,
      assetWorkerPort: ASSET_WORKER_PORT,
      supabaseHost: SUPABASE_HOST,
      documentCapture: DOCUMENT_CAPTURE_VERSION,
      recursiveClone: true,
      stats,
    });
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/cluster") {
      const docs = await clusterDocuments(url.searchParams.get("rootTitle"));
      json(res, 200, { ok: true, documents: docs || [] });
      return;
    }

    if (req.method === "GET" && url.pathname === "/document-status") {
      const rootTitle = String(url.searchParams.get("rootTitle") || "").trim();
      const sourceTitle = String(url.searchParams.get("sourceTitle") || "").trim();
      if (!rootTitle || !sourceTitle) throw new Error("rootTitle/sourceTitle are required");
      json(res, 200, { ok: true, ...(await documentStatus(rootTitle, sourceTitle)) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/raw-status") {
      const sourceTitle = String(url.searchParams.get("sourceTitle") || "").trim();
      if (!sourceTitle) throw new Error("sourceTitle is required");
      json(res, 200, { ok: true, ...(await rawSourceStatus(sourceTitle)) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/raw-needs") {
      const rootTitle = String(url.searchParams.get("rootTitle") || "").trim();
      json(res, 200, await kpopListRawRequirements(rootTitle));
      return;
    }

    if (req.method === "POST" && url.pathname === "/raw-needs/plan") {
      const bytes = await readBody(req, 64 * 1024);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8") || "{}"); }
      catch { throw new Error("raw-needs plan payload is not valid JSON"); }
      json(res, 200, await kpopPlanRawRequirements(payload?.rootTitle));
      return;
    }

    if (req.method === "POST" && url.pathname === "/raw-needs/ignore") {
      const bytes = await readBody(req, 64 * 1024);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8") || "{}"); }
      catch { throw new Error("raw-needs ignore payload is not valid JSON"); }
      json(res, 200, await kpopIgnoreRawRequirement(payload?.rootTitle, payload?.sourceTitle));
      return;
    }

    if (req.method === "POST" && url.pathname === "/invalidate-source-render") {
      const bytes = await readBody(req, 64 * 1024);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error("invalidate-source-render payload is not valid JSON"); }
      json(res, 200, await invalidateSourceRender(payload?.sourceTitle));
      return;
    }

    if (req.method === "POST" && url.pathname === "/raw-source") {
      const bytes = await readBody(req, MAX_RAW_SOURCE_BYTES);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error("raw source payload is not valid JSON"); }
      json(res, 200, await saveRawSource(payload));
      return;
    }

    if (req.method === "POST" && url.pathname === "/document") {
      const bytes = await readBody(req, MAX_DOCUMENT_BYTES);
      let payload;
      try { payload = JSON.parse(bytes.toString("utf8")); }
      catch { throw new Error("document capture payload is not valid JSON"); }
      const result = await saveRenderedDocument(payload);
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/asset") {
      await proxyAsset(req, res);
      return;
    }

    json(res, 404, { ok: false, error: "not found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (url.pathname === "/document" || url.pathname === "/raw-source") stats.documentErrors += 1;
    else stats.proxyErrors += 1;
    console.error(`CAPTURE HELPER ERROR: ${message}`);
    json(res, 400, { ok: false, error: message });
  }
});

function shutdown() {
  try { assetWorker.kill("SIGTERM"); } catch {}
  try { server.close(); } catch {}
}

process.on("SIGINT", () => { shutdown(); process.exit(0); });
process.on("SIGTERM", () => { shutdown(); process.exit(0); });

server.listen(PORT, HOST, () => {
  console.log("Kpoparkive Namu Chrome capture helper v7 (recursive DOM clone + images)");
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Image worker proxy: http://${HOST}:${ASSET_WORKER_PORT}`);
  console.log(`Supabase: ${SUPABASE_HOST}`);
  console.log(`Artifact format: ${DOCUMENT_CAPTURE_VERSION}`);
  console.log("One browser capture can now create missing source_documents, persist internal-link graphs and support recursive cluster cloning.");
});