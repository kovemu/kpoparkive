import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { MessageChannel } from "node:worker_threads";

const { parse: parseHtml } = createRequire(import.meta.url)("node-html-parser");

const ROOT_DIR = process.cwd();
const THETREE_REPO = "https://github.com/wjdgustn/thetree.git";
const THETREE_COMMIT = "7435e93e4d695e666aee5eddbabf68533f7b7b21";
const ENGINE_NAME = "thetree-unmodified-render-poc";
const CACHE_DIR = path.resolve(ROOT_DIR, ".cache", "thetree-render-poc");
const ENGINE_PATCHSET = String(process.env.KPOPARKIVE_THETREE_PATCHSET || "").trim();
const title = decodeURIComponent(process.argv[2] || "RESCENE").normalize("NFKC").trim();

function loadEnv(filePath) {
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

loadEnv(path.join(ROOT_DIR, ".env.local"));
loadEnv(path.join(ROOT_DIR, ".env"));

const SUPABASE_URL = String(process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/$/, "");
const SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) throw new Error("Supabase env is missing");

function quoteWindowsCmdArg(value) {
  const text = String(value);
  if (!/[\s"&|<>^()%!]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function run(command, args, cwd = ROOT_DIR) {
  let executable = command;
  let finalArgs = args;
  if (process.platform === "win32" && ["npm", "npx"].includes(command)) {
    executable = process.env.ComSpec || "cmd.exe";
    finalArgs = ["/d", "/s", "/c", `${command}.cmd ${args.map(quoteWindowsCmdArg).join(" ")}`];
  }
  const result = spawnSync(executable, finalArgs, { cwd, stdio: "inherit", env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
}

function whitespaceFlexiblePattern(value) {
  const parts = String(value).split(/\s+/).filter(Boolean).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join("\\s+"));
}

function patchEngineFile(relativePath, before, after, label) {
  const filePath = path.join(CACHE_DIR, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  if (source.includes(after)) return label;
  if (source.includes(before)) {
    fs.writeFileSync(filePath, source.replace(before, after), "utf8");
    return label;
  }

  const flexiblePattern = whitespaceFlexiblePattern(before);
  if (!flexiblePattern.test(source)) throw new Error(`The Tree patch target changed: ${label} (${relativePath})`);
  fs.writeFileSync(filePath, source.replace(flexiblePattern, after), "utf8");
  return label;
}

function applyModernNamuEnginePatches() {
  if (!ENGINE_PATCHSET) return [];
  const applied = [];

  applied.push(patchEngineFile(
    "utils/namumark/utils/index.js",
    `if(![\n                            'table',\n                            'tbody',\n                            'tr',\n                            'td'\n                        ].includes(node.name))`,
    `if(![\n                            'a',\n                            'div',\n                            'span',\n                            'p',\n                            'strong',\n                            'em',\n                            'img',\n                            'details',\n                            'summary',\n                            'ul',\n                            'ol',\n                            'li',\n                            'table',\n                            'thead',\n                            'tbody',\n                            'tfoot',\n                            'tr',\n                            'th',\n                            'td'\n                        ].includes(node.name))`,
    "preserve safe type-qualified template CSS selectors",
  ));

  applied.push(patchEngineFile(
    "utils/namumark/syntax/table.js",
    "const tagStr = paramStr.slice(1, closeIndex);",
    `const tagStr = paramStr.slice(1, closeIndex)\n                    .replace(/\\u00a0/g, ' ')\n                    .replace(/=\\s+/g, '=')\n                    .replace(/,\\s+/g, ',')\n                    .trim();`,
    "treat NBSP as whitespace inside table parameter tokens",
  ));

  console.log(`Applied The Tree patchset ${ENGINE_PATCHSET}: ${applied.join("; ")}`);
  return applied;
}

function ensureEngine() {
  fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
  if (!fs.existsSync(path.join(CACHE_DIR, ".git"))) {
    run("git", ["clone", "--no-checkout", THETREE_REPO, CACHE_DIR]);
  }
  run("git", ["fetch", "--depth", "1", "origin", THETREE_COMMIT], CACHE_DIR);
  run("git", ["checkout", "--detach", "--force", THETREE_COMMIT], CACHE_DIR);

  if (!fs.existsSync(path.join(CACHE_DIR, "node_modules", "piscina"))) {
    console.log("Installing The Tree dependencies in .cache (first run only)...");
    run("npm", ["ci", "--no-audit", "--no-fund"], CACHE_DIR);
  }

  return applyModernNamuEnginePatches();
}

async function db(pathname, init = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...init,
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function dbAll(pathname, { pageSize = 1000, maxRows = 20000 } = {}) {
  const rows = [];
  const separator = pathname.includes("?") ? "&" : "?";
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const batch = await db(`${pathname}${separator}limit=${pageSize}&offset=${offset}`);
    if (!Array.isArray(batch)) throw new Error(`Expected array response while paging ${pathname}`);
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
  throw new Error(`Supabase pagination reached ${maxRows} rows for ${pathname}; raise maxRows deliberately before continuing`);
}

const config = {
  lang: "ko",
  namespaces: ["문서", "사용자", "파일", "틀", "분류", "나무위키", "특수기능", "휴지통", "투표"],
  localNamespaces: null,
  document_maximum_time: 30000,
};

function normalizeTitle(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\u00a0/g, " ")
    .replace(/[\u200b-\u200d\u2060\ufeff]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function parseDocumentName(value) {
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

function fullTitle(doc) {
  return doc.namespace === "문서" ? doc.title : `${doc.namespace}:${doc.title}`;
}

function stableUuid(value) {
  const hex = crypto.createHash("sha256").update(String(value)).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function comparable(value) {
  return typeof value === "string" ? normalizeTitle(value) : value;
}

function equalComparable(left, right) {
  return comparable(left) === comparable(right);
}

function mongoMatch(value, condition) {
  if (condition && typeof condition === "object" && !Array.isArray(condition)) {
    if (Array.isArray(condition.$in)) return condition.$in.some((candidate) => equalComparable(value, candidate));
    if (Object.prototype.hasOwnProperty.call(condition, "$eq")) return equalComparable(value, condition.$eq);
  }
  return equalComparable(value, condition);
}

function documentMatches(doc, query) {
  if (!query || !Object.keys(query).length) return true;
  if (Array.isArray(query.$or) && !query.$or.some((part) => documentMatches(doc, part))) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") continue;
    if (!mongoMatch(doc[key], condition)) return false;
  }
  return true;
}

function historyMatches(rev, query) {
  if (!query || !Object.keys(query).length) return true;
  if (Array.isArray(query.$or) && !query.$or.some((part) => historyMatches(rev, part))) return false;
  for (const [key, condition] of Object.entries(query)) {
    if (key === "$or") continue;
    if (!mongoMatch(rev[key], condition)) return false;
  }
  return true;
}

function assetName(ref) {
  return normalizeTitle(ref).replace(/^(?:파일|File):/i, "");
}

function canonicalAssetKey(ref) {
  return assetName(ref).replace(/[?#].*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function extractRawFileRefs(rawValue) {
  const refs = [];
  const seen = new Set();
  const re = /\[\[(?:파일|File):([^\]|]+)(?=[\]|])/gi;
  let match;
  while ((match = re.exec(String(rawValue || "")))) {
    const name = assetName(match[1]);
    const key = canonicalAssetKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    refs.push(name);
  }
  return refs;
}

function stagedAssetPublicUrl(row) {
  const storagePath = String(row?.storage_path || "").replace(/^\/+/, "");
  if (!storagePath) return "";
  return `${SUPABASE_URL}/storage/v1/object/public/wiki-media/${storagePath}`;
}

async function reconcileExactStagedAssets(target, renderSource, existingRows) {
  if (!target?.id) return existingRows || [];

  const output = [...(existingRows || [])];
  const resolvedKeys = new Set(
    output
      .filter((row) => row?.status === "resolved" && assetUrl(row))
      .map((row) => canonicalAssetKey(row?.source_ref || row?.label || ""))
      .filter(Boolean)
  );
  const needed = extractRawFileRefs(renderSource)
    .map((name) => ({ name, key: canonicalAssetKey(name) }))
    .filter((item) => item.key && !resolvedKeys.has(item.key));
  if (!needed.length) return output;

  const stagedRows = await dbAll(
    "namu_capture_staging?storage_path=not.is.null" +
      "&select=id,root_title,source_title,file_name,canonical_key,storage_path,content_type,byte_length,width,height,captured_at,metadata" +
      "&order=captured_at.desc",
  );
  const stagedByKey = new Map();
  for (const row of stagedRows || []) {
    const key = canonicalAssetKey(row?.canonical_key || row?.file_name || "");
    if (!key || stagedByKey.has(key)) continue;
    if (/^__anonymous__/i.test(String(row?.file_name || ""))) continue;
    stagedByKey.set(key, row);
  }

  for (const item of needed) {
    const staged = stagedByKey.get(item.key);
    if (!staged) continue;
    const resolvedUrl = stagedAssetPublicUrl(staged);
    if (!resolvedUrl) continue;

    const metadata = {
      ...(staged.metadata && typeof staged.metadata === "object" ? staged.metadata : {}),
      content_type: staged.content_type || null,
      bytes: Number(staged.byte_length || 0) || 0,
      width: Number(staged.width || 0) || 0,
      height: Number(staged.height || 0) || 0,
      resolved_from: "captured-dom-staging-exact",
      browser_capture_at: staged.captured_at || null,
      browser_match_method: "staging-canonical-key-exact",
    };

    const pseudo = {
      id: `staging:${staged.id}`,
      root_title: target.root_title || target.source_title,
      source_title: target.source_title,
      source_ref: `파일:${item.name}`,
      label: item.name,
      status: "resolved",
      resolved_url: resolvedUrl,
      storage_path: staged.storage_path,
      confidence: 0.999,
      metadata,
    };
    output.push(pseudo);
    resolvedKeys.add(item.key);

    // Persist the exact reconciliation so later documents/public hydration can
    // reuse the same storage-backed media without another browser capture.
    await db("source_asset_queue?on_conflict=source_document_id,asset_type,source_ref", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        source_document_id: target.id,
        root_title: target.root_title || target.source_title,
        source_title: target.source_title,
        asset_type: "image",
        source_ref: `파일:${item.name}`,
        label: item.name,
        provider: "browser-dom-staging",
        role: "inline",
        status: "resolved",
        resolved_url: resolvedUrl,
        storage_path: staged.storage_path,
        confidence: 0.999,
        metadata,
        updated_at: new Date().toISOString(),
      }),
    });

    console.log(`STAGED ASSET RECONCILED ${item.name} <- ${staged.storage_path}`);
  }

  return output;
}

function assetUrl(row) {
  if (row?.status !== "resolved") return null;
  if (typeof row.resolved_url === "string" && row.resolved_url) return row.resolved_url;
  if (typeof row.metadata?.enrichment_url === "string" && row.metadata.enrichment_url) return row.metadata.enrichment_url;
  return null;
}

function numberFromMeta(row, ...keys) {
  for (const key of keys) {
    const value = Number(row.metadata?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return 1;
}

function makeVirtualWiki(rawRows, assetRows) {
  const docs = [];
  const histories = [];
  const byFullTitle = new Map();

  const ensureDoc = (name) => {
    const parsed = parseDocumentName(name);
    const key = fullTitle(parsed);
    if (byFullTitle.has(key)) return byFullTitle.get(key);
    const doc = {
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

  for (const row of rawRows || []) {
    if (!row?.source_title || !row?.source_wikitext) continue;
    const doc = ensureDoc(row.source_title);
    doc.contentExists = true;
    histories.push({
      uuid: stableUuid(`rev:${fullTitle(doc)}:1`),
      document: doc.uuid,
      namespace: doc.namespace,
      rev: 1,
      content: String(row.source_wikitext),
      fileKey: null,
      videoFileKey: null,
      fileWidth: 1,
      fileHeight: 1,
      fileSize: 0,
    });
  }

  for (const row of assetRows || []) {
    const name = assetName(row?.source_ref || row?.label || "");
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

function translation(key) {
  const language = String(process.env.KPOPARKIVE_RENDER_LANGUAGE || "ko").toLowerCase();
  const known = language === "en"
    ? {
        "namumark.toc_title": "Contents",
        "namumark.heading_edit": "Edit",
      }
    : {
        "namumark.toc_title": "목차",
        "namumark.heading_edit": "편집",
      };
  return known[key] || key;
}

function extractIncludeTitles(rawValue) {
  const raw = String(rawValue || "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*##/.test(line))
    .join("\n");
  const lower = raw.toLowerCase();
  const output = [];
  const seen = new Set();
  let cursor = 0;

  while (cursor < raw.length) {
    const start = lower.indexOf("[include(", cursor);
    if (start < 0) break;

    let depth = 0;
    let comma = -1;
    let end = -1;
    for (let i = start + 9; i < raw.length; i += 1) {
      const ch = raw[i];
      if (ch === "(") { depth += 1; continue; }
      if (ch === ")") {
        if (depth > 0) { depth -= 1; continue; }
        if (raw[i + 1] === "]") { end = i; break; }
      }
      if (ch === "," && depth === 0 && comma < 0) comma = i;
    }

    if (end < 0) break;
    const nameEnd = comma >= 0 && comma < end ? comma : end;
    const title = normalizeTitle(raw.slice(start + 9, nameEnd));
    if (title && !seen.has(title)) {
      seen.add(title);
      output.push(title);
    }
    cursor = end + 2;
  }

  return output;
}

function findIncludeRanges(rawValue) {
  const raw = String(rawValue || "");
  const lines = raw.split(/\r?\n/);
  const output = [];
  let absolute = 0;
  for (const line of lines) {
    if (!/^\s*##/.test(line)) {
      const lower = line.toLowerCase();
      let cursor = 0;
      while (cursor < line.length) {
        const start = lower.indexOf("[include(", cursor);
        if (start < 0) break;
        let depth = 0;
        let comma = -1;
        let end = -1;
        for (let i = start + 9; i < line.length; i += 1) {
          const ch = line[i];
          if (ch === "(") { depth += 1; continue; }
          if (ch === ")") {
            if (depth > 0) { depth -= 1; continue; }
            if (line[i + 1] === "]") { end = i + 2; break; }
          }
          if (ch === "," && depth === 0 && comma < 0) comma = i;
        }
        if (end < 0) break;
        const nameEnd = comma >= 0 ? comma : end - 2;
        const title = normalizeTitle(line.slice(start + 9, nameEnd));
        output.push({ title, start: absolute + start, end: absolute + end, source: line.slice(start, end) });
        cursor = end;
      }
    }
    absolute += line.length + 1;
  }
  return output;
}

function plainTemplateLabel(templateTitle) {
  return normalizeTitle(templateTitle).replace(/^틀:/i, "");
}

function templateLabelVariants(templateTitle) {
  const full = plainTemplateLabel(templateTitle);
  const values = [full];
  const withoutQualifier = full.replace(/\s*\([^()]{1,80}\)\s*$/u, "").trim();
  if (withoutQualifier && withoutQualifier !== full) values.push(withoutQualifier);
  return [...new Set(values.filter((value) => value.length >= 2))];
}

function internalWikiTitleFromHref(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://namu.wiki");
    const match = url.pathname.match(/^\/w\/(.+)$/i);
    if (!match?.[1] || url.hash) return "";
    let decoded = match[1];
    try { decoded = decodeURIComponent(decoded); } catch {}
    return normalizeTitle(decoded);
  } catch {
    return "";
  }
}

function normalizeVisibleText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function sanitizeDomFallbackElement(element) {
  const clone = parseHtml(element.toString(), { comment: false });
  for (const node of clone.querySelectorAll("*")) {
    for (const name of Object.keys(node.attributes || {})) {
      if (/^data-kpop-/i.test(name) || /^data-v-/i.test(name)) node.removeAttribute(name);
    }
  }
  return clone.toString();
}

function extractTemplateDomFallback(articleHtml, templateTitle) {
  const label = plainTemplateLabel(templateTitle);
  const labelVariants = templateLabelVariants(templateTitle);
  if (!label || label.length < 2 || !articleHtml) return null;

  let root;
  try { root = parseHtml(String(articleHtml), { comment: false }); }
  catch { return null; }

  const candidates = [];
  const seenHtml = new Set();
  const pushCandidate = (element, strategy, scoreBoost = 0, options = {}) => {
    if (!element) return;
    const html = element.toString();
    const maxBytes = Number(options.maxBytes || 600000) || 600000;
    if (html.length < 80 || html.length > maxBytes || seenHtml.has(html)) return;
    const text = normalizeVisibleText(element.innerText || element.text || "");
    if (!text) return;
    seenHtml.add(html);
    candidates.push({
      html,
      size: html.length,
      textLength: text.length,
      textPreview: text.slice(0, 180),
      strategy,
      scoreBoost,
      anchorOffset: Number.isFinite(options.anchorOffset) ? options.anchorOffset : null,
      selfLinkCount: Number(options.selfLinkCount || 0),
      tableCount: element.querySelectorAll?.("table")?.length || 0,
    });
  };

  // Original high-precision path: templates whose visible table text contains
  // the complete template label (e.g. 틀:원이 브랜드 평판).
  for (const table of root.querySelectorAll("table")) {
    const text = normalizeVisibleText(table.innerText || table.text || "");
    if (!text.includes(label)) continue;
    pushCandidate(table, "table-full-label", 1000);
  }

  // Navigation/profile templates commonly have a disambiguated title such as
  // 틀:리브(RESCENE), while the visible header only says "리브". Their outer
  // wrapper is usually a div containing a self-link plus one or more tab tables.
  // Find that self-link and climb to the smallest structural wrapper containing
  // both the link and rendered table content.
  if (!candidates.length) {
    const targetTitle = normalizeTitle(label);
    const shortLabel = labelVariants[labelVariants.length - 1] || targetTitle;
    for (const anchor of root.querySelectorAll("a[href]")) {
      if (internalWikiTitleFromHref(anchor.getAttribute("href")) !== targetTitle) continue;

      const anchorText = normalizeVisibleText(anchor.innerText || anchor.text || "") || shortLabel;
      let current = anchor;
      for (let depth = 0; current && depth < 12; depth += 1, current = current.parentNode) {
        const tag = String(current?.tagName || "").toLowerCase();
        if (!["div", "section", "article", "table"].includes(tag)) continue;

        const text = normalizeVisibleText(current.innerText || current.text || "");
        const hasLabel = labelVariants.some((variant) => text.includes(variant));
        const tableCount = current.querySelectorAll?.("table")?.length || 0;
        if (!hasLabel || tableCount < 1) continue;

        // Keep the fallback focused on the include output rather than selecting
        // the whole captured article around a self-link.
        if (text.length > 6000) continue;

        const anchorOffsetRaw = text.indexOf(anchorText);
        const anchorOffset = anchorOffsetRaw >= 0 ? anchorOffsetRaw : text.indexOf(shortLabel);
        const selfLinkCount = Array.from(current.querySelectorAll?.("a[href]") || [])
          .filter((item) => internalWikiTitleFromHref(item.getAttribute("href")) === targetTitle)
          .length;

        // A member/profile navigation template normally begins with its own
        // self-link ("리브 LIV ..."). A group template may also contain a link
        // to the member, but that link is buried among sibling members. Strongly
        // prefer wrappers where the self-link is at the beginning while still
        // allowing a small amount of decorative text before it.
        const frontScore =
          anchorOffset >= 0 && anchorOffset <= 1 ? 220 :
          anchorOffset >= 0 && anchorOffset <= 12 ? 90 :
          anchorOffset >= 0 && anchorOffset <= 40 ? 25 : 0;
        const compactScore =
          text.length <= 700 ? 90 :
          text.length <= 1600 ? 45 :
          text.length <= 3200 ? 10 : -20;
        const tableScore =
          tableCount <= 4 ? 28 :
          tableCount <= 8 ? 12 :
          -Math.min(80, (tableCount - 8) * 5);
        const selfLinkScore = selfLinkCount === 1 ? 12 : Math.max(-30, 12 - (selfLinkCount - 1) * 12);
        const score = 760 + frontScore + compactScore + tableScore + selfLinkScore - depth * 6;

        pushCandidate(current, "self-link-wrapper", score, {
          // Computed-style captures are verbose. Complex navigation templates
          // can exceed 600 KB even when their visible text is compact.
          maxBytes: 3 * 1024 * 1024,
          anchorOffset,
          selfLinkCount,
        });
      }
    }
  }

  // Last-resort table path for disambiguated labels: only use the shortened
  // visible label and prefer compact tables. This is deliberately lower
  // priority than a self-link wrapper to avoid grabbing the main infobox.
  if (!candidates.length && labelVariants.length > 1) {
    const shortLabel = labelVariants[labelVariants.length - 1];
    for (const table of root.querySelectorAll("table")) {
      const text = normalizeVisibleText(table.innerText || table.text || "");
      if (!text.includes(shortLabel)) continue;
      if (text.length > 3500) continue;
      pushCandidate(table, "table-short-label", 100);
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) =>
    b.scoreBoost - a.scoreBoost ||
    a.size - b.size ||
    a.textLength - b.textLength ||
    b.tableCount - a.tableCount
  );

  const picked = candidates[0];
  const parsed = parseHtml(picked.html, { comment: false });
  const element = parsed.firstChild;
  if (!element) return null;
  return {
    templateTitle,
    label,
    html: sanitizeDomFallbackElement(element),
    originalHtmlBytes: Buffer.byteLength(picked.html, "utf8"),
    extractionStrategy: picked.strategy,
    extractionScore: picked.scoreBoost,
    anchorOffset: picked.anchorOffset,
    selfLinkCount: picked.selfLinkCount,
    tableCount: picked.tableCount,
    textPreview: picked.textPreview,
  };
}

function applyTemplateDomFallbackMarkers(rawValue, fallbackByTitle) {
  const raw = String(rawValue || "");
  const ranges = findIncludeRanges(raw);
  const counts = new Map();
  for (const range of ranges) counts.set(range.title, (counts.get(range.title) || 0) + 1);
  const replacements = [];
  for (const range of ranges) {
    const fallback = fallbackByTitle.get(range.title);
    if (!fallback) continue;
    if ((counts.get(range.title) || 0) !== 1) continue;
    const marker = "KPOPARKIVE_TEMPLATE_FALLBACK_" + crypto.createHash("sha1").update(range.title).digest("hex").slice(0, 16);
    replacements.push({ ...range, marker, fallback });
  }
  let renderedSource = raw;
  for (const item of replacements.sort((a, b) => b.start - a.start)) {
    renderedSource = renderedSource.slice(0, item.start) + item.marker + renderedSource.slice(item.end);
  }
  return { renderedSource, replacements };
}

function setInlineStyleProperties(element, properties, removeProperties = []) {
  const raw = String(element?.getAttribute?.("style") || "");
  const map = new Map();
  for (const chunk of raw.split(";")) {
    const colon = chunk.indexOf(":");
    if (colon < 0) continue;
    const key = chunk.slice(0, colon).trim().toLowerCase();
    const value = chunk.slice(colon + 1).trim();
    if (key && value) map.set(key, value);
  }
  for (const key of removeProperties) map.delete(String(key).toLowerCase());
  for (const [key, value] of Object.entries(properties || {})) {
    if (value === null || value === undefined || value === "") map.delete(key.toLowerCase());
    else map.set(key.toLowerCase(), String(value));
  }
  const next = [...map.entries()].map(([key, value]) => `${key}:${value}`).join(";");
  if (next) element.setAttribute("style", next);
  else element.removeAttribute("style");
}

function normalizePortableFallbackHtml(htmlValue) {
  let root;
  try { root = parseHtml(String(htmlValue || ""), { comment: false }); }
  catch { return String(htmlValue || ""); }

  const displayByTag = {
    table: "table",
    thead: "table-header-group",
    tbody: "table-row-group",
    tfoot: "table-footer-group",
    tr: "table-row",
    td: "table-cell",
    th: "table-cell",
    colgroup: "table-column-group",
    col: "table-column",
    caption: "table-caption",
  };

  for (const node of root.querySelectorAll("*")) {
    const tag = String(node.tagName || "").toLowerCase();
    const expectedDisplay = displayByTag[tag];
    if (expectedDisplay) setInlineStyleProperties(node, { display: expectedDisplay });

    if (tag === "details") {
      setInlineStyleProperties(node, { display: "block", height: "auto" }, ["min-height", "max-height"]);
    } else if (tag === "summary") {
      setInlineStyleProperties(node, { display: "list-item", height: "auto" }, ["min-height", "max-height"]);
    } else if (["strong", "b", "em", "i", "small"].includes(tag)) {
      const display = String(node.getAttribute("style") || "").match(/(?:^|;)display:([^;]+)/i)?.[1]?.trim() || "";
      if (/^table(?:-|$)/i.test(display)) {
        setInlineStyleProperties(node, { display: "inline", width: "auto", height: "auto" }, ["min-width", "max-width", "min-height", "max-height"]);
      }
    } else if (tag === "div") {
      const display = String(node.getAttribute("style") || "").match(/(?:^|;)display:([^;]+)/i)?.[1]?.trim() || "";
      if (/^table(?:-|$)/i.test(display)) setInlineStyleProperties(node, { display: "block" });
    }
  }

  return root.toString();
}
function injectTemplateDomFallbacks(htmlValue, replacements) {
  let html = String(htmlValue || "");
  const injected = [];
  for (const item of replacements || []) {
    if (!html.includes(item.marker)) continue;
    html = html.split(item.marker).join(normalizePortableFallbackHtml(item.fallback.html));
    injected.push(item.fallback.templateTitle);
  }
  return { html, injected };
}
function sha256Text(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function includeHash(includeSource) {
  return sha256Text(String(includeSource || "").normalize("NFKC").trim());
}

function hasHangul(value) {
  return /[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(String(value || ""));
}

function fallbackTextNodes(htmlValue) {
  let root;
  try { root = parseHtml(String(htmlValue || ""), { comment: false }); }
  catch { return []; }
  const counts = new Map();
  const visit = (node, blocked = false) => {
    const tag = String(node?.tagName || "").toLowerCase();
    const nextBlocked = blocked || ["script", "style", "noscript"].includes(tag);
    if (!nextBlocked && Number(node?.nodeType) === 3) {
      const text = normalizeVisibleText(node.text || node.rawText || "");
      if (text) counts.set(text, (counts.get(text) || 0) + 1);
      return;
    }
    for (const child of node?.childNodes || []) visit(child, nextBlocked);
  };
  visit(root);
  return [...counts.entries()]
    .map(([text, count]) => ({ text, count, hasHangul: hasHangul(text) }))
    .sort((a, b) => Number(b.hasHangul) - Number(a.hasHangul) || a.text.localeCompare(b.text));
}

function escapeHtmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function translateFallbackHtml(sourceHtml, textMap) {
  let root;
  try { root = parseHtml(String(sourceHtml || ""), { comment: false }); }
  catch { return { html: null, unresolvedHangul: ["HTML_PARSE_FAILED"] }; }
  const map = textMap && typeof textMap === "object" ? textMap : {};
  const unresolved = new Set();
  const visit = (node, blocked = false) => {
    const tag = String(node?.tagName || "").toLowerCase();
    const nextBlocked = blocked || ["script", "style", "noscript"].includes(tag);
    if (!nextBlocked && Number(node?.nodeType) === 3) {
      const raw = String(node.rawText || "");
      const visible = normalizeVisibleText(node.text || raw);
      if (!visible) return;
      if (Object.prototype.hasOwnProperty.call(map, visible)) {
        const leading = raw.match(/^\s*/)?.[0] || "";
        const trailing = raw.match(/\s*$/)?.[0] || "";
        node.rawText = leading + escapeHtmlText(map[visible]) + trailing;
      } else if (hasHangul(visible)) {
        unresolved.add(visible);
      }
      return;
    }
    for (const child of node?.childNodes || []) visit(child, nextBlocked);
  };
  visit(root);
  return { html: root.toString(), unresolvedHangul: [...unresolved] };
}

async function syncSourceTemplateFallback(target, replacement, sourceBrowserCapturedAt) {
  const includeSource = String(replacement?.source || "");
  const hash = includeHash(includeSource);
  const sourceHtml = String(replacement?.fallback?.html || "");
  if (!target?.id || !replacement?.title || !hash || !sourceHtml) return null;
  const sourceHtmlHash = sha256Text(sourceHtml);
  const existingRows = await db(
    "template_dom_fallbacks?source_document_id=eq." + encodeURIComponent(target.id) +
    "&template_title=eq." + encodeURIComponent(replacement.title) +
    "&include_hash=eq." + encodeURIComponent(hash) +
    "&select=id,source_html_hash,translation_status,en_html,en_text_map&limit=1"
  );
  const existing = existingRows?.[0] || null;
  const now = new Date().toISOString();
  const base = {
    source_document_id: target.id,
    source_title: target.source_title,
    template_title: replacement.title,
    include_source: includeSource,
    include_hash: hash,
    source_html: sourceHtml,
    source_html_hash: sourceHtmlHash,
    source_text_nodes: fallbackTextNodes(sourceHtml),
    source_browser_captured_at: sourceBrowserCapturedAt || null,
    updated_at: now,
  };

  if (existing?.id && existing.source_html_hash === sourceHtmlHash) {
    await db("template_dom_fallbacks?id=eq." + encodeURIComponent(existing.id), {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(base),
    });
    return { ...existing, ...base, changed: false };
  }

  const reset = {
    ...base,
    en_html: null,
    en_text_map: {},
    translation_status: "pending_chatgpt",
    translated_at: null,
    synthetic_document_id: null,
    recovery_status: "pending",
    recovery_version: null,
    recovered_at: null,
    recovery_meta: {},
  };
  await db("template_dom_fallbacks?on_conflict=source_document_id,template_title,include_hash", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(reset),
  });
  return { ...reset, changed: true };
}

async function translatedTemplateFallbackMap(target, renderSource, missingTemplates) {
  const output = new Map();
  if (!target?.id || !missingTemplates?.length) return output;
  const rows = await db(
    "template_dom_fallbacks?source_document_id=eq." + encodeURIComponent(target.id) +
    "&translation_status=in.(translated_by_chatgpt,reviewed)" +
    "&select=id,template_title,include_hash,source_html,en_html,en_text_map,translation_status&order=updated_at.desc"
  );
  const ranges = findIncludeRanges(renderSource);
  const counts = new Map();
  for (const range of ranges) counts.set(range.title, (counts.get(range.title) || 0) + 1);

  for (const templateTitle of missingTemplates) {
    if ((counts.get(templateTitle) || 0) !== 1) continue;
    const candidates = (rows || []).filter((row) => normalizeTitle(row.template_title) === normalizeTitle(templateTitle));
    if (candidates.length !== 1) continue;
    const row = candidates[0];
    let html = typeof row.en_html === "string" && row.en_html.length > 0 ? row.en_html : null;
    if (!html) {
      const translated = translateFallbackHtml(row.source_html, row.en_text_map);
      if (!translated.html || translated.unresolvedHangul.length) continue;
      html = translated.html;
      await db("template_dom_fallbacks?id=eq." + encodeURIComponent(row.id), {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ en_html: html, updated_at: new Date().toISOString() }),
      });
    }
    output.set(templateTitle, {
      templateTitle,
      label: plainTemplateLabel(templateTitle),
      html,
      translationStatus: row.translation_status,
    });
  }
  return output;
}
function prepareYouTubeMacros(rawValue) {
  const source = String(rawValue || "");
  const embeds = [];
  const renderedSource = source.replace(/\[youtube\(\s*([^,\)\]]+)\s*((?:,[^\)\]]*)?)\)\]/gi, (full, rawId, rawParams) => {
    const videoId = String(rawId || "").trim();
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return full;
    const params = String(rawParams || "").replace(/^\s*,\s*/, "");
    const marker = "KPOPARKIVE_YOUTUBE_" + crypto.createHash("sha1").update(full + ":" + embeds.length).digest("hex").slice(0, 16);
    embeds.push({ marker, videoId, params, source: full });
    return marker;
  });
  return { renderedSource, embeds };
}

function youtubeIframeHtml(item) {
  const params = new URLSearchParams();
  for (const piece of String(item?.params || "").split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    if (equals < 0) continue;
    const key = trimmed.slice(0, equals).trim().toLowerCase();
    const value = trimmed.slice(equals + 1).trim();
    if (!value) continue;
    if (key === "start" || key === "시작") params.set("start", value);
    else if (key === "end" || key === "종료") params.set("end", value);
  }
  const query = params.toString();
  const src = `https://www.youtube.com/embed/${item.videoId}${query ? `?${query}` : ""}`;
  return `<iframe class="wiki-media" allowfullscreen width="640" height="360" frameborder="0" src="${src}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

function injectYouTubeMacros(htmlValue, embeds) {
  let html = String(htmlValue || "");
  const injected = [];
  for (const item of embeds || []) {
    if (!html.includes(item.marker)) continue;
    html = html.split(item.marker).join(youtubeIframeHtml(item));
    injected.push(item.videoId);
  }
  return { html, injected };
}
function uniqueNormalizedStrings(values) {
  const output = [];
  const seen = new Set();
  for (const value of values || []) {
    const normalized = normalizeTitle(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function hasRenderableFile(virtualWiki, name) {
  const parsed = parseDocumentName(/^파일:/i.test(name) ? name : `파일:${name}`);
  const doc = virtualWiki.byFullTitle.get(fullTitle(parsed));
  if (!doc) return false;
  return virtualWiki.histories.some((rev) => rev.document === doc.uuid && Boolean(rev.fileKey || rev.videoFileKey));
}

async function main() {
  const enginePatches = ensureEngine();

  const loadedRawRows = await dbAll(
    "source_documents?source=eq.namu_mirror&source_wikitext=not.is.null" +
      "&select=id,source_title,root_title,source_wikitext,source_format,raw_extracted_at,source_browser_captured_at,source_fidelity_meta,source_render_manifest&order=id.asc",
  );
  const browserCaptureByTitle = new Map(
    (loadedRawRows || [])
      .filter((row) => row?.source_title)
      .map((row) => [normalizeTitle(row.source_title), row.source_browser_captured_at || null]),
  );
  const rawRows = (loadedRawRows || []).filter((row) => {
    const synthetic = String(row?.source_format || "") === "namumark-synthetic-dom";
    if (!synthetic) return true;
    if (normalizeTitle(row?.source_title) === normalizeTitle(title)) return true;
    if (String(row?.source_fidelity_meta?.stage || "") !== "verified") return false;

    // Verified synthetic RAW is only reusable while its owner DOM capture has
    // not changed since the synthetic source was generated. A later normal-
    // Chrome recapture must force the owner back through DOM fallback
    // extraction + verification instead of silently reusing stale synthetic
    // template markup forever.
    const ownerTitle = normalizeTitle(
      row?.source_render_manifest?.ownerTitle || row?.root_title || "",
    );
    const ownerCapturedAt = Date.parse(browserCaptureByTitle.get(ownerTitle) || "");
    const generatedAt = Date.parse(
      row?.source_render_manifest?.generatedAt || row?.raw_extracted_at || "",
    );
    if (
      Number.isFinite(ownerCapturedAt) &&
      Number.isFinite(generatedAt) &&
      ownerCapturedAt > generatedAt
    ) {
      return false;
    }
    return true;
  });
  const target = (rawRows || []).find((row) => normalizeTitle(row.source_title) === normalizeTitle(title));
  if (!target?.id || !target?.source_wikitext) throw new Error(`No captured source_wikitext for ${title}`);

  const referencedTemplates = uniqueNormalizedStrings(
    extractIncludeTitles(target.source_wikitext).filter((item) => /^틀:/i.test(item))
  );
  const availableRawTitles = new Set(
    (rawRows || [])
      .filter((row) => row?.source_wikitext)
      .map((row) => normalizeTitle(row.source_title))
  );
  const missingTemplatesBeforeFallback = referencedTemplates.filter(
    (template) => !availableRawTitles.has(normalizeTitle(template))
  );

  let renderSource = String(target.source_wikitext);
  let templateFallbackReplacements = [];
  let fallbackTranslationQueue = [];

  if (!process.env.KPOPARKIVE_RENDER_CONTENT && missingTemplatesBeforeFallback.length) {
    const browserRows = await db(
      "source_documents?id=eq." + encodeURIComponent(target.id) +
      "&select=source_browser_article_html,source_browser_captured_at&limit=1"
    );
    const articleHtml = String(browserRows?.[0]?.source_browser_article_html || "");
    const browserCapturedAt = browserRows?.[0]?.source_browser_captured_at || null;
    if (articleHtml) {
      const fallbackByTitle = new Map();
      for (const templateTitle of missingTemplatesBeforeFallback) {
        const fallback = extractTemplateDomFallback(articleHtml, templateTitle);
        if (fallback) {
          fallbackByTitle.set(templateTitle, fallback);
          console.log(
            `DOM FALLBACK CAPTURED ${templateTitle} via ${fallback.extractionStrategy}` +
              ` score=${fallback.extractionScore} tables=${fallback.tableCount}` +
              ` bytes=${fallback.originalHtmlBytes.toLocaleString()}` +
              (fallback.anchorOffset != null ? ` anchor-offset=${fallback.anchorOffset}` : "")
          );
          if (fallback.textPreview) console.log(`  fallback-preview: ${fallback.textPreview}`);
        }
      }
      const prepared = applyTemplateDomFallbackMarkers(renderSource, fallbackByTitle);
      renderSource = prepared.renderedSource;
      templateFallbackReplacements = prepared.replacements;
      for (const replacement of templateFallbackReplacements) {
        const synced = await syncSourceTemplateFallback(target, replacement, browserCapturedAt);
        if (synced) fallbackTranslationQueue.push({
          templateTitle: replacement.title,
          translationStatus: synced.translation_status || "pending_chatgpt",
          changed: Boolean(synced.changed),
        });
      }
    }
  } else if (process.env.KPOPARKIVE_RENDER_CONTENT && missingTemplatesBeforeFallback.length) {
    const translatedFallbacks = await translatedTemplateFallbackMap(
      target,
      renderSource,
      missingTemplatesBeforeFallback
    );
    if (translatedFallbacks.size) {
      const prepared = applyTemplateDomFallbackMarkers(renderSource, translatedFallbacks);
      renderSource = prepared.renderedSource;
      templateFallbackReplacements = prepared.replacements;
    }
  }

  const preparedYouTube = prepareYouTubeMacros(renderSource);
  renderSource = preparedYouTube.renderedSource;

  // Assets are a global filename registry. A file captured while browsing any
  // NamuWiki document must be reusable by every other document that references
  // the same [[파일:...]] title. Do not scope assets to target.root_title.
  const loadedAssetRows = await dbAll(
    "source_asset_queue?asset_type=eq.image&status=eq.resolved" +
      "&select=id,root_title,source_title,source_ref,label,status,resolved_url,storage_path,metadata&order=id.asc",
  );
  const assetRows = await reconcileExactStagedAssets(target, renderSource, loadedAssetRows || []);

  const virtualWiki = makeVirtualWiki(rawRows || [], assetRows || []);
  const targetDoc = virtualWiki.byFullTitle.get(fullTitle(parseDocumentName(title)));
  const targetRev = virtualWiki.histories.find((item) => item.document === targetDoc?.uuid);
  if (!targetDoc || !targetRev) throw new Error(`Virtual The Tree document was not built for ${title}`);
  targetRev.content = renderSource;

  process.chdir(CACHE_DIR);
  global.config = config;
  global.plugins = { macro: [] };
  process.env.S3_PUBLIC_HOST = process.env.S3_PUBLIC_HOST || "https://invalid.local/";
  process.env.S3_PUBLIC_HOST_PREFIX = "";

  const requireFromTree = createRequire(path.join(CACHE_DIR, "package.json"));
  const parser = requireFromTree("./utils/namumark/parser");
  const Piscina = requireFromTree("piscina");
  const workerPath = requireFromTree.resolve("./utils/namumark/toHtmlWorker");

  const parsed = parser(renderSource);
  const pool = new Piscina({
    filename: workerPath,
    workerData: { config, macroPluginPaths: [] },
    minThreads: 1,
    maxThreads: 1,
  });

  const channel = new MessageChannel();
  channel.port2.on("message", (msg) => {
    const reply = (result) => channel.port2.postMessage({ id: msg.id, result });
    try {
      if (msg.type === "db") {
        const query = msg.data || {};
        if (msg.model === "Document") {
          let result = virtualWiki.docs.filter((doc) => documentMatches(doc, query));
          if (msg.action === "countDocuments") return reply(result.length);
          return reply(result);
        }
        if (msg.model === "History") {
          let result = virtualWiki.histories.filter((rev) => historyMatches(rev, query));
          if (msg.sort?.rev) result = result.sort((a, b) => msg.sort.rev < 0 ? b.rev - a.rev : a.rev - b.rev);
          return reply(result);
        }
        return reply(msg.action === "countDocuments" ? 0 : []);
      }
      if (msg.type === "aclCheck") return reply({ result: true });
      if (msg.type === "t") return reply(translation(msg.key));
      return reply(null);
    } catch (error) {
      console.warn("The Tree virtual parent action failed:", error?.message || String(error));
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
  let result;
  try {
    result = await pool.run([parsed, options], { transferList: [channel.port1] });
  } finally {
    await pool.destroy();
    channel.port2.close();
  }
  const elapsed = Math.round(performance.now() - started);
  let html = String(result?.html || "");
  if (html.length < 100) throw new Error(`The Tree returned only ${html.length} chars of HTML`);

  const injectedYouTube = injectYouTubeMacros(html, preparedYouTube.embeds);
  html = injectedYouTube.html;

  const injectedFallbacks = injectTemplateDomFallbacks(html, templateFallbackReplacements);
  html = injectedFallbacks.html;

  const requiredFiles = uniqueNormalizedStrings(Array.isArray(result?.files) ? result.files : []);
  const missingFiles = requiredFiles.filter((file) => !hasRenderableFile(virtualWiki, file));
  const injectedTemplateSet = new Set(injectedFallbacks.injected.map((item) => normalizeTitle(item)));
  const missingTemplates = missingTemplatesBeforeFallback.filter(
    (template) => !injectedTemplateSet.has(normalizeTitle(template))
  );
  const renderedAt = new Date().toISOString();
  const meta = {
    purpose: ENGINE_PATCHSET
      ? "raw-source architecture POC using pinned The Tree + Kpoparkive modern-Namu engine patches"
      : "raw-source architecture POC using unmodified The Tree renderer",
    engineRepo: THETREE_REPO,
    engineCommit: THETREE_COMMIT,
    enginePatchset: ENGINE_PATCHSET || null,
    enginePatches,
    rawChars: String(target.source_wikitext).length,
    htmlChars: html.length,
    renderMs: elapsed,
    hasError: Boolean(result?.hasError),
    errorCode: result?.errorCode || null,
    links: Array.isArray(result?.links) ? result.links.length : 0,
    youtubeMacros: preparedYouTube.embeds.map((item) => item.videoId),
    youtubeEmbedsInjected: injectedYouTube.injected,
    missingYouTubeEmbeds: preparedYouTube.embeds.filter((item) => !injectedYouTube.injected.includes(item.videoId)).map((item) => item.videoId),
    files: requiredFiles.length,
    requiredFiles,
    missingFiles,
    missingFileCount: missingFiles.length,
    referencedTemplates,
    missingTemplates,
    missingTemplateCount: missingTemplates.length,
    domFallbackTemplates: injectedFallbacks.injected,
    domFallbackTemplateCount: injectedFallbacks.injected.length,
    domFallbackLanguage: process.env.KPOPARKIVE_RENDER_CONTENT ? "en" : "ko",
    fallbackTranslationQueue,
    fallbackExtractorVersion: 2,
    assetReconcilerVersion: 2,
    categories: Array.isArray(result?.categories) ? result.categories.length : 0,
    headings: Array.isArray(result?.headings) ? result.headings.length : 0,
    virtualDocuments: virtualWiki.docs.length,
    virtualRevisions: virtualWiki.histories.length,
    capturedRawDocuments: (rawRows || []).filter((row) => row?.source_wikitext).length,
    capturedAssets: (assetRows || []).filter((row) => assetUrl(row)).length,
    assetRowsLoaded: (assetRows || []).length,
    renderedAt,
  };

  process.chdir(ROOT_DIR);
  await db(`source_documents?id=eq.${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({
      source_namumark_html: html,
      source_namumark_js: null,
      source_namumark_meta: meta,
      source_namumark_engine: ENGINE_NAME,
      source_namumark_engine_version: THETREE_COMMIT,
      source_namumark_rendered_at: renderedAt,
      updated_at: renderedAt,
    }),
  });

  console.log(`THE TREE POC SAVED ${title}`);
  console.log(`raw=${meta.rawChars} html=${meta.htmlChars} render=${meta.renderMs}ms hasError=${meta.hasError}`);
  console.log(`raw-docs=${meta.capturedRawDocuments} asset-rows=${meta.assetRowsLoaded} assets=${meta.capturedAssets} virtual-docs=${meta.virtualDocuments}`);
  console.log(`links=${meta.links} files=${meta.files} missing-files=${meta.missingFileCount} templates=${meta.referencedTemplates.length} missing-templates=${meta.missingTemplateCount} dom-fallback-templates=${meta.domFallbackTemplateCount} categories=${meta.categories} headings=${meta.headings}`);
  console.log(`youtube-macros=${meta.youtubeMacros.length} youtube-injected=${meta.youtubeEmbedsInjected.length} youtube-missing=${meta.missingYouTubeEmbeds.length}`);
  if (meta.missingYouTubeEmbeds.length) console.log(`youtube-missing: ${meta.missingYouTubeEmbeds.join(" | ")}`);
  if (missingTemplates.length) console.log(`missing-templates: ${missingTemplates.slice(0, 30).join(" | ")}${missingTemplates.length > 30 ? ` | +${missingTemplates.length - 30} more` : ""}`);
  if (injectedFallbacks.injected.length) console.log(`dom-fallback-templates: ${injectedFallbacks.injected.join(" | ")}`);
  if (fallbackTranslationQueue.length) console.log(`fallback-translation-queue: ${fallbackTranslationQueue.map((item) => `${item.templateTitle}:${item.translationStatus}${item.changed ? ":changed" : ""}`).join(" | ")}`);
  if (enginePatches.length) console.log(`engine-patches: ${enginePatches.join(" | ")}`);
  if (missingFiles.length) console.log(`missing: ${missingFiles.slice(0, 30).join(" | ")}${missingFiles.length > 30 ? ` | +${missingFiles.length - 30} more` : ""}`);
  console.log(`Preview: https://kpoparkive.vercel.app/admin/namumark-poc/${encodeURIComponent(title)}`);
  console.log(`Frontend baseline: https://kpoparkive.vercel.app/admin/thetree-frontend-poc/${encodeURIComponent(title)}`);
}

main().catch((error) => {
  try { process.chdir(ROOT_DIR); } catch {}
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
