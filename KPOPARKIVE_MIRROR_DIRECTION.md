# Kpoparkive NamuWiki Mirror Direction

## Locked product direction

Kpoparkive's imported wiki pages are not summaries or editorial reinterpretations of NamuWiki pages.

The source NamuWiki document is the visual and structural specification.

For a seed such as `https://namu.wiki/w/RESCENE`, the importer should behave as an automatic English mirror:

1. Crawl the source document graph.
2. Preserve the original document hierarchy and block order.
3. Preserve infoboxes, tables, row/column spans, images, galleries, videos, inline links, footnotes, folding blocks, related-document notices and navigation templates.
4. Resolve media into Kpoparkive/Supabase where possible while preserving the original placement.
5. Rewrite NamuWiki internal links to Kpoparkive documents when a mirrored target exists.
6. Translate Korean text into natural English without summarizing, restructuring or dropping factual depth.
7. Render desktop/mobile responsively while keeping the dense NamuWiki-style document layout.

## Non-goals

- Do not redesign imported pages into a generic modern profile page.
- Do not manually invent sections that are absent from the source.
- Do not reorder blocks by type.
- Do not turn inline links into separate rows.
- Do not summarize long NamuWiki sections merely to make them shorter.
- Do not use the hand-authored RESCENE pilot as the canonical content model. It is only a visual/comparison reference during migration.

## Canonical pipeline

`NamuWiki/mirror snapshot -> source-order parser/AST -> asset resolution -> English localization -> internal-link rewrite -> Namu-faithful renderer`

## Acceptance test

A user comparing the Kpoparkive RESCENE page with the source RESCENE page should recognize the same document structure, the same section sequence, the same tables/media positions and the same information density. The primary visible difference should be English localization and Kpoparkive branding.
