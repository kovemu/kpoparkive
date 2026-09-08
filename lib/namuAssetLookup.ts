export type NamuAssetMap = Record<string, string>;

export function normalizeNamuFileRef(value: string) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/^(?:파일|File):/i, "")
    .trim()
    .replace(/\s+/g, " ");
}

function splitExtension(value: string) {
  const normalized = normalizeNamuFileRef(value).toLowerCase();
  const dot = normalized.lastIndexOf(".");
  if (dot <= 0 || dot === normalized.length - 1) return { stem: normalized, ext: "" };
  return { stem: normalized.slice(0, dot), ext: normalized.slice(dot + 1) };
}

function tokenSignature(value: string) {
  const { stem, ext } = splitExtension(value);
  const tokens = stem
    .replace(/[\[\](){}'"“”‘’.,:;_+\-\/\\]+/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
    .sort();
  return `${ext}|${tokens.join("|")}`;
}

function compactSignature(value: string) {
  const { stem, ext } = splitExtension(value);
  const compact = stem.replace(/[^0-9a-z가-힣]+/gi, "");
  return `${ext}|${compact}`;
}

/**
 * Build a collision-aware Namu file resolver once per asset map.
 *
 * Lookup order:
 * 1. exact key
 * 2. NFKC/canonical file name
 * 3. punctuation-insensitive token signature (order-independent)
 * 4. compact punctuation/whitespace-insensitive signature
 *
 * Fuzzy aliases are only returned when every matching key points to the same
 * URL. Ambiguous aliases deliberately stay unresolved instead of displaying a
 * wrong image.
 */
export function createNamuAssetLookup(assets: NamuAssetMap) {
  const canonical = new Map<string, Set<string>>();
  const tokenized = new Map<string, Set<string>>();
  const compact = new Map<string, Set<string>>();

  const add = (map: Map<string, Set<string>>, key: string, url: string) => {
    if (!key || !url) return;
    const urls = map.get(key) || new Set<string>();
    urls.add(url);
    map.set(key, urls);
  };

  for (const [key, url] of Object.entries(assets || {})) {
    const normalized = normalizeNamuFileRef(key);
    if (!normalized || !url) continue;
    add(canonical, normalized.toLowerCase(), url);
    add(tokenized, tokenSignature(normalized), url);
    add(compact, compactSignature(normalized), url);
  }

  const unique = (set: Set<string> | undefined) => set?.size === 1 ? Array.from(set)[0] : undefined;

  return (file: string) => {
    if (!file) return undefined;
    if (assets[file]) return assets[file];
    const normalized = normalizeNamuFileRef(file);
    if (assets[normalized]) return assets[normalized];
    return unique(canonical.get(normalized.toLowerCase()))
      || unique(tokenized.get(tokenSignature(normalized)))
      || unique(compact.get(compactSignature(normalized)));
  };
}

export function findNamuAsset(assets: NamuAssetMap, file: string) {
  return createNamuAssetLookup(assets)(file);
}
