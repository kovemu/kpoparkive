import type { ParsedBlock, ParsedSection } from "./namuParser";

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

  const hydrated: ParsedSection[] = sections.map((section) => {
    const seenImages = new Set<string>();
    const content: ParsedBlock[] = [];

    for (const block of section.content) {
      if (block.type === "image") {
        const asset = byKey.get(`image:${block.source_ref}`);
        if (asset?.status === "skipped") {
          skippedAssets += 1;
          continue;
        }
        if (asset?.status === "resolved" && (asset.storage_path || asset.resolved_url)) {
          const dedupeKey = asset.storage_path || asset.resolved_url || block.source_ref;
          if (seenImages.has(dedupeKey)) continue;
          seenImages.add(dedupeKey);
          resolvedAssets += 1;
          content.push({
            ...block,
            storage_path: asset.storage_path || undefined,
            url: asset.resolved_url || block.url,
          } as ParsedBlock);
          continue;
        }
        placeholders += 1;
        content.push(block);
        continue;
      }

      if (block.type === "internal-link") {
        const asset = byKey.get(`internal_link:${block.target}`);
        if (asset?.status === "skipped") {
          skippedAssets += 1;
          content.push({ type: "paragraph", text: block.label });
          continue;
        }
        if (asset?.status === "resolved") {
          const slug = slugFromResolvedUrl(asset.resolved_url);
          if (slug) {
            resolvedAssets += 1;
            content.push({ ...block, slug } as ParsedBlock);
            continue;
          }
        }
        content.push(block);
        continue;
      }

      if (block.type === "external-link") {
        const asset = byKey.get(`external_link:${block.url}`);
        if (asset?.status === "resolved" && asset.resolved_url) {
          resolvedAssets += 1;
          content.push({ ...block, url: asset.resolved_url });
        } else {
          content.push(block);
        }
        continue;
      }

      if (block.type === "video") {
        const asset = byKey.get(`video:${block.url}`);
        if (asset?.status === "resolved" && asset.resolved_url) resolvedAssets += 1;
        content.push(block);
        continue;
      }

      content.push(block);
    }

    return { ...section, content };
  });

  return { sections: hydrated, resolvedAssets, skippedAssets, placeholders };
}
