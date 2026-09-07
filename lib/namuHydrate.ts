import type { ParsedSection } from "./namuParser";

type AssetRow = {
  asset_type: string;
  source_ref: string;
  status: string;
  resolved_url: string | null;
  storage_path: string | null;
  metadata?: Record<string, unknown>;
};

function slugFromResolvedUrl(url: string | null) {
  if (!url) return null;
  const draft = url.match(/^\/admin\/drafts\/([^/?#]+)/);
  if (draft) return decodeURIComponent(draft[1]);
  const wiki = url.match(/^\/wiki\/([^/?#]+)/);
  if (wiki) return decodeURIComponent(wiki[1]);
  return null;
}

export function hydrateNamuSections(sections: ParsedSection[], assets: AssetRow[]) {
  const byKey = new Map<string, AssetRow>();
  for (const asset of assets) byKey.set(`${asset.asset_type}:${asset.source_ref}`, asset);

  let resolvedAssets = 0;
  let skippedAssets = 0;
  let placeholders = 0;

  const hydrated = sections.map((section) => {
    const seenImages = new Set<string>();
    const content = section.content.flatMap((block) => {
      if (block.type === "image") {
        const asset = byKey.get(`image:${block.source_ref}`);
        if (asset?.status === "skipped") {
          skippedAssets += 1;
          return [];
        }
        if (asset?.status === "resolved" && (asset.storage_path || asset.resolved_url)) {
          const dedupeKey = asset.storage_path || asset.resolved_url || block.source_ref;
          if (seenImages.has(dedupeKey)) return [];
          seenImages.add(dedupeKey);
          resolvedAssets += 1;
          return [{ ...block, storage_path: asset.storage_path || undefined, url: asset.resolved_url || block.url } as typeof block & { storage_path?: string }];
        }
        placeholders += 1;
        return [block];
      }

      if (block.type === "internal-link") {
        const asset = byKey.get(`internal_link:${block.target}`);
        if (asset?.status === "skipped") {
          skippedAssets += 1;
          return [{ type: "paragraph" as const, text: block.label }];
        }
        if (asset?.status === "resolved") {
          const slug = slugFromResolvedUrl(asset.resolved_url);
          if (slug) {
            resolvedAssets += 1;
            return [{ ...block, slug } as typeof block & { slug?: string }];
          }
        }
        return [block];
      }

      if (block.type === "external-link") {
        const asset = byKey.get(`external_link:${block.url}`);
        if (asset?.status === "resolved" && asset.resolved_url) {
          resolvedAssets += 1;
          return [{ ...block, url: asset.resolved_url }];
        }
        return [block];
      }

      if (block.type === "video") {
        const asset = byKey.get(`video:${block.url}`);
        if (asset?.status === "resolved" && asset.resolved_url) resolvedAssets += 1;
        return [block];
      }

      return [block];
    });
    return { ...section, content };
  });

  return { sections: hydrated, resolvedAssets, skippedAssets, placeholders };
}
