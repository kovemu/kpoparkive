create table if not exists public.source_edit_proposals (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  source_title text not null,
  section_key text not null,
  section_heading text not null,
  block_index integer not null,
  base_revision_no integer not null default 0,
  original_wikitext text not null,
  original_plain_text text not null,
  proposed_plain_text text not null,
  summary text,
  display_name text,
  submitter_hash text,
  status text not null default 'pending' check (status in ('pending','accepted','rejected','superseded')),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  review_note text
);

create index if not exists source_edit_proposals_document_created_idx
  on public.source_edit_proposals(source_document_id, created_at desc);
create index if not exists source_edit_proposals_status_created_idx
  on public.source_edit_proposals(status, created_at desc);
create index if not exists source_edit_proposals_submitter_created_idx
  on public.source_edit_proposals(submitter_hash, created_at desc);

alter table public.source_edit_proposals enable row level security;
revoke all on public.source_edit_proposals from anon, authenticated;
grant all on public.source_edit_proposals to service_role;
