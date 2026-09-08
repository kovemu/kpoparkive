alter table public.source_documents
  add column if not exists source_browser_style_css text;

comment on column public.source_documents.source_browser_style_css is
  'Sanitized pseudo-element/style snapshot captured from normal Chrome alongside source_browser_article_html.';
