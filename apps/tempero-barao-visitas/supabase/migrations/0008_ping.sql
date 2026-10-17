-- Tempero Barão · Visitas — "ping" para manter o projeto ativo
--
-- Projetos do plano gratuito do Supabase são pausados após cerca de 7 dias com pouca atividade.
-- Esta função devolve só "ok" e a hora do servidor, lendo de verdade o banco. Uma automação externa
-- (GitHub Actions ou cron-job.org) chama a cada poucos dias. Não expõe nenhum dado de cliente.
create or replace function ping() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('ok', exists (select 1 from configuracoes), 'agora', now())
$$;

revoke all on function ping() from public, anon, authenticated;
grant execute on function ping() to anon, authenticated;
