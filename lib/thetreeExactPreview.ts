import crypto from "node:crypto";
import { createRequire } from "node:module";
import { MessageChannel } from "node:worker_threads";

const SUPABASE_URL = (process.env.NEXT_PUBLIC_SUPABASE_URL || "https://hukrrzhltiyirtkxmotj.supabase.co").trim().replace(/\/$/, "");
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MAX_ROWS = 20000;

const config = {
  lang: "ko",
  namespaces: ["문서", "사용자", "파일", "틀", "분류", "나무위키", "특수기능", "휴지통", "투표"],
  localNamespaces: null,
  document_maximum_time: 30000,
};

type SourceRow = {
  id: string;
  source_title: string;
  root_title: string | null;
  source_wikitext: string | null;
  content_wikitext: string | null;
  content_status: string | null;
  source_namumark_html?: string | null;
};

type AssetRow = {
  source_ref: string;
  label: string | null;
  status: string;
  resolved_url: string | null;
  metadata: Record<string, unknown> | null;
};

type VirtualDocument = {
  uuid: string;
  namespace: string;
  title: string;
  contentExists: boolean;
  lastReadACL: number;
  backlinks: unknown[];
  categories: unknown[];
};

type VirtualRevision = {
  uuid: string;
  document: string;
  namespace: string;
  rev: number;
  content: string;
  fileKey?: string | null;
  videoFileKey?: string | null;
  fileWidth?: number;
  fileHeight?: number;
  fileSize?: number;
};

type VirtualWiki = {
  docs: VirtualDocument[];
  histories: VirtualRevision[];
  byFullTitle: Map<string, VirtualDocument>;
};

function normalizeTitle(value: unknown) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function effectiveSource(row: SourceRow) {
  if (row.content_status === "published" && row.content_wikitext) return row.content_wikitext;
  return row.source_wikitext || "";
}

function parseDocumentName(value: string) {
  const full = normalizeTitle(value).slice(0, 255);
  const colon = full.indexOf(":");
  if (colon > 0) {
    const maybeNamespace = full.slice(0, colon);
    if (config.namespaces.includes(maybeNamespace)) {
      return { namespace: maybeNamespace, title: full.slice(colon + 1) };
    }
  }
  return { namespace: "문서", title: full };
}

function fullTitle(doc: { namespace: string; title: string }) {
  return doc.namespace === "문서" ? doc.title : `${doc.namespace}:${doc.title}`;
}

function stableUuid(value: string) {
  const hex = crypto.createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function comparable(value: unknown) {
  return typeof value === "string" ? normalizeTitle(value) : value;
}

function equalComparable(left: unknown, right: unknown) {
  return comparable(left) === comparable(right);
}

function mongoMatch(value: unknown, condition: unknown) {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    const record = condition as Record<string, unknown>;
    if (Array.isArray(record.$in)) return record.$in.some((candidate) => equalComparable(value, candidate));
    if (Object.prototype.hasOwnProperty.call(record, "$eq")) return equalComparable(value, record.$eq);
  }
  return equalComparable(value, condition);
}

function objectMatches(value: Record<string, unknown>, query: Record<string, unknown> | null | undefined): boolean {
  if (!query || !Object.keys(query).length) return true;
  if (Array.isArray(query.$or) && !(query.$or as Record<string, unknown>[]).some((part) => objectMatches(value, part))) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") continue;
    if (!mongoMatch(value[key], condition)) return false;
  }
  return true;
}

function assetName(ref: string) {
  return normalizeTitle(ref).replace(/^(?:파일|File):/i, "");
}

function assetUrl(row: AssetRow) {
  if (row.status !== "resolved") return null;
  if (typeof row.resolved_url === "string" && row.resolved_url) return row.resolved_url;
  const enrichment = row.metadata?.enrichment_url;
  if (typeof enrichment === "string" && enrichment) return enrichment;
  return null;
}

