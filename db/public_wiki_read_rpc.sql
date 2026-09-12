-- Public read surface for /w/... pages.
-- Keeps source_documents and source_asset_queue behind RLS while exposing only
-- already-published wiki HTML and the resolved image rows needed to render it.

create or replace function public.get_public_wiki_page(p_source_title text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with doc as (
    select
      d.id,
      d.source_title,
      d.root_title,
      d.translated_title,
      d.published_revision_no,
      d.published_namumark_html
    from public.source_documents d
    where d.source = 'namu_mirror'
      and lower(d.source_title) = lower(p_source_title)
      and coalesce(d.published_revision_no, 0) > 0
      and d.published_namumark_html is not null
      and length(d.published_namumark_html) > 0
    order by
      case when d.source_title = p_source_title then 0 else 1 end,
      d.source_title
    limit 1
  ),
  asset_rows as (
    select
      a.source_ref,
      a.label,
      a.status,
      a.resolved_url,
      a.storage_path,
      jsonb_strip_nulls(
        jsonb_build_object(
          'original_url', a.metadata->>'original_url',
          'enrichment_url', a.metadata->>'enrichment_url'
        )
      ) as metadata
    from public.source_asset_queue a
    join doc d on d.id = a.source_document_id
    where a.asset_type = 'image'
      and a.status = 'resolved'
    order by a.source_ref
    limit 500
  ),
  assets as (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_ref', source_ref,
          'label', label,
          'status', status,
          'resolved_url', resolved_url,
          'storage_path', storage_path,
          'metadata', metadata
        )
        order by source_ref
      ),
      '[]'::jsonb
    ) as items
    from asset_rows
  )
  select jsonb_build_object(
    'document',
      jsonb_build_object(
        'id', d.id,
        'source_title', d.source_title,
        'root_title', d.root_title,
        'translated_title', d.translated_title,
        'published_revision_no', d.published_revision_no,
        'published_namumark_html', d.published_namumark_html
      ),
    'assets', a.items
  )
  from doc d
  cross join assets a;
$function$;

create or replace function public.get_public_wiki_meta(p_source_title text)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'source_title', d.source_title,
    'translated_title', d.translated_title,
    'published_revision_no', d.published_revision_no
  )
  from public.source_documents d
  where d.source = 'namu_mirror'
    and lower(d.source_title) = lower(p_source_title)
    and coalesce(d.published_revision_no, 0) > 0
    and d.published_namumark_html is not null
    and length(d.published_namumark_html) > 0
  order by
    case when d.source_title = p_source_title then 0 else 1 end,
    d.source_title
  limit 1;
$function$;

revoke all on function public.get_public_wiki_page(text) from public;
revoke all on function public.get_public_wiki_meta(text) from public;

grant execute on function public.get_public_wiki_page(text) to anon, authenticated;
grant execute on function public.get_public_wiki_meta(text) to anon, authenticated;
