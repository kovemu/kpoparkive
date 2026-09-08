alter table public.source_documents
  add column if not exists source_browser_article_html text,
  add column if not exists source_browser_capture_meta jsonb,
  add column if not exists source_browser_capture_version text,
  add column if not exists source_browser_captured_at timestamptz;
