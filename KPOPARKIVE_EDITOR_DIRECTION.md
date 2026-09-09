# Kpoparkive Editor Direction

## Principle

Captured NamuWiki source is an immutable import reference. Kpoparkive edits are stored separately and versioned.

## Data flow

1. `source_wikitext` — captured Korean Namu source; import reference only.
2. `content_wikitext` — editable Kpoparkive document source.
3. `source_document_revisions` — append-only editable revision history.
4. `content_namumark_html` — exact rendered editable output when the private The Tree-compatible renderer has processed the latest revision.
5. `/w/...` prefers `content_namumark_html` when present and otherwise falls back to the captured source render.

## Editor v1

Admin-only route: `/admin/editor/[...title]`

- source editing
- safe syntax toolbar
- edit summaries
- append-only revisions
- load an old revision into the editor
- rollback by creating a new revision
- reset editable content to captured source without mutating the captured source
- current exact-render pane

The exact render remains intentionally separate from the public repository because the permitted modified The Tree renderer must not be redistributed.
