import { matchStoredNamuMedia, type StoredNamuMedia } from "./namuStoredAssets";

type Database = (path: string, init?: RequestInit) => Promise<any>;

function storagePrefix(rootTitle: string) {
  const ascii = rootTitle
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return ascii || rootTitle.normalize("NFKC").replace(/\s+/g, "-").toLowerCase();
}

function mergeMedia(...groups: StoredNamuMedia[][]) {
  const byId = new Map<string, StoredNamuMedia>();
  for (const group of groups) for (const item of group) byId.set(item.id, item);
  return [...byId.values()];
}

/**
 * Import/backfill stage: reuse attributable stored media inside this cluster.
 *
 * Historical Kpoparkive media can pre-date the mirror importer, so it is not
 * always attached to source_documents.generated_document_id. For example the
 * published `rescene` document owns album covers while the mirror draft has a
 * different document id. Reuse media by three conservative scopes:
 * 1. generated mirror document ids
 * 2. an existing document whose title equals the root title
 * 3. the root-owned Storage prefix (`rescene/...`)
 *
 * Matching is still delegated to matchStoredNamuMedia, which only accepts an
 * exact file/alt match or an unambiguous album-cover title match. A random
 * profile image is never substituted for a differently named concept photo.
 */
export async function hydrateNamuStoredMedia(db: Database, rootTitle: string, supabaseUrl: string) {
  const sourceDocs = await db(`source_documents?root_title=eq.${encodeURIComponent(rootTitle)}&select=generated_document_id`) as { generated_document_id: string | null }[];
  const titleDocs = await db(`documents?title=eq.${encodeURIComponent(rootTitle)}&select=id`) as { id: string }[];
  const ids = [...new Set([
    ...sourceDocs.map(d => d.generated_document_id).filter((id): id is string => Boolean(id)),
    ...titleDocs.map(d => d.id).filter(Boolean),
  ])];

  const select = "id,bucket,storage_path,role,caption,alt_text,source_url";
  const attached = ids.length
    ? await db(`media?document_id=in.(${ids.join(",")})&media_type=eq.image&select=${select}`) as StoredNamuMedia[]
    : [];
  const prefix = storagePrefix(rootTitle);
  const prefixed = await db(`media?media_type=eq.image&storage_path=like.${encodeURIComponent(`${prefix}/*`)}&select=${select}`) as StoredNamuMedia[];
  const media = mergeMedia(attached, prefixed);
  if (!media.length) return 0;

  let count = 0;
  const verified = new Map<string, boolean>();
  const started = Date.now();
  // Page over all images, including resolved rows, so updating status does not
  // shift offsets and cause the next page to skip unprocessed records.
  for (let offset = 0; ; offset += 500) {
    const rows = await db(`source_asset_queue?root_title=eq.${encodeURIComponent(rootTitle)}&asset_type=eq.image&select=id,source_ref,label,storage_path,metadata&order=id.asc&offset=${offset}&limit=500`) as { id: string; source_ref: string; label: string | null; storage_path: string | null; metadata: Record<string, unknown> | null }[];
    for (const row of rows) {
      if (row.storage_path) continue;
      const match = matchStoredNamuMedia(row.label || row.source_ref, rootTitle, media);
      if (!match?.storage_path) continue;
      const url = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(match.bucket)}/${match.storage_path.split("/").map(encodeURIComponent).join("/")}`;
      if (Date.now() - started > 12000) return count;
      if (!verified.has(url)) {
        const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000), cache: "no-store" }).catch(() => null);
        verified.set(url, Boolean(response?.ok && response.headers.get("content-type")?.startsWith("image/")));
      }
      if (!verified.get(url)) continue;
      await db(`source_asset_queue?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({
        status: "resolved", storage_path: match.storage_path, resolved_url: url, confidence: 0.99,
        metadata: { ...row.metadata, resolved_from: "stored-media-root-scope", media_id: match.id, original_url: match.source_url, resolution_error: null },
        updated_at: new Date().toISOString(),
      }) });
      count += 1;
    }
    if (rows.length < 500) break;
  }
  return count;
}
