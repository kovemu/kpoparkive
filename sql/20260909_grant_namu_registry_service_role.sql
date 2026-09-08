-- The local Chrome capture helper uses the Supabase service-role key through PostgREST.
-- Newly created registry/link tables still require explicit table privileges for PostgREST.
grant select, insert, update, delete on table public.source_document_clusters to service_role;
grant select, insert, update, delete on table public.source_document_links to service_role;
