# Kpoparkive NamuWiki Mirror Direction

## Locked product direction

Kpoparkive's imported wiki pages are not summaries or editorial reinterpretations of NamuWiki pages.

The source NamuWiki document is the visual and structural specification.

For a seed such as `https://namu.wiki/w/RESCENE`, the importer should behave as an automatic English mirror:

1. Crawl the source document graph.
2. Preserve the original document hierarchy and block order.
3. Preserve infoboxes, tables, row/column spans, images, galleries, videos, inline links, footnotes, folding blocks, related-document notices and navigation templates.
4. Preserve the mirror's rendered `<article>` DOM as the presentation skeleton instead of rebuilding the whole layout from raw syntax.
5. Preserve unsupported Namu syntax fragments and `#!style` template CSS alongside that DOM skeleton.
6. Resolve media into Kpoparkive/Supabase where possible while preserving the original placement and reuse image mappings across the whole imported group cluster.
7. Rewrite NamuWiki internal links to Kpoparkive documents when a mirrored target exists.
8. Translate Korean text into natural English without summarizing, restructuring or dropping factual depth.
9. Render desktop/mobile responsively while keeping the dense NamuWiki-style document layout.

## Non-goals

- Do not redesign imported pages into a generic modern profile page.
- Do not manually invent sections that are absent from the source.
- Do not reorder blocks by type.
- Do not turn inline links into separate rows.
- Do not summarize long NamuWiki sections merely to make them shorter.
- Do not use the hand-authored RESCENE pilot as the canonical content model. It is only a visual/comparison reference during migration.
- Do not use the raw parser as the primary page-layout engine when a rendered mirror DOM skeleton is available.

## Canonical source layers

- `raw_html`: untouched fetched snapshot for provenance/debugging.
- `source_article_html`: rendered `<article>` DOM skeleton captured during import.
- `source_wikitext` + `source_raw_segments`: unsupported Namu source preserved in source order.
- `source_template_css`: recovered `#!style` rules captured during import.
- `source_render_manifest`: generic diagnostics for tables, TOC, float infobox candidates, raw controls and media coverage.
- `source_asset_queue`: media references and cluster-level filename -> rendered URL hints for Supabase resolution.

## Canonical pipeline

`NamuWiki/mirror snapshot -> preserve raw_html -> extract DOM skeleton + raw fragments + template CSS + media map -> cluster asset resolution -> English localization -> internal-link rewrite -> Namu-faithful hybrid renderer`

The renderer uses the rendered DOM to answer **how the page is laid out**, and raw Namu source to answer **what unresolved constructs mean**. Neither representation should discard the other.

## Acceptance test

A user comparing the Kpoparkive RESCENE page with the source RESCENE page should recognize the same document structure, the same section sequence, the same tables/media positions and the same information density. The primary visible difference should be English localization and Kpoparkive branding.