function numberFromMeta(row: AssetRow, ...keys: string[]) {
  for (const key of keys) {
    const value = Number(row.metadata?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

async function db<T>(path: string): Promise<T> {
  if (!SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function dbAll<T>(path: string, pageSize = 1000, maxRows = MAX_ROWS): Promise<T[]> {
  const rows: T[] = [];
  const separator = path.includes("?") ? "&" : "?";
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db<T[]>(`${path}${separator}limit=${pageSize}&offset=${offset}`);
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`Supabase pagination reached ${maxRows} rows for ${path}`);
}

function normalizeWikiTitleFragment(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function normalizeFileLinkTargets(source: string) {
  return source.replace(/\[\[((?:파일|File):)([^\]|]+)(?=[\]|])/gi, (full, prefix, target) => {
    const normalized = normalizeWikiTitleFragment(target);
    return normalized && normalized !== target ? `[[${prefix}${normalized}` : full;
  });
}

function isSyntaxBearingLine(line: string) {
  return /(\|\||\{\{\{|\}\}\}|\[\[|\]\]|\[(?:include|Include)\(|#!|<[^>]+>|\[목차\]|\[clearfix\]|\[br\])/i.test(line);
}

function normalizeModernColorSyntax(line: string) {
  return line
    .replace(/\{\{\{#\s+([0-9A-Za-z])/g, (_full, first) => `{{{#${first}`)
    .replace(/,\s*#\s+([0-9A-Za-z])/g, (_full, first) => `,#${first}`);
}

function normalizeStructuralNbsp(source: string) {
  return source
    .split("\n")
    .map((line) => {
      if (!isSyntaxBearingLine(line)) return line;
      return normalizeModernColorSyntax(line.replace(/\u00a0/g, " "));
    })
    .join("\n");
}

function startsStructuralSyntax(line: string) {
  const text = String(line ?? "").trimStart();
  if (!text) return true;
  return /^(?:##|\{\{\{|\[\[|\[include\(|\|\||={1,6}(?:#)?\s|----(?:-|$)|>|\s*[1aAiI]\.\s|\s*\*\s)/i.test(text);
}

function delimiterBalance(text: string) {
  let square = 0;
  let round = 0;
  let braces = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith("{{{", i)) {
      braces += 1;
      i += 2;
      continue;
    }
    if (text.startsWith("}}}", i)) {
      braces = Math.max(0, braces - 1);
      i += 2;
      continue;
    }
    const ch = text[i];
    if (ch === "[") square += 1;
    else if (ch === "]") square = Math.max(0, square - 1);
    else if (ch === "(") round += 1;
    else if (ch === ")") round = Math.max(0, round - 1);
  }
  return { square, round, braces };
}

function stripModernCommentBlocks(lines: string[]) {
  const output: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("##")) {
      output.push(line);
      continue;
    }
    const body = trimmed.slice(2);
    const balance = delimiterBalance(body);
    const hasOpenStructure = balance.square > 0 || balance.round > 0 || balance.braces > 0;
    const wrappedProse = /\s$/.test(line);
    if (!hasOpenStructure && !wrappedProse) continue;

    let aggregate = body;
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trimStart().startsWith("##") || startsStructuralSyntax(next)) break;
      aggregate += `\n${next}`;
      i = j;
      const nextBalance = delimiterBalance(aggregate);
      const stillStructured = nextBalance.square > 0 || nextBalance.round > 0 || nextBalance.braces > 0;
      if (!stillStructured && !/\s$/.test(next)) break;
    }
  }
  return output;
}

function countUnescaped(text: string, needle: string) {
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== needle) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === "\\"; j -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

function wikiHeaderNeedsJoin(line: string) {
  const index = line.lastIndexOf("{{{#!wiki");
  if (index < 0) return false;
  return countUnescaped(line.slice(index), '"') % 2 === 1;
}

function ifHeaderNeedsJoin(line: string) {
  const index = line.lastIndexOf("{{{#!if");
  if (index < 0) return false;
  const expression = line.slice(index + "{{{#!if".length).trim();
  if (!expression) return true;
  const balance = delimiterBalance(expression);
  if (balance.round > 0 || balance.square > 0 || balance.braces > 0) return true;
  if (countUnescaped(expression, '"') % 2 === 1 || countUnescaped(expression, "'") % 2 === 1) return true;
  return /(?:&&|\|\||==|!=|<=|>=|[,+\-*/=])\s*$/.test(expression);
}

function joinMultilineDirectiveHeaders(lines: string[]) {
  const output: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let line = lines[i];
    const mode = wikiHeaderNeedsJoin(line) ? "wiki" : ifHeaderNeedsJoin(line) ? "if" : null;
    if (!mode) {
      output.push(line);
      continue;
    }
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (startsStructuralSyntax(next) && !/^\s*[#@]/.test(next)) break;
      line += next;
      i += 1;
      if (!(mode === "wiki" ? wikiHeaderNeedsJoin(line) : ifHeaderNeedsJoin(line))) break;
    }
    output.push(line);
  }
  return output;
}

function parseSimpleIncludeParams(raw: string) {
  const params = new Map<string, string>();
  for (const piece of raw.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 0) continue;
    const name = normalizeWikiTitleFragment(trimmed.slice(0, equals));
    const value = trimmed.slice(equals + 1).trim();
    if (name) params.set(name, value);
  }
  return params;
}

function expandMissingYouTubeIconIncludes(source: string) {
  return source.replace(
    /\[include\(\s*틀:유튜브\s+아이콘\s*((?:,[^\]\r\n]*)?)\)\]/gi,
    (full, rawParams) => {
      const params = parseSimpleIncludeParams(String(rawParams || ""));
      const link = String(params.get("링크") || "").trim();
      if (!link) return full;
      let href = "";
      if (/^https?:\/\//i.test(link)) href = link;
      else if (/^[A-Za-z0-9_-]{6,}$/.test(link)) href = `https://www.youtube.com/watch?v=${link}`;
      else return full;
      const requestedWidth = String(params.get("크기") || "22").trim();
      const width = /^\d{1,3}$/.test(requestedWidth) && Number(requestedWidth) > 0 ? requestedWidth : "22";
      return `[[${href}|[[파일:유튜브 아이콘.svg|width=${width}]]]]`;
    },
  );
}

function applyCompatibility(raw: string, expandYouTubeIcon: boolean) {
  const source = String(raw || "").replace(/\r\n?/g, "\n");
  const whitespaceNormalized = normalizeStructuralNbsp(source);
  const targetNormalized = normalizeFileLinkTargets(whitespaceNormalized);
  let lines = stripModernCommentBlocks(targetNormalized.split("\n"));
  lines = joinMultilineDirectiveHeaders(lines);
  let result = lines.join("\n");
  if (expandYouTubeIcon) result = expandMissingYouTubeIconIncludes(result);
  return result;
}

function makeVirtualWiki(rawRows: SourceRow[], assetRows: AssetRow[], targetTitle: string, targetSource: string): VirtualWiki {
  const docs: VirtualDocument[] = [];
  const histories: VirtualRevision[] = [];
  const byFullTitle = new Map<string, VirtualDocument>();
  const hasYouTubeIconTemplate = rawRows.some((row) => normalizeTitle(row.source_title).toLowerCase() === "틀:유튜브 아이콘");

  const ensureDoc = (name: string) => {
    const parsed = parseDocumentName(name);
    const key = fullTitle(parsed);
    const existing = byFullTitle.get(key);
    if (existing) return existing;
    const doc: VirtualDocument = {
      uuid: stableUuid(`doc:${key}`),
      namespace: parsed.namespace,
      title: parsed.title,
      contentExists: false,
      lastReadACL: 0,
      backlinks: [],
      categories: [],
    };
    docs.push(doc);
    byFullTitle.set(key, doc);
    return doc;
  };

  for (const row of rawRows) {
    if (!row.source_title) continue;
    let source = normalizeTitle(row.source_title) === normalizeTitle(targetTitle) ? targetSource : effectiveSource(row);
    if (!source) continue;
    source = applyCompatibility(source, !hasYouTubeIconTemplate);
    const doc = ensureDoc(row.source_title);
    doc.contentExists = true;
    histories.push({
      uuid: stableUuid(`rev:${fullTitle(doc)}:1`),
      document: doc.uuid,
      namespace: doc.namespace,
      rev: 1,
      content: source,
      fileKey: null,
      videoFileKey: null,
      fileWidth: 1,
      fileHeight: 1,
      fileSize: 0,
    });
  }

  for (const row of assetRows) {
    const name = assetName(row.source_ref || row.label || "");
    const url = assetUrl(row);
    if (!name || !url) continue;
    const doc = ensureDoc(`파일:${name}`);
    doc.contentExists = true;
    let rev = histories.find((item) => item.document === doc.uuid);
    if (!rev) {
      rev = {
        uuid: stableUuid(`rev:${fullTitle(doc)}:1`),
        document: doc.uuid,
        namespace: doc.namespace,
        rev: 1,
        content: "",
        videoFileKey: null,
      };
      histories.push(rev);
    }
    rev.fileKey = url;
    rev.fileWidth = numberFromMeta(row, "width", "naturalWidth", "image_width");
    rev.fileHeight = numberFromMeta(row, "height", "naturalHeight", "image_height");
    rev.fileSize = Number(row.metadata?.size || row.metadata?.bytes || 0) || 0;
  }

  return { docs, histories, byFullTitle };
}

function translation(key: string) {
  const known: Record<string, string> = {
    "namumark.toc_title": "목차",
    "namumark.heading_edit": "편집",
  };
  return known[key] || key;
}

let sourceCache: { expiresAt: number; rows: SourceRow[] } | null = null;
const assetCache = new Map<string, { expiresAt: number; rows: AssetRow[] }>();

async function getSourceRows() {
  if (sourceCache && sourceCache.expiresAt > Date.now()) return sourceCache.rows;
  const rows = await dbAll<SourceRow>(
    "source_documents?source=eq.namu_mirror&source_wikitext=not.is.null" +
      "&select=id,source_title,root_title,source_wikitext,content_wikitext,content_status,source_namumark_html&order=id.asc",
  );
  sourceCache = { expiresAt: Date.now() + 60_000, rows };
  return rows;
}

async function getAssetRows(rootTitle: string) {
  const key = normalizeTitle(rootTitle);
  const cached = assetCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  const rows = await dbAll<AssetRow>(
    `source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image` +
      "&select=source_ref,label,status,resolved_url,metadata&order=id.asc",
  );
  assetCache.set(key, { expiresAt: Date.now() + 60_000, rows });
  return rows;
}

export async function renderExactNamuPreview(title: string, source: string) {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle) throw new Error("title is required");
  if (!source.trim()) throw new Error("source is empty");

  const rawRows = await getSourceRows();
  const target = rawRows.find((row) => normalizeTitle(row.source_title) === normalizedTitle);
  if (!target) throw new Error(`No source document for ${title}`);

  const assetRows = await getAssetRows(target.root_title || normalizedTitle);
  const virtualWiki = makeVirtualWiki(rawRows, assetRows, normalizedTitle, source);
  const targetDoc = virtualWiki.byFullTitle.get(fullTitle(parseDocumentName(normalizedTitle)));
  const targetRev = virtualWiki.histories.find((item) => item.document === targetDoc?.uuid);
  if (!targetDoc || !targetRev) throw new Error(`Virtual The Tree document was not built for ${title}`);

  const require = createRequire(import.meta.url);
  (globalThis as typeof globalThis & { config?: typeof config }).config = config;
  const parser = require("thetree/utils/namumark/parser") as (source: string) => unknown;
  const Piscina = require("piscina") as typeof import("piscina");
  const workerPath = require.resolve("thetree/utils/namumark/toHtmlWorker");

  process.env.S3_PUBLIC_HOST = process.env.S3_PUBLIC_HOST || "https://invalid.local/";
  process.env.S3_PUBLIC_HOST_PREFIX = "";

  const parsed = parser(targetRev.content);
  const pool = new Piscina({
    filename: workerPath,
    workerData: { config, macroPluginPaths: [] },
    minThreads: 1,
    maxThreads: 1,
  });

  const channel = new MessageChannel();
  channel.port2.on("message", (msg: { id: string | number; type: string; model?: string; action?: string; data?: Record<string, unknown>; sort?: { rev?: number }; getOptions?: unknown[]; checkOptions?: unknown[]; key?: string }) => {
    const reply = (result: unknown) => channel.port2.postMessage({ id: msg.id, result });
    try {
      if (msg.type === "db") {
        const query = msg.data || {};
        if (msg.model === "Document") {
          const result = virtualWiki.docs.filter((doc) => objectMatches(doc as unknown as Record<string, unknown>, query));
          if (msg.action === "countDocuments") return reply(result.length);
          return reply(result);
        }
        if (msg.model === "History") {
          let result = virtualWiki.histories.filter((rev) => objectMatches(rev as unknown as Record<string, unknown>, query));
          if (msg.sort?.rev) result = result.sort((a, b) => msg.sort!.rev! < 0 ? b.rev - a.rev : a.rev - b.rev);
          if (msg.action === "countDocuments") return reply(result.length);
          return reply(result);
        }
        return reply(msg.action === "countDocuments" ? 0 : []);
      }
      if (msg.type === "aclCheck") return reply({ result: true });
      if (msg.type === "t") return reply(translation(msg.key || ""));
      return reply(null);
    } catch {
      return reply(null);
    }
  });

  const options = {
    document: { namespace: targetDoc.namespace, title: targetDoc.title },
    originalDocument: { namespace: targetDoc.namespace, title: targetDoc.title },
    dbDocument: targetDoc,
    rev: targetRev,
    aclData: {},
    config,
    port: channel.port1,
    isInternal: false,
  };

  const started = performance.now();
  let result: Record<string, unknown>;
  try {
    result = await pool.run([parsed, options], { transferList: [channel.port1] }) as Record<string, unknown>;
  } finally {
    await pool.destroy();
    channel.port2.close();
  }

  const html = String(result.html || "");
  if (html.length < 100) throw new Error(`The Tree returned only ${html.length} chars of HTML`);

  return {
    html,
    renderMs: Math.round(performance.now() - started),
    hasError: Boolean(result.hasError),
    errorCode: result.errorCode ? String(result.errorCode) : null,
    links: Array.isArray(result.links) ? result.links.length : 0,
    files: Array.isArray(result.files) ? result.files.length : 0,
    headings: Array.isArray(result.headings) ? result.headings.length : 0,
  };
}

export async function currentExactSourceHtml(title: string) {
  const rows = await getSourceRows();
  const target = rows.find((row) => normalizeTitle(row.source_title) === normalizeTitle(title));
  return target?.source_namumark_html || null;
}

export function hashHtml(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
