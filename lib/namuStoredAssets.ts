import { createNamuAssetLookup, normalizeNamuFileRef } from "./namuAssetLookup";

export type StoredNamuMedia = {
  id: string; bucket: string; storage_path: string; role: string | null;
  caption: string | null; alt_text: string | null; source_url: string | null;
};

// Only album-cover records can be matched by album title. A current portrait
// must never silently replace a differently named historical/concept photo.
function coverTitle(file: string, rootTitle: string) {
  let value = normalizeNamuFileRef(file);
  if (!/\.(?:jpg|jpeg|png|webp|avif)$/i.test(value)) return null;
  value = value.replace(/\.[^.]+$/, "");
  const qualifier = `(${rootTitle})`;
  if (value.toLowerCase().endsWith(qualifier.toLowerCase())) value = value.slice(0, -qualifier.length);
  value = value.replace(/\s+(?:digital\s+)?cover$/i, "");
  return value.toLowerCase().replace(/[\s:._-]+/g, "");
}

export function matchStoredNamuMedia(file: string, rootTitle: string, media: StoredNamuMedia[]) {
  const normalized = normalizeNamuFileRef(file);
  const exact = media.filter(m => [m.caption, m.alt_text].some(v => v && normalizeNamuFileRef(v) === normalized));
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const title = coverTitle(file, rootTitle);
  if (!title) return undefined;
  const matches = media.filter(m => /^album[-_]cover(?::|$)/i.test(m.role || "") && m.caption
    && coverTitle(`${m.caption}.jpg`, rootTitle) === title);
  return matches.length === 1 ? matches[0] : undefined;
}

export type NamuQueueAsset = {
  source_ref: string; label: string | null; resolved_url: string | null;
  storage_path: string | null; metadata: Record<string, unknown> | null;
};

/**
 * Reject mirror page chrome and navigation endpoints that can return valid
 * image bytes without being the requested Namu [[파일:...]] payload.
 *
 * In particular namu.moe /xref/<filename> can answer with tiny placeholder
 * JPEG/PNG files. Those responses have valid magic bytes, so MIME sniffing alone
 * is not enough. Only CDN-like /file/ payloads (and first-party Namu asset URLs)
 * may be persisted as source images.
 */
export function isNamuNonPayloadAssetUrl(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const isMirror = host === "namu.moe" || host.endsWith(".namu.moe");
    if (isMirror && /^\/(?:images|xref)(?:\/|$)/i.test(parsed.pathname)) return true;
    if (isMirror && /^\/(?:w|RecentChanges|Search)(?:\/|$)/i.test(parsed.pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

// Backward-compatible name used by older importer modules.
export const isNamuMirrorUiAssetUrl = isNamuNonPayloadAssetUrl;

function rowHasPoisonedOrigin(row: NamuQueueAsset) {
  for (const value of [row.metadata?.original_url, row.metadata?.enrichment_url]) {
    if (typeof value === "string" && isNamuNonPayloadAssetUrl(value)) return true;
  }
  return false;
}

/** Stored files always win over remote hints, but only after provenance checks. */
export function buildNamuResolvedAssetMap(rows: NamuQueueAsset[], hints: Record<string, string> = {}) {
  const poisonedStoragePaths = new Set(
    rows
      .filter(rowHasPoisonedOrigin)
      .map(row => row.storage_path)
      .filter((value): value is string => Boolean(value)),
  );
  const usableRow = (row: NamuQueueAsset) => {
    if (rowHasPoisonedOrigin(row)) return false;
    if (row.storage_path && poisonedStoragePaths.has(row.storage_path)) return false;
    return true;
  };

  const assets = Object.fromEntries(Object.entries(hints).filter(([, url]) => !isNamuNonPayloadAssetUrl(url)));
  const add = (row: NamuQueueAsset, url: string) => {
    if (!usableRow(row) || isNamuNonPayloadAssetUrl(url)) return;
    for (const key of [row.source_ref, row.label, row.metadata?.original_url]) {
      if (typeof key === "string" && key) assets[normalizeNamuFileRef(key)] = url;
    }
  };
  for (const row of rows) {
    if (!usableRow(row)) continue;
    const hint = row.metadata?.enrichment_url;
    const url = typeof hint === "string" && /^https?:\/\//i.test(hint) && !isNamuNonPayloadAssetUrl(hint) ? hint
      : /^https?:\/\//i.test(row.source_ref) && !isNamuNonPayloadAssetUrl(row.source_ref) ? row.source_ref : null;
    if (url) add(row, url);
  }
  for (const row of rows) if (usableRow(row) && row.resolved_url) add(row, row.resolved_url);
  for (const row of rows) if (usableRow(row) && row.storage_path && row.resolved_url) add(row, row.resolved_url);
  return assets;
}

/**
 * namu.moe currently emits file.namu.moe/file/<hash> URLs. Keep only genuine
 * asset candidates. Mirror /images/* and /xref/* are explicitly excluded because
 * they are presentation/navigation resources, not trustworthy file payloads.
 */
export function expandNamuRemoteCandidates(url: string) {
  if (isNamuNonPayloadAssetUrl(url)) return [];
  const output = [url];
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "file.namu.moe" && parsed.pathname.startsWith("/file/")) {
      output.push(`https://www.namu.moe${parsed.pathname}${parsed.search}`);
      output.push(`https://namu.moe${parsed.pathname}${parsed.search}`);
      output.push(`https://dark.namu.moe${parsed.pathname}${parsed.search}`);
      output.push(`https://d.namu.moe${parsed.pathname}${parsed.search}`);
      output.push(`https://m.namu.moe${parsed.pathname}${parsed.search}`);
    }
    if (parsed.hostname === "w.namu.la") output.push(`https://i.namu.wiki${parsed.pathname}${parsed.search}`);
  } catch {
    // Candidate validation happens again before network I/O.
  }
  return [...new Set(output)].filter(candidate => !isNamuNonPayloadAssetUrl(candidate));
}

export function findNamuAssetCandidates(refs: string[], maps: Record<string, string>[]) {
  return [...new Set(maps.flatMap(map => {
    const lookup = createNamuAssetLookup(map);
    return refs.flatMap(ref => {
      const url = lookup(ref);
      return url ? expandNamuRemoteCandidates(url) : [];
    });
  }))];
}
