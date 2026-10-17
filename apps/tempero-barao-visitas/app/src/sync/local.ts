/**
 * Tabelas que existem SÓ no aparelho (não fazem parte do Supabase): a fila de ações para enviar e o
 * estado da sincronização. Aplicadas pelo banco local depois das migrações.
 */
export const DDL_LOCAL = `
create table if not exists public._outbox (
  id        uuid primary key,
  seq       bigint generated always as identity,
  tipo      text not null,
  dados     jsonb not null,
  ponto_id  uuid,
  criado_em timestamptz not null default now(),
  estado    text not null default 'pendente',   -- pendente | rejeitada
  erro      text,
  codigo    text,
  tentativas int not null default 0
);
create index if not exists _outbox_estado_idx on public._outbox (estado, seq);
create table if not exists public._sync (chave text primary key, valor text);
grant all on public._outbox, public._sync to authenticated;
`;
