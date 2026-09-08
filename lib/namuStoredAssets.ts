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

/** Stored files always win over remote hints, regardless of DB row order. */
export function buildNamuResolvedAssetMap(rows: NamuQueueAsset[], hints: Record<string, string> = {}) {
  const assets = { ...hints };
  const add = (row: NamuQueueAsset, url: string) => {
    for (const key of [row.source_ref, row.label, row.metadata?.original_url]) {
      if (typeof key === "string" && key) assets[normalizeNamuFileRef(key)] = url;
    }
  };
  for (const row of rows) {
    const hint = row.metadata?.enrichment_url;
    const url = typeof hint === "string" && /^https?:\/\//i.test(hint) ? hint
      : /^https?:\/\//i.test(row.source_ref) ? row.source_ref : null;
    if (url) add(row, url);
  }
  for (const row of rows) if (row.resolved_url) add(row, row.resolved_url);
  for (const row of rows) if (row.storage_path && row.resolved_url) add(row, row.resolved_url);
  return assets;
}

/**
 * namu.moe currently emits `file.namu.moe/file/<hash>` URLs. That host can
 * intermittently answer Vercel/server requests with 503 while the same object
 * is reachable through the mirror's main host. Keep every representation as a
 * download candidate; the resolver stores the first successful response in
 * Supabase, so these remote URLs are never a long-term runtime dependency.
 */
export function expandNamuRemoteCandidates(url: string) {
  const output = [url];
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "file.namu.moe" && parsed.pathname.startsWith("/file/")) {
      output.push(`https://www.namu.moe${parsed.pathname}${parsed.search}`);
      output.push(`https://namu.moe${parsed.pathname}${parsed.search}`);
    }
    if (parsed.hostname === "w.namu.la") output.push(`https://i.namu.wiki${parsed.pathname}${parsed.search}`);
  } catch {
    // Candidate validation happens again before network I/O.
  }
  return [...new Set(output)];
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
