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
