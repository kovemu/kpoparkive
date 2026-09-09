alter table public.source_documents
  add column if not exists content_wikitext text,
  add column if not exists content_language text not null default 'ko',
  add column if not exists content_status text not null default 'source',
  add column if not exists content_revision_no integer not null default 0,
  add column if not exists content_updated_at timestamptz,
  add column if not exists content_updated_by text,
  add column if not exists content_namumark_html text,
  add column if not exists content_namumark_engine text,
  add column if not exists content_namumark_engine_version text,
  add column if not exists content_namumark_rendered_at timestamptz;

create table if not exists public.source_document_revisions (
  id uuid primary key default gen_random_uuid(),
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  revision_no integer not null,
  content_wikitext text not null,
  content_language text not null default 'ko',
  summary text,
  editor_type text not null default 'admin',
  editor_label text,
  created_at timestamptz not null default now(),
  unique (source_document_id, revision_no)
);

create index if not exists source_document_revisions_document_created_idx
  on public.source_document_revisions(source_document_id, created_at desc);

alter table public.source_document_revisions enable row level security;
revoke all on public.source_document_revisions from anon, authenticated;
grant all on public.source_document_revisions to service_role;

create or replace function public.save_source_document_revision(
  p_document_id uuid,
  p_content_wikitext text,
  p_content_language text default 'ko',
  p_summary text default null,
  p_editor_label text default 'admin'
)
returns table(revision_no integer, updated_at timestamptz)
language plpgsql
as $$
declare
  v_revision integer;
  v_updated_at timestamptz := now();
begin
  select d.content_revision_no + 1
    into v_revision
  from public.source_documents d
  where d.id = p_document_id
  for update;

  if v_revision is null then
    raise exception 'source document not found';
  end if;

  insert into public.source_document_revisions (
    source_document_id,
    revision_no,
    content_wikitext,
    content_language,
    summary,
    editor_type,
    editor_label,
    created_at
  ) values (
    p_document_id,
    v_revision,
    p_content_wikitext,
    coalesce(nullif(trim(p_content_language), ''), 'ko'),
    nullif(trim(p_summary), ''),
    'admin',
    nullif(trim(p_editor_label), ''),
    v_updated_at
  );

  update public.source_documents
  set content_wikitext = p_content_wikitext,
      content_language = coalesce(nullif(trim(p_content_language), ''), 'ko'),
      content_status = 'draft',
      content_revision_no = v_revision,
      content_updated_at = v_updated_at,
      content_updated_by = nullif(trim(p_editor_label), ''),
      content_namumark_html = null,
      content_namumark_engine = null,
      content_namumark_engine_version = null,
      content_namumark_rendered_at = null,
      updated_at = v_updated_at
  where id = p_document_id;

  return query select v_revision, v_updated_at;
end;
$$;

revoke all on function public.save_source_document_revision(uuid,text,text,text,text) from public, anon, authenticated;
grant execute on function public.save_source_document_revision(uuid,text,text,text,text) to service_role;
