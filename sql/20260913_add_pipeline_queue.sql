create table if not exists public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  root_title text not null,
  status text not null default 'queued'
    check (status in ('queued','running','paused','completed','failed','cancelled')),
  scope_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  review_count integer not null default 0,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists pipeline_runs_root_created_idx
  on public.pipeline_runs(root_title, created_at desc);

create index if not exists pipeline_runs_status_created_idx
  on public.pipeline_runs(status, created_at desc);

create table if not exists public.pipeline_jobs (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.pipeline_runs(id) on delete cascade,
  source_document_id uuid not null references public.source_documents(id) on delete cascade,
  source_title text not null,
  stage text not null
    check (stage in ('raw','source_render','translation','en_render','publish','integration_qa')),
  status text not null default 'queued'
    check (status in ('queued','running','pass','retry','needs_review','failed','skipped')),
  attempt integer not null default 0,
  max_attempts integer not null default 3,
  chunk_current integer not null default 0,
  chunk_total integer not null default 0,
  checkpoint jsonb not null default '{}'::jsonb,
  last_error text,
  locked_by text,
  locked_at timestamptz,
  started_at timestamptz,
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (run_id, source_document_id, stage)
);

create index if not exists pipeline_jobs_run_status_stage_idx
  on public.pipeline_jobs(run_id, status, stage);

create index if not exists pipeline_jobs_document_run_idx
  on public.pipeline_jobs(source_document_id, run_id);

create index if not exists pipeline_jobs_claim_idx
  on public.pipeline_jobs(status, stage, updated_at)
  where status in ('queued','retry');

alter table public.pipeline_runs enable row level security;
alter table public.pipeline_jobs enable row level security;

revoke all on public.pipeline_runs from anon, authenticated;
revoke all on public.pipeline_jobs from anon, authenticated;

grant all on public.pipeline_runs to service_role;
grant all on public.pipeline_jobs to service_role;

create or replace function public.claim_pipeline_job(
  p_run_id uuid,
  p_worker_id text,
  p_stage text default null
)
returns public.pipeline_jobs
language plpgsql
security invoker
set search_path = public
as $$
declare
  claimed public.pipeline_jobs;
begin
  with candidate as (
    select id
    from public.pipeline_jobs
    where run_id = p_run_id
      and status in ('queued','retry')
      and (p_stage is null or stage = p_stage)
    order by
      case stage
        when 'raw' then 1
        when 'source_render' then 2
        when 'translation' then 3
        when 'en_render' then 4
        when 'publish' then 5
        when 'integration_qa' then 6
        else 99
      end,
      updated_at asc,
      source_title asc
    for update skip locked
    limit 1
  )
  update public.pipeline_jobs j
  set
    status = 'running',
    attempt = j.attempt + 1,
    locked_by = p_worker_id,
    locked_at = now(),
    started_at = coalesce(j.started_at, now()),
    updated_at = now(),
    last_error = null
  from candidate
  where j.id = candidate.id
  returning j.* into claimed;

  return claimed;
end;
$$;

revoke all on function public.claim_pipeline_job(uuid, text, text) from public, anon, authenticated;
grant execute on function public.claim_pipeline_job(uuid, text, text) to service_role;
