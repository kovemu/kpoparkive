alter table public.source_documents
  add column if not exists source_fidelity_meta jsonb,
  add column if not exists source_fidelity_captured_at timestamptz;
