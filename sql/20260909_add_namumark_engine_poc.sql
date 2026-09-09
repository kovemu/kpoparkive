alter table source_documents
  add column if not exists source_namumark_html text,
  add column if not exists source_namumark_js text,
  add column if not exists source_namumark_meta jsonb,
  add column if not exists source_namumark_engine text,
  add column if not exists source_namumark_engine_version text,
  add column if not exists source_namumark_rendered_at timestamptz;
