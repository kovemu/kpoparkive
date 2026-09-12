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

create or replace function public.get_public_wiki_index()
returns table (
  source_title text,
  translated_title text,
  published_at timestamptz,
  published_revision_no integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    d.source_title,
    d.translated_title,
    d.published_at,
    d.published_revision_no
  from public.source_documents d
  where d.source = 'namu_mirror'
    and coalesce(d.published_revision_no, 0) > 0
    and d.published_namumark_html is not null
    and length(d.published_namumark_html) > 0
    and d.source_title not like '틀:%'
  order by d.source_title;
$function$;

revoke all on function public.get_public_wiki_index() from public;
grant execute on function public.get_public_wiki_index() to anon, authenticated;

create or replace function public.search_public_wiki(p_query text)
returns table (
  source_title text,
  translated_title text,
  root_title text,
  content_language text,
  published_revision_no integer,
  content_wikitext text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with q as (
    select lower(left(btrim(coalesce(p_query, '')), 120)) as value
  )
  select
    d.source_title,
    d.translated_title,
    d.root_title,
    d.published_content_language as content_language,
    d.published_revision_no,
    d.published_content_wikitext as content_wikitext
  from public.source_documents d
  cross join q
  where q.value <> ''
    and d.source = 'namu_mirror'
    and coalesce(d.published_revision_no, 0) > 0
    and d.published_namumark_html is not null
    and length(d.published_namumark_html) > 0
    and d.source_title not like '틀:%'
    and d.source_title not like '파일:%'
    and (
      position(q.value in lower(coalesce(d.translated_title, ''))) > 0
      or position(q.value in lower(coalesce(d.source_title, ''))) > 0
      or position(q.value in lower(coalesce(d.root_title, ''))) > 0
      or position(q.value in lower(coalesce(d.published_content_wikitext, ''))) > 0
    )
  order by
    case
      when lower(coalesce(d.translated_title, '')) = q.value then 0
      when lower(coalesce(d.translated_title, '')) like q.value || '%' then 1
      when position(q.value in lower(coalesce(d.translated_title, ''))) > 0 then 2
      when lower(coalesce(d.root_title, '')) like q.value || '%' then 3
      when position(q.value in lower(coalesce(d.root_title, ''))) > 0 then 4
      when position(q.value in lower(coalesce(d.source_title, ''))) > 0 then 5
      else 6
    end,
    length(coalesce(d.translated_title, d.source_title)),
    d.source_title
  limit 80;
$function$;

revoke all on function public.search_public_wiki(text) from public;
grant execute on function public.search_public_wiki(text) to anon, authenticated;
