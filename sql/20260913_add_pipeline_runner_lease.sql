alter table public.pipeline_runs
  add column if not exists runner_id text,
  add column if not exists heartbeat_at timestamptz;

create index if not exists pipeline_runs_heartbeat_idx
  on public.pipeline_runs(status, heartbeat_at)
  where status in ('queued','running','paused');

create or replace function public.claim_pipeline_run(
  p_run_id uuid,
  p_runner_id text,
  p_stale_seconds integer default 120
)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected integer := 0;
begin
  update public.pipeline_runs
  set
    runner_id = p_runner_id,
    heartbeat_at = now(),
    updated_at = now()
  where id = p_run_id
    and (
      runner_id is null
      or runner_id = p_runner_id
      or heartbeat_at is null
      or heartbeat_at < now() - make_interval(secs => greatest(30, p_stale_seconds))
    );

  get diagnostics affected = row_count;
  return affected = 1;
end;
$$;

revoke all on function public.claim_pipeline_run(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.claim_pipeline_run(uuid, text, integer)
  to service_role;
