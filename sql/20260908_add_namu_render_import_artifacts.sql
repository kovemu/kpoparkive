alter table public.source_documents
  add column if not exists source_article_html text,
  add column if not exists source_template_css text,
  add column if not exists source_render_manifest jsonb,
  add column if not exists source_render_extraction_version text,
  add column if not exists source_render_extracted_at timestamptz;
