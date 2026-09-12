-- Public wiki reads may return a published English NamuMark source even when
-- its HTML snapshot has not been materialized yet. The /w route renders that
-- trusted published source with the exact The Tree renderer. Korean source
-- capture is never exposed as the production fallback.

create or replace function public.get_public_wiki_page(p_source_title text)
returns jsonb
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  with doc as (
    select
      d.id,
      d.source_title,
      d.root_title,
      d.translated_title,
      d.published_revision_no,
      d.published_namumark_html,
      d.published_content_wikitext,
      d.published_content_language
    from public.source_documents d
    where d.source = 'namu_mirror'
      and lower(d.source_title) = lower(p_source_title)
      and coalesce(d.published_revision_no, 0) > 0
      and (
        (
          d.published_namumark_html is not null
          and length(d.published_namumark_html) > 0
        )
        or (
          d.published_content_language = 'en'
          and d.published_content_wikitext is not null
          and length(d.published_content_wikitext) > 0
        )
      )
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
        'published_namumark_html', d.published_namumark_html,
        'published_content_wikitext', d.published_content_wikitext,
        'published_content_language', d.published_content_language
      ),
    'assets', a.items
  )
  from doc d
  cross join assets a;
$function$;
