-- SOMENTE PARA TESTE LOCAL E MODO DEMO (PGlite): imita o que o Supabase já entrega pronto
-- (papéis, schema auth, auth.uid() e privilégios padrão). Nunca aplicar no Supabase real.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon')         then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role')  then create role service_role nologin bypassrls; end if;
end $$;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'
);
create function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

grant usage on schema auth   to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
