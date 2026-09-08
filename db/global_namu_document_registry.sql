-- Global NamuWiki document registry support.
-- source_documents is already globally unique on (source, source_title).
-- These tables separate document identity from import-root membership and link graph edges.

create table if not exists public.source_document_clusters (
  root_title text not null,
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  min_crawl_depth integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (root_title, source_document_id)
);

create index if not exists source_document_clusters_document_idx
  on public.source_document_clusters(source_document_id);

create table if not exists public.source_document_links (
  id bigserial primary key,
  from_document_id uuid not null references public.source_documents(id) on delete cascade,
  to_source_title text not null,
  to_source_url text not null,
  to_document_id uuid null references public.source_documents(id) on delete set null,
  anchor_text text null,
  section_id text null,
  source_area text null,
  crawl_priority integer null,
  crawl_candidate boolean not null default true,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (from_document_id, to_source_title)
);

create index if not exists source_document_links_to_document_idx
  on public.source_document_links(to_document_id);

create index if not exists source_document_links_to_title_idx
  on public.source_document_links(to_source_title);
