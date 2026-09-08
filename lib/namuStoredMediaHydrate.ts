import { matchStoredNamuMedia, type StoredNamuMedia } from "./namuStoredAssets";

type Database = (path: string, init?: RequestInit) => Promise<any>;

/** Import/backfill stage: reuse attributable stored media inside this cluster. */
export async function hydrateNamuStoredMedia(db: Database, rootTitle: string, supabaseUrl: string) {
  const docs = await db(`source_documents?root_title=eq.${encodeURIComponent(rootTitle)}&select=generated_document_id`) as { generated_document_id: string | null }[];
  const ids = [...new Set(docs.map(d => d.generated_document_id).filter(Boolean))];
  if (!ids.length) return 0;
  const media = await db(`media?document_id=in.(${ids.join(",")})&media_type=eq.image&select=id,bucket,storage_path,role,caption,alt_text,source_url`) as StoredNamuMedia[];
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
        metadata: { ...row.metadata, resolved_from: "stored-media-caption", media_id: match.id, original_url: match.source_url, resolution_error: null },
        updated_at: new Date().toISOString(),
      }) });
      count += 1;
    }
    if (rows.length < 500) break;
  }
  return count;
}
