-- Tempero Barão · Visitas — instalação do banco no Supabase
-- GERADO por supabase/gerar_setup.sh a partir de supabase/migrations/*.sql (não edite à mão).
-- Cole TUDO no SQL Editor de um projeto NOVO e execute UMA vez. Não rode em projeto que já tem dados.

-- ============================================================================
-- 0001_base.sql
-- ============================================================================
-- Tempero Barão · Visitas — base de dados (Supabase / Postgres 15+)
--
-- Princípios:
--  * Regra de negócio no banco (cadência, validação de check-in, permissões),
--    para qualquer front (PWA, painel, script) obedecer à mesma regra.
--  * "Universo" (todos os pontos mapeados no Google Earth) é diferente de
--    "carteira" (pontos que alguém atende). Quem decide é `status`.
--  * Cadência é DERIVADA (view), nunca gravada: sempre reflete a última visita.
--  * Sem PostGIS no MVP: distância por haversine basta para milhares de pontos.

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type papel_usuario    as enum ('admin', 'gestor', 'vendedor', 'promotor');
create type status_comercial as enum ('prospecto', 'em_prospeccao', 'ativo', 'inativo', 'perdido');
create type segmento         as enum ('food_service', 'varejo', 'rede', 'outro');
create type tier_cliente     as enum ('A', 'B', 'C');
create type tipo_visita      as enum ('venda', 'prospeccao', 'pos_venda', 'promotoria');
create type resultado_visita as enum (
  'pedido', 'orcamento', 'sem_demanda', 'decisor_ausente', 'reclamacao', 'fechado', 'outro'
);
create type validacao_visita as enum (
  'confirmada',        -- GPS dentro do raio
  'fora_do_raio',      -- GPS longe do ponto cadastrado
  'sem_gps',           -- vendedor não enviou localização
  'sem_coordenadas',   -- ponto sem lat/lng cadastrado
  'validada_gestor'    -- gestor aceitou manualmente
);

-- ---------------------------------------------------------------------------
-- Utilidades
-- ---------------------------------------------------------------------------
create function hoje_local() returns date
language sql stable as $$
  select (now() at time zone 'America/Fortaleza')::date   -- Parnaíba (PI): UTC-3 fixo
$$;

create function distancia_m(lat1 double precision, lng1 double precision,
                            lat2 double precision, lng2 double precision)
returns double precision
language sql immutable parallel safe as $$
  select case
    when lat1 is null or lng1 is null or lat2 is null or lng2 is null then null
    else 2 * 6371000 * asin(sqrt(
           power(sin(radians(lat2 - lat1) / 2), 2)
         + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))
  end
$$;

create function set_atualizado_em() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Usuários
-- ---------------------------------------------------------------------------
create table perfis (
  id        uuid primary key references auth.users (id) on delete cascade,
  nome      text not null,
  papel     papel_usuario not null default 'vendedor',
  ativo     boolean not null default true,
  telefone  text,
  criado_em timestamptz not null default now()
);

-- Todo usuário novo do Auth ganha perfil de vendedor; o admin ajusta o papel.
create function criar_perfil_para_novo_usuario() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into perfis (id, nome)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'nome', split_part(new.email, '@', 1), 'Sem nome'));
  return new;
end $$;

create trigger trg_novo_usuario after insert on auth.users
  for each row execute function criar_perfil_para_novo_usuario();

create function meu_papel() returns papel_usuario
language sql stable security definer set search_path = public as $$
  select papel from perfis where id = auth.uid() and ativo
$$;

create function sou_gestor() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(meu_papel() in ('admin', 'gestor'), false)
$$;

create function sou_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(meu_papel() = 'admin', false)
$$;

-- ---------------------------------------------------------------------------
-- Configuração e regras de cadência (editáveis pela gestão, sem deploy)
-- ---------------------------------------------------------------------------
create table configuracoes (
  chave text primary key,
  valor jsonb not null,
  descricao text
);

insert into configuracoes (chave, valor, descricao) values
  ('raio_checkin_m', '150', 'Distância máxima (m) entre o GPS do check-in e o ponto para a visita ser confirmada'),
  ('edicao_visita_horas', '24', 'Janela (h) em que o autor ainda pode completar/editar a própria visita');

-- Status x tier -> intervalo-alvo (dias) e peso na prioridade.
-- Status sem regra (prospecto, perdido) ficam FORA da cobrança de cadência.
-- Valores iniciais são ponto de partida: calibrar com dados reais do piloto.
create table regras_cadencia (
  status          status_comercial not null,
  tier            tier_cliente not null,
  intervalo_dias  int  not null check (intervalo_dias > 0),
  peso            numeric not null default 1 check (peso > 0),
  primary key (status, tier)
);

insert into regras_cadencia (status, tier, intervalo_dias, peso) values
  ('ativo',         'A', 15, 3),
  ('ativo',         'B', 30, 2),
  ('ativo',         'C', 60, 1),
  ('em_prospeccao', 'A', 10, 3),
  ('em_prospeccao', 'B', 20, 2),
  ('em_prospeccao', 'C', 30, 1),
  ('inativo',       'A', 20, 3),   -- resgate: cliente que parou de comprar
  ('inativo',       'B', 30, 2),
  ('inativo',       'C', 45, 1);

-- ---------------------------------------------------------------------------
-- Territórios e pontos
-- ---------------------------------------------------------------------------
create table regioes (
  id        uuid primary key default gen_random_uuid(),
  nome      text not null unique,
  poligono  jsonb,                      -- anel externo: [[lng,lat],...]
  criado_em timestamptz not null default now()
);

create table estabelecimentos (
  id               uuid primary key default gen_random_uuid(),
  chave_externa    text unique,         -- chave estável do import (evita duplicar ao reimportar)
  nome             text not null,
  segmento         segmento not null default 'outro',
  categoria        text,                -- texto livre: restaurante, lanchonete, mercadinho...
  grupo_origem     text,                -- pasta de origem no Google Earth
  endereco         text,
  bairro           text,
  cidade           text,
  uf               text,
  lat              double precision,
  lng              double precision,
  telefone         text,
  contato          text,
  status           status_comercial not null default 'prospecto',
  tier             tier_cliente not null default 'C',
  intervalo_dias_override int check (intervalo_dias_override > 0),
  vendedor_id      uuid references perfis (id) on delete set null,
  carteira_desde   timestamptz,         -- quando o ponto entrou na carteira atual (base da cadência)
  regiao_id        uuid references regioes (id) on delete set null,
  atributos        jsonb not null default '{}',
  observacoes      text,
  criado_em        timestamptz not null default now(),
  atualizado_em    timestamptz not null default now(),
  constraint coordenadas_juntas check ((lat is null) = (lng is null)),
  constraint lat_valida check (lat is null or lat between -90 and 90),
  constraint lng_valida check (lng is null or lng between -180 and 180)
);

create index estabelecimentos_vendedor_idx on estabelecimentos (vendedor_id);
create index estabelecimentos_status_idx   on estabelecimentos (status);
create index estabelecimentos_regiao_idx   on estabelecimentos (regiao_id);
create index estabelecimentos_geo_idx      on estabelecimentos (lat, lng);

create function estabelecimento_before_write() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  if tg_op = 'INSERT' then
    if new.vendedor_id is not null and new.carteira_desde is null then
      new.carteira_desde := now();
    end if;
  elsif new.vendedor_id is distinct from old.vendedor_id then
    new.carteira_desde := case when new.vendedor_id is null then null else now() end;
  end if;

  -- Quem não é gestor só mexe em dados de contato dos próprios pontos.
  -- Só vale para chamadas diretas da API (current_user = 'authenticated'); funções de negócio
  -- SECURITY DEFINER (ex.: assumir_estabelecimento) rodam como dono e passam por aqui liberadas.
  -- current_user não pode ser forjado pelo cliente. service_role/postgres: sem restrição.
  if tg_op = 'UPDATE' and auth.uid() is not null and current_user = 'authenticated'
     and not sou_gestor() then
    if (new.nome, new.segmento, new.lat, new.lng, new.status, new.tier,
        new.intervalo_dias_override, new.vendedor_id, new.regiao_id, new.chave_externa)
       is distinct from
       (old.nome, old.segmento, old.lat, old.lng, old.status, old.tier,
        old.intervalo_dias_override, old.vendedor_id, old.regiao_id, old.chave_externa) then
      raise exception 'Apenas gestor pode alterar nome, segmento, localização, status, tier, carteira ou região'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger trg_estabelecimento_before_write
  before insert or update on estabelecimentos
  for each row execute function estabelecimento_before_write();

-- ---------------------------------------------------------------------------
-- Visitas
-- ---------------------------------------------------------------------------
create table visitas (
  id                   uuid primary key default gen_random_uuid(),
  chave_idempotencia   uuid unique,      -- gerada no aparelho; reenvio offline não duplica
  estabelecimento_id   uuid not null references estabelecimentos (id) on delete restrict,
  usuario_id           uuid not null references perfis (id),
  tipo                 tipo_visita not null default 'venda',
  checkin_em           timestamptz not null default now(),   -- relógio do aparelho
  checkout_em          timestamptz,
  checkin_lat          double precision,
  checkin_lng          double precision,
  distancia_m          double precision,                     -- calculada no servidor
  validacao            validacao_visita not null default 'sem_gps',
  validada_por         uuid references perfis (id),
  resultado            resultado_visita,
  valor_pedido         numeric(12, 2) check (valor_pedido is null or valor_pedido >= 0),
  proximo_passo        text,
  retorno_em           date,                                 -- retorno combinado com o cliente
  observacao           text,
  fotos                text[] not null default '{}',
  recebido_em          timestamptz not null default now(),   -- relógio do servidor (detecta fraude de data)
  constraint coordenadas_checkin_juntas check ((checkin_lat is null) = (checkin_lng is null)),
  constraint checkout_apos_checkin check (checkout_em is null or checkout_em >= checkin_em)
);

create index visitas_estab_idx   on visitas (estabelecimento_id, checkin_em desc);
create index visitas_usuario_idx on visitas (usuario_id, checkin_em desc);

create function visita_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_lat    double precision;
  v_lng    double precision;
  v_raio   double precision;
  v_janela int;
begin
  if tg_op = 'INSERT' then
    new.recebido_em := now();
    new.validada_por := null;

    select lat, lng into v_lat, v_lng from estabelecimentos where id = new.estabelecimento_id;
    select (valor #>> '{}')::double precision into v_raio from configuracoes where chave = 'raio_checkin_m';
    new.distancia_m := distancia_m(new.checkin_lat, new.checkin_lng, v_lat, v_lng);
    new.validacao := case
      when new.checkin_lat is null then 'sem_gps'
      when v_lat is null           then 'sem_coordenadas'
      when new.distancia_m <= coalesce(v_raio, 150) then 'confirmada'
      else 'fora_do_raio'
    end;
    return new;
  end if;

  -- UPDATE
  if auth.uid() is not null then
    if sou_gestor() then
      -- Gestor valida/invalida manualmente; registra quem foi.
      if new.validacao is distinct from old.validacao then
        new.validada_por := auth.uid();
      end if;
    else
      -- Autor só completa a própria visita, dentro da janela, sem tocar nos campos controlados.
      select (valor #>> '{}')::int into v_janela from configuracoes where chave = 'edicao_visita_horas';
      if old.recebido_em < now() - make_interval(hours => coalesce(v_janela, 24)) then
        raise exception 'Janela de edição da visita encerrada' using errcode = '42501';
      end if;
      if (new.estabelecimento_id, new.usuario_id, new.checkin_em, new.checkin_lat, new.checkin_lng,
          new.distancia_m, new.validacao, new.validada_por, new.recebido_em)
         is distinct from
         (old.estabelecimento_id, old.usuario_id, old.checkin_em, old.checkin_lat, old.checkin_lng,
          old.distancia_m, old.validacao, old.validada_por, old.recebido_em) then
        raise exception 'Campos de check-in e validação não podem ser alterados' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger trg_visita_before_write
  before insert or update on visitas
  for each row execute function visita_before_write();

-- ---------------------------------------------------------------------------
-- Cadência (derivada): o coração do sistema
-- ---------------------------------------------------------------------------
-- Conta como "visita que zera o relógio": confirmada ou validada pelo gestor,
-- de qualquer tipo exceto promotoria (promotor repõe gôndola; não substitui o vendedor).
-- Base do relógio: última visita contada; se nunca visitado, entrada na carteira; senão, cadastro.
-- Retorno combinado só ANTECIPA a próxima visita, nunca adia além do intervalo-alvo
-- (senão o vendedor "escondia" cliente empurrando a data).
create view v_cadencia with (security_invoker = true) as
with ultima as (
  select distinct on (v.estabelecimento_id)
         v.estabelecimento_id,
         v.checkin_em as ultima_visita_em,
         v.retorno_em
    from visitas v
   where v.validacao in ('confirmada', 'validada_gestor')
     and v.tipo <> 'promotoria'
   order by v.estabelecimento_id, v.checkin_em desc
),
base as (
  select e.id as estabelecimento_id,
         e.nome, e.segmento, e.categoria, e.status, e.tier,
         e.vendedor_id, e.regiao_id, e.bairro, e.cidade, e.lat, e.lng,
         u.ultima_visita_em,
         (coalesce(u.ultima_visita_em, e.carteira_desde, e.criado_em)
            at time zone 'America/Fortaleza')::date as base_data,
         coalesce(e.intervalo_dias_override, r.intervalo_dias) as intervalo_dias,
         r.peso,
         case when u.retorno_em >= (u.ultima_visita_em at time zone 'America/Fortaleza')::date
              then u.retorno_em end as retorno_em
    from estabelecimentos e
    join regras_cadencia r on r.status = e.status and r.tier = e.tier
    left join ultima u on u.estabelecimento_id = e.id
),
calc as (
  select b.*,
         least(b.base_data + b.intervalo_dias,
               coalesce(b.retorno_em, b.base_data + b.intervalo_dias)) as proxima_devida
    from base b
)
select c.estabelecimento_id, c.nome, c.segmento, c.categoria, c.status, c.tier,
       c.vendedor_id, c.regiao_id, c.bairro, c.cidade, c.lat, c.lng,
       c.ultima_visita_em,
       (c.ultima_visita_em is null) as nunca_visitado,
       c.intervalo_dias,
       c.proxima_devida,
       (hoje_local() - c.proxima_devida) as dias_atraso,           -- negativo = faltam N dias
       case
         when hoje_local() - c.proxima_devida <= 0                         then 'verde'
         when hoje_local() - c.proxima_devida <= 0.5 * c.intervalo_dias    then 'amarelo'
         when hoje_local() - c.proxima_devida <= 1.0 * c.intervalo_dias    then 'vermelho'
         else 'preto'                                                       -- esquecido
       end as semaforo,
       round(c.peso * (1 + (hoje_local() - c.proxima_devida)::numeric / c.intervalo_dias), 3) as prioridade
  from calc c;

-- Fila do vendedor: o que ele deve visitar, mais urgente primeiro.
-- Inclui o que vence nos próximos `p_horizonte_dias` para ele poder agrupar por região.
create function fila_do_dia(p_lat double precision default null,
                            p_lng double precision default null,
                            p_horizonte_dias int default 3,
                            p_limite int default 50)
returns table (
  estabelecimento_id uuid, nome text, segmento segmento, status status_comercial, tier tier_cliente,
  bairro text, lat double precision, lng double precision,
  ultima_visita_em timestamptz, nunca_visitado boolean, proxima_devida date, dias_atraso int,
  semaforo text, prioridade numeric, distancia_m double precision
)
language sql stable as $$
  select c.estabelecimento_id, c.nome, c.segmento, c.status, c.tier,
         c.bairro, c.lat, c.lng,
         c.ultima_visita_em, c.nunca_visitado, c.proxima_devida, c.dias_atraso,
         c.semaforo, c.prioridade,
         distancia_m(p_lat, p_lng, c.lat, c.lng)
    from v_cadencia c
   where c.vendedor_id = auth.uid()
     and c.dias_atraso >= -p_horizonte_dias
   order by c.prioridade desc, c.nome
   limit p_limite
$$;

-- Painel do gestor: saúde da carteira por vendedor (vendedor vê só a própria linha, via RLS).
create view v_cobertura_vendedor with (security_invoker = true) as
select c.vendedor_id,
       p.nome as vendedor,
       count(*)                                          as pontos_em_cadencia,
       count(*) filter (where c.semaforo = 'verde')      as em_dia,
       count(*) filter (where c.semaforo = 'amarelo')    as atrasados,
       count(*) filter (where c.semaforo = 'vermelho')   as criticos,
       count(*) filter (where c.semaforo = 'preto')      as esquecidos,
       count(*) filter (where c.nunca_visitado)          as nunca_visitados,
       round(100.0 * count(*) filter (where c.semaforo = 'verde') / count(*), 1) as cobertura_pct
  from v_cadencia c
  left join perfis p on p.id = c.vendedor_id
 group by c.vendedor_id, p.nome;

-- ---------------------------------------------------------------------------
-- Funções de negócio
-- ---------------------------------------------------------------------------
-- Vendedor "assume" um ponto do universo que ainda não tem dono.
create function assumir_estabelecimento(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_papel papel_usuario := meu_papel();
begin
  if auth.uid() is null or v_papel is null then
    raise exception 'Usuário não autenticado ou inativo' using errcode = '42501';
  end if;
  if v_papel not in ('admin', 'gestor', 'vendedor') then
    raise exception 'Apenas vendedores e gestão assumem pontos' using errcode = '42501';
  end if;

  update estabelecimentos
     set vendedor_id = auth.uid(),
         status = case when status = 'prospecto' then 'em_prospeccao' else status end
   where id = p_id
     and vendedor_id is null
     and status in ('prospecto', 'em_prospeccao', 'inativo');

  if not found then
    raise exception 'Ponto indisponível: já tem dono ou não está disponível para prospecção'
      using errcode = 'P0001';
  end if;
end $$;

-- Importação idempotente (KML do Google Earth -> estabelecimentos).
-- Reimportar ATUALIZA nome/endereço/localização e NÃO toca em status, tier,
-- carteira e segmento (decisões comerciais ficam preservadas).
-- Autorização vem do RLS: só gestão/admin (ou service_role) consegue gravar.
create function importar_estabelecimentos(p_itens jsonb, p_regioes jsonb default '[]'::jsonb)
returns jsonb
language plpgsql as $$
declare
  v_inseridos   int := 0;
  v_atualizados int := 0;
  v_regioes     int := 0;
  r             record;
  v_nasceu      boolean;
begin
  for r in select * from jsonb_to_recordset(p_regioes) as x(nome text, poligono jsonb) loop
    insert into regioes (nome, poligono) values (r.nome, r.poligono)
    on conflict (nome) do update set poligono = excluded.poligono;
    v_regioes := v_regioes + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(p_itens) as x(
      chave_externa text, nome text, lat double precision, lng double precision,
      endereco text, bairro text, cidade text, uf text, telefone text,
      categoria text, grupo_origem text, regiao text, atributos jsonb)
  loop
    insert into estabelecimentos
      (chave_externa, nome, lat, lng, endereco, bairro, cidade, uf, telefone,
       categoria, grupo_origem, regiao_id, atributos)
    values
      (r.chave_externa, r.nome, r.lat, r.lng, r.endereco, r.bairro, r.cidade, r.uf, r.telefone,
       r.categoria, r.grupo_origem,
       (select id from regioes where nome = r.regiao),
       coalesce(r.atributos, '{}'::jsonb))
    on conflict (chave_externa) do update set
      nome         = excluded.nome,
      lat          = excluded.lat,
      lng          = excluded.lng,
      endereco     = coalesce(excluded.endereco, estabelecimentos.endereco),
      bairro       = coalesce(excluded.bairro, estabelecimentos.bairro),
      cidade       = coalesce(excluded.cidade, estabelecimentos.cidade),
      uf           = coalesce(excluded.uf, estabelecimentos.uf),
      telefone     = coalesce(excluded.telefone, estabelecimentos.telefone),
      categoria    = coalesce(excluded.categoria, estabelecimentos.categoria),
      grupo_origem = coalesce(excluded.grupo_origem, estabelecimentos.grupo_origem),
      regiao_id    = coalesce(excluded.regiao_id, estabelecimentos.regiao_id),
      atributos    = estabelecimentos.atributos || excluded.atributos
    returning (xmax = 0) into v_nasceu;

    if v_nasceu then v_inseridos := v_inseridos + 1; else v_atualizados := v_atualizados + 1; end if;
  end loop;

  return jsonb_build_object('inseridos', v_inseridos, 'atualizados', v_atualizados, 'regioes', v_regioes);
end $$;

-- ---------------------------------------------------------------------------
-- Segurança (RLS)
-- ---------------------------------------------------------------------------
alter table perfis            enable row level security;
alter table configuracoes     enable row level security;
alter table regras_cadencia   enable row level security;
alter table regioes           enable row level security;
alter table estabelecimentos  enable row level security;
alter table visitas           enable row level security;

-- perfis: cada um vê o próprio; gestão vê todos; só admin gerencia.
create policy perfis_select on perfis for select to authenticated
  using (id = auth.uid() or sou_gestor());
create policy perfis_admin_write on perfis for all to authenticated
  using (sou_admin()) with check (sou_admin());

-- configuração, regras e regiões: todos leem; gestão escreve.
create policy configuracoes_select on configuracoes for select to authenticated using (true);
create policy configuracoes_write  on configuracoes for all to authenticated
  using (sou_gestor()) with check (sou_gestor());
create policy regras_select on regras_cadencia for select to authenticated using (true);
create policy regras_write  on regras_cadencia for all to authenticated
  using (sou_gestor()) with check (sou_gestor());
create policy regioes_select on regioes for select to authenticated using (true);
create policy regioes_write  on regioes for all to authenticated
  using (sou_gestor()) with check (sou_gestor());

-- estabelecimentos: gestão vê tudo; os demais veem a própria carteira + pontos sem dono
-- (para prospectar). Carteira de outro vendedor fica invisível.
create policy estab_select on estabelecimentos for select to authenticated
  using (sou_gestor() or vendedor_id = auth.uid() or vendedor_id is null);
create policy estab_gestor_write on estabelecimentos for all to authenticated
  using (sou_gestor()) with check (sou_gestor());
create policy estab_update_proprio on estabelecimentos for update to authenticated
  using (vendedor_id = auth.uid()) with check (vendedor_id = auth.uid());

-- visitas: gestão vê tudo; autor vê as suas. Só registra visita em ponto que enxerga.
create policy visitas_select on visitas for select to authenticated
  using (sou_gestor() or usuario_id = auth.uid());
create policy visitas_insert on visitas for insert to authenticated
  with check (
    usuario_id = auth.uid()
    and meu_papel() is not null
    and exists (select 1 from estabelecimentos e where e.id = estabelecimento_id)
  );
create policy visitas_update_gestor on visitas for update to authenticated
  using (sou_gestor()) with check (sou_gestor());
create policy visitas_update_autor on visitas for update to authenticated
  using (usuario_id = auth.uid()) with check (usuario_id = auth.uid());

-- Privilégios: nada para anon; authenticated só o necessário (RLS faz o resto).
-- Funções nascem executáveis por PUBLIC no Postgres: revogar de todos e liberar só o que a API usa.
revoke all on all tables    in schema public from anon;
revoke all on all functions in schema public from public, anon, authenticated;
grant select, insert, update, delete on perfis, configuracoes, regras_cadencia, regioes,
                                        estabelecimentos to authenticated;
grant select, insert, update on visitas to authenticated;
grant select on v_cadencia, v_cobertura_vendedor to authenticated;
-- usadas dentro de policies/views/triggers executados com os direitos de quem chama:
grant execute on function hoje_local(), meu_papel(), sou_gestor(), sou_admin(),
                          distancia_m(double precision, double precision, double precision, double precision)
  to authenticated;
-- expostas como RPC:
grant execute on function fila_do_dia(double precision, double precision, int, int) to authenticated;
grant execute on function assumir_estabelecimento(uuid) to authenticated;
grant execute on function importar_estabelecimentos(jsonb, jsonb) to authenticated;

-- ============================================================================
-- 0002_importacao_erp.sql
-- ============================================================================
-- Tempero Barão · Visitas — importação com dados do ERP
--
-- O mapa do Google Earth da Barão traz, em cada ponto, o cadastro do ERP (código do cliente,
-- razão social, CNPJ, CEP, telefones). Guardamos o que a operação usa e NÃO guardamos CPF/RG
-- nem limite de crédito (minimização de dados — LGPD): o importador já descarta esses campos.

-- ---------------------------------------------------------------------------
-- Colunas novas
-- ---------------------------------------------------------------------------
alter table estabelecimentos
  add column codigo_erp    text,
  add column razao_social  text,
  add column cnpj          text,
  add column cep           text,
  add column celular       text;

create index estabelecimentos_erp_idx on estabelecimentos (codigo_erp);

-- Liga as pastas/vendedores do mapa aos usuários do sistema (ex.: 'joao-oliveira').
alter table perfis add column chave_import text unique;

-- Rótulos por bairro (ex.: valores de venda anotados no mapa) ficam na região.
alter table regioes add column atributos jsonb not null default '{}';

-- ---------------------------------------------------------------------------
-- Proteção de colunas: dados cadastrais do ERP também são só da gestão
-- (vendedor continua editando telefone, celular, contato e observações dos próprios pontos)
-- ---------------------------------------------------------------------------
create or replace function estabelecimento_before_write() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  if tg_op = 'INSERT' then
    if new.vendedor_id is not null and new.carteira_desde is null then
      new.carteira_desde := now();
    end if;
  elsif new.vendedor_id is distinct from old.vendedor_id then
    new.carteira_desde := case when new.vendedor_id is null then null else now() end;
  end if;

  -- Só vale para chamadas diretas da API (current_user = 'authenticated'); funções de negócio
  -- SECURITY DEFINER (ex.: assumir_estabelecimento) rodam como dono e passam por aqui liberadas.
  -- current_user não pode ser forjado pelo cliente. service_role/postgres: sem restrição.
  if tg_op = 'UPDATE' and auth.uid() is not null and current_user = 'authenticated'
     and not sou_gestor() then
    if (new.nome, new.segmento, new.lat, new.lng, new.status, new.tier,
        new.intervalo_dias_override, new.vendedor_id, new.regiao_id, new.chave_externa,
        new.codigo_erp, new.razao_social, new.cnpj)
       is distinct from
       (old.nome, old.segmento, old.lat, old.lng, old.status, old.tier,
        old.intervalo_dias_override, old.vendedor_id, old.regiao_id, old.chave_externa,
        old.codigo_erp, old.razao_social, old.cnpj) then
      raise exception 'Apenas gestor pode alterar nome, segmento, localização, status, tier, carteira, região ou dados do ERP'
        using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Importação idempotente v2
-- ---------------------------------------------------------------------------
-- Reimportar ATUALIZA identificação, endereço, contato e localização.
-- NÃO sobrescreve decisões comerciais: status, tier, segmento, carteira (vendedor) e observações
-- ficam como estão. Exceção útil: se o ponto ainda não tem vendedor, o do arquivo é aplicado.
-- Na criação, status/tier/segmento/vendedor vêm do mapeamento de pastas feito na tela de importação.
-- Autorização vem do RLS: só gestão/admin (ou service_role) consegue gravar.
create or replace function importar_estabelecimentos(p_itens jsonb, p_regioes jsonb default '[]'::jsonb)
returns jsonb
language plpgsql as $$
declare
  v_inseridos   int := 0;
  v_atualizados int := 0;
  v_regioes     int := 0;
  v_sem_dono    int := 0;
  r             record;
  v_nasceu      boolean;
  v_vendedor    uuid;
begin
  for r in select * from jsonb_to_recordset(p_regioes) as x(nome text, poligono jsonb, atributos jsonb) loop
    insert into regioes (nome, poligono, atributos)
    values (r.nome, r.poligono, coalesce(r.atributos, '{}'::jsonb))
    on conflict (nome) do update
      set poligono  = excluded.poligono,
          atributos = regioes.atributos || excluded.atributos;
    v_regioes := v_regioes + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(p_itens) as x(
      chave_externa text, nome text, lat double precision, lng double precision,
      endereco text, bairro text, cidade text, uf text, cep text,
      telefone text, celular text, contato text,
      codigo_erp text, razao_social text, cnpj text, observacoes text,
      categoria text, grupo_origem text, regiao text, atributos jsonb,
      segmento text, status text, tier text, vendedor_chave text)
  loop
    v_vendedor := null;
    if r.vendedor_chave is not null then
      select id into v_vendedor from perfis where chave_import = r.vendedor_chave;
      if v_vendedor is null then v_sem_dono := v_sem_dono + 1; end if;
    end if;

    insert into estabelecimentos
      (chave_externa, nome, lat, lng, endereco, bairro, cidade, uf, cep, telefone, celular, contato,
       codigo_erp, razao_social, cnpj, observacoes, categoria, grupo_origem, regiao_id, atributos,
       segmento, status, tier, vendedor_id)
    values
      (r.chave_externa, r.nome, r.lat, r.lng, r.endereco, r.bairro, r.cidade, r.uf, r.cep,
       r.telefone, r.celular, r.contato,
       r.codigo_erp, r.razao_social, r.cnpj, r.observacoes, r.categoria, r.grupo_origem,
       (select id from regioes where nome = r.regiao),
       coalesce(r.atributos, '{}'::jsonb),
       coalesce(r.segmento, 'outro')::segmento,
       coalesce(r.status, 'prospecto')::status_comercial,
       coalesce(r.tier, 'C')::tier_cliente,
       v_vendedor)
    on conflict (chave_externa) do update set
      nome         = excluded.nome,
      lat          = excluded.lat,
      lng          = excluded.lng,
      endereco     = coalesce(excluded.endereco, estabelecimentos.endereco),
      bairro       = coalesce(excluded.bairro, estabelecimentos.bairro),
      cidade       = coalesce(excluded.cidade, estabelecimentos.cidade),
      uf           = coalesce(excluded.uf, estabelecimentos.uf),
      cep          = coalesce(excluded.cep, estabelecimentos.cep),
      telefone     = coalesce(excluded.telefone, estabelecimentos.telefone),
      celular      = coalesce(excluded.celular, estabelecimentos.celular),
      contato      = coalesce(excluded.contato, estabelecimentos.contato),
      codigo_erp   = coalesce(excluded.codigo_erp, estabelecimentos.codigo_erp),
      razao_social = coalesce(excluded.razao_social, estabelecimentos.razao_social),
      cnpj         = coalesce(excluded.cnpj, estabelecimentos.cnpj),
      observacoes  = coalesce(estabelecimentos.observacoes, excluded.observacoes),
      categoria    = coalesce(excluded.categoria, estabelecimentos.categoria),
      grupo_origem = coalesce(excluded.grupo_origem, estabelecimentos.grupo_origem),
      regiao_id    = coalesce(excluded.regiao_id, estabelecimentos.regiao_id),
      atributos    = estabelecimentos.atributos || excluded.atributos,
      vendedor_id  = coalesce(estabelecimentos.vendedor_id, excluded.vendedor_id)
    returning (xmax = 0) into v_nasceu;

    if v_nasceu then v_inseridos := v_inseridos + 1; else v_atualizados := v_atualizados + 1; end if;
  end loop;

  return jsonb_build_object('inseridos', v_inseridos, 'atualizados', v_atualizados,
                            'regioes', v_regioes, 'vendedor_nao_encontrado', v_sem_dono);
end $$;

-- ============================================================================
-- 0003_inicio_da_cadencia.sql
-- ============================================================================
-- Tempero Barão · Visitas — como a cadência COMEÇA ao importar
--
-- Problema real: o mapa do Google Earth não diz quando cada cliente foi visitado pela última vez.
-- Se todos entram "visitados hoje", o painel nasce 100% verde e a fila do vendedor nasce vazia —
-- parece quebrado, e ninguém é cobrado por semanas. Três jeitos de começar (escolha da gestão):
--
--   zero        todos entram em dia hoje (a cobrança só aparece depois de um intervalo inteiro)
--   escalonado  (recomendado) finge-se que a última visita foi há um tempo aleatório dentro do ciclo:
--               os vencimentos ficam espalhados no tempo, sem muralha de visitas no mesmo dia
--   vencidos    todos vencem hoje ("mutirão"): a fila nasce cheia, em ordem de prioridade
--
-- Só vale para pontos NOVOS que já entram com vendedor. Reimportar não mexe em ninguém.
-- A posição de cada ponto no ciclo é determinística (hash da chave): reimportar não embaralha.

drop function importar_estabelecimentos(jsonb, jsonb);

create function importar_estabelecimentos(
  p_itens   jsonb,
  p_regioes jsonb default '[]'::jsonb,
  p_inicio  text  default 'zero'
)
returns jsonb
language plpgsql as $$
declare
  v_inseridos   int := 0;
  v_atualizados int := 0;
  v_regioes     int := 0;
  v_sem_dono    int := 0;
  r             record;
  v_nasceu      boolean;
  v_id          uuid;
  v_novos       uuid[] := '{}';
  v_vendedor    uuid;
begin
  if p_inicio not in ('zero', 'escalonado', 'vencidos') then
    raise exception 'p_inicio inválido: % (use zero, escalonado ou vencidos)', p_inicio;
  end if;

  for r in select * from jsonb_to_recordset(p_regioes) as x(nome text, poligono jsonb, atributos jsonb) loop
    insert into regioes (nome, poligono, atributos)
    values (r.nome, r.poligono, coalesce(r.atributos, '{}'::jsonb))
    on conflict (nome) do update
      set poligono  = excluded.poligono,
          atributos = regioes.atributos || excluded.atributos;
    v_regioes := v_regioes + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(p_itens) as x(
      chave_externa text, nome text, lat double precision, lng double precision,
      endereco text, bairro text, cidade text, uf text, cep text,
      telefone text, celular text, contato text,
      codigo_erp text, razao_social text, cnpj text, observacoes text,
      categoria text, grupo_origem text, regiao text, atributos jsonb,
      segmento text, status text, tier text, vendedor_chave text)
  loop
    v_vendedor := null;
    if r.vendedor_chave is not null then
      select id into v_vendedor from perfis where chave_import = r.vendedor_chave;
      if v_vendedor is null then v_sem_dono := v_sem_dono + 1; end if;
    end if;

    insert into estabelecimentos
      (chave_externa, nome, lat, lng, endereco, bairro, cidade, uf, cep, telefone, celular, contato,
       codigo_erp, razao_social, cnpj, observacoes, categoria, grupo_origem, regiao_id, atributos,
       segmento, status, tier, vendedor_id)
    values
      (r.chave_externa, r.nome, r.lat, r.lng, r.endereco, r.bairro, r.cidade, r.uf, r.cep,
       r.telefone, r.celular, r.contato,
       r.codigo_erp, r.razao_social, r.cnpj, r.observacoes, r.categoria, r.grupo_origem,
       (select id from regioes where nome = r.regiao),
       coalesce(r.atributos, '{}'::jsonb),
       coalesce(r.segmento, 'outro')::segmento,
       coalesce(r.status, 'prospecto')::status_comercial,
       coalesce(r.tier, 'C')::tier_cliente,
       v_vendedor)
    on conflict (chave_externa) do update set
      nome         = excluded.nome,
      lat          = excluded.lat,
      lng          = excluded.lng,
      endereco     = coalesce(excluded.endereco, estabelecimentos.endereco),
      bairro       = coalesce(excluded.bairro, estabelecimentos.bairro),
      cidade       = coalesce(excluded.cidade, estabelecimentos.cidade),
      uf           = coalesce(excluded.uf, estabelecimentos.uf),
      cep          = coalesce(excluded.cep, estabelecimentos.cep),
      telefone     = coalesce(excluded.telefone, estabelecimentos.telefone),
      celular      = coalesce(excluded.celular, estabelecimentos.celular),
      contato      = coalesce(excluded.contato, estabelecimentos.contato),
      codigo_erp   = coalesce(excluded.codigo_erp, estabelecimentos.codigo_erp),
      razao_social = coalesce(excluded.razao_social, estabelecimentos.razao_social),
      cnpj         = coalesce(excluded.cnpj, estabelecimentos.cnpj),
      observacoes  = coalesce(estabelecimentos.observacoes, excluded.observacoes),
      categoria    = coalesce(excluded.categoria, estabelecimentos.categoria),
      grupo_origem = coalesce(excluded.grupo_origem, estabelecimentos.grupo_origem),
      regiao_id    = coalesce(excluded.regiao_id, estabelecimentos.regiao_id),
      atributos    = estabelecimentos.atributos || excluded.atributos,
      vendedor_id  = coalesce(estabelecimentos.vendedor_id, excluded.vendedor_id)
    returning (xmax = 0), id into v_nasceu, v_id;

    if v_nasceu then
      v_inseridos := v_inseridos + 1;
      v_novos := v_novos || v_id;
    else
      v_atualizados := v_atualizados + 1;
    end if;
  end loop;

  -- início da cadência dos pontos novos que já têm vendedor e entram em cobrança
  if p_inicio <> 'zero' and cardinality(v_novos) > 0 then
    update estabelecimentos e
       set carteira_desde = now() - make_interval(days => (
             case p_inicio
               when 'vencidos' then coalesce(e.intervalo_dias_override, c.intervalo_dias)
               else (hashtext(e.chave_externa)::bigint & 2147483647)
                    % coalesce(e.intervalo_dias_override, c.intervalo_dias)
             end)::int)
      from regras_cadencia c
     where e.id = any (v_novos)
       and e.vendedor_id is not null
       and c.status = e.status and c.tier = e.tier;
  end if;

  return jsonb_build_object('inseridos', v_inseridos, 'atualizados', v_atualizados,
                            'regioes', v_regioes, 'vendedor_nao_encontrado', v_sem_dono);
end $$;

-- funções novas nascem executáveis por PUBLIC: manter só quem a API usa
revoke all on function importar_estabelecimentos(jsonb, jsonb, text) from public, anon;
grant execute on function importar_estabelecimentos(jsonb, jsonb, text) to authenticated;

-- ============================================================================
-- 0004_cadastro_e_visibilidade.sql
-- ============================================================================
-- Tempero Barão · Visitas — cadastro na plataforma, duplicados e visibilidade entre vendedores
--
-- Regras de negócio pedidas pela Barão:
--  1. Cada vendedor ACESSA só os próprios clientes (ficha, telefone, histórico, ERP).
--  2. Os clientes dos OUTROS vendedores aparecem para ele no mapa e na lista, mas "já vinculados"
--     a outro vendedor (só nome, bairro, cidade e localização — sem dados de contato nem cadastro).
--     Assim ninguém cadastra em duplicidade nem visita o cliente do colega sem saber.
--  3. Dá para cadastrar cliente direto na plataforma (não só vir do Google Earth / ERP), com
--     detecção de duplicados por CNPJ, código do ERP e nome+cidade.
--  4. Cliente sem localização pode ganhar o ponto pelo GPS do vendedor (uma vez); corrigir
--     uma localização já existente é só da gestão (senão dá para "mover o pino" até onde se está).

-- ---------------------------------------------------------------------------
-- Utilidades de texto
-- ---------------------------------------------------------------------------
create function norm_texto(t text) returns text
language sql immutable parallel safe as $$
  select trim(regexp_replace(lower(translate(coalesce(t, ''),
    'ÁÀÂÃÄáàâãäÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇç',
    'AAAAAaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCc')), '[^a-z0-9]+', ' ', 'g'))
$$;

create function so_digitos(t text) returns text
language sql immutable parallel safe as $$
  select regexp_replace(coalesce(t, ''), '\D', '', 'g')
$$;

create index estabelecimentos_cnpj_idx on estabelecimentos (so_digitos(cnpj));
create index estabelecimentos_nome_idx on estabelecimentos (norm_texto(nome));

-- ---------------------------------------------------------------------------
-- Pontos de TODOS (colunas mínimas): o que um vendedor pode ver dos clientes dos outros
-- ---------------------------------------------------------------------------
-- View comum (executa com os direitos do dono, de propósito: ela é a "janela" controlada).
-- status/classe só aparecem para o próprio vendedor, para pontos livres e para a gestão.
create view v_pontos_mapa as
select e.id,
       e.nome,
       e.segmento,
       e.bairro,
       e.cidade,
       e.lat,
       e.lng,
       e.vendedor_id,
       p.nome as vendedor_nome,
       coalesce(e.vendedor_id = auth.uid(), false) as meu,
       (e.vendedor_id is null) as livre,
       case when e.vendedor_id is null or e.vendedor_id = auth.uid() or sou_gestor() then e.status end as status,
       case when e.vendedor_id is null or e.vendedor_id = auth.uid() or sou_gestor() then e.tier end as tier
  from estabelecimentos e
  left join perfis p on p.id = e.vendedor_id
 where e.status <> 'perdido'
   and meu_papel() is not null;

-- ---------------------------------------------------------------------------
-- Duplicados
-- ---------------------------------------------------------------------------
create function buscar_duplicados(
  p_nome        text default null,
  p_cnpj        text default null,
  p_codigo_erp  text default null,
  p_cidade      text default null
)
returns table (
  id uuid, nome text, bairro text, cidade text,
  vendedor_nome text, meu boolean, livre boolean, motivo text
)
language sql stable security definer set search_path = public as $$
  select e.id, e.nome, e.bairro, e.cidade, p.nome,
         coalesce(e.vendedor_id = auth.uid(), false),
         (e.vendedor_id is null),
         case
           when length(so_digitos(p_cnpj)) = 14 and so_digitos(e.cnpj) = so_digitos(p_cnpj) then 'mesmo CNPJ'
           when nullif(p_codigo_erp, '') is not null and e.codigo_erp = p_codigo_erp then 'mesmo código do ERP'
           else 'mesmo nome e cidade'
         end
    from estabelecimentos e
    left join perfis p on p.id = e.vendedor_id
   where meu_papel() is not null
     and (
          (length(so_digitos(p_cnpj)) = 14 and so_digitos(e.cnpj) = so_digitos(p_cnpj))
       or (nullif(p_codigo_erp, '') is not null and e.codigo_erp = p_codigo_erp)
       or (length(norm_texto(p_nome)) >= 4
           and norm_texto(e.nome) = norm_texto(p_nome)
           and (norm_texto(p_cidade) = '' or norm_texto(e.cidade) = norm_texto(p_cidade)))
     )
   limit 5
$$;

-- ---------------------------------------------------------------------------
-- Cadastro direto na plataforma
-- ---------------------------------------------------------------------------
-- Vendedor: o cliente entra SEMPRE na própria carteira (status ativo ou em prospecção).
-- Gestão: pode escolher vendedor e status, e pode forçar mesmo havendo possível duplicado.
create function cadastrar_estabelecimento(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_papel  papel_usuario := meu_papel();
  v_gestao boolean;
  v_nome   text := nullif(trim(p ->> 'nome'), '');
  v_dup    record;
  v_dono   uuid;
  v_status status_comercial;
  v_lat    double precision := nullif(p ->> 'lat', '')::double precision;
  v_lng    double precision := nullif(p ->> 'lng', '')::double precision;
  v_id     uuid;
begin
  if auth.uid() is null or v_papel is null then
    raise exception 'Usuário não autenticado ou inativo' using errcode = '42501';
  end if;
  if v_papel not in ('admin', 'gestor', 'vendedor') then
    raise exception 'Apenas vendedores e gestão cadastram clientes' using errcode = '42501';
  end if;
  v_gestao := v_papel in ('admin', 'gestor');

  if v_nome is null then
    raise exception 'Informe o nome do cliente' using errcode = '22023';
  end if;
  if (v_lat is null) <> (v_lng is null) then
    raise exception 'Informe latitude e longitude juntas' using errcode = '22023';
  end if;
  if v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180) then
    raise exception 'Coordenadas inválidas' using errcode = '22023';
  end if;

  select * into v_dup from buscar_duplicados(v_nome, p ->> 'cnpj', p ->> 'codigo_erp', p ->> 'cidade') limit 1;
  if found and not (v_gestao and coalesce((p ->> 'forcar')::boolean, false)) then
    raise exception 'Já existe "%" (%): %.', v_dup.nome, v_dup.motivo,
      case when v_dup.meu then 'já está na sua carteira'
           when v_dup.livre then 'está sem vendedor; assuma o ponto em vez de cadastrar de novo'
           else 'já vinculado a ' || coalesce(v_dup.vendedor_nome, 'outro vendedor') end
      using errcode = '23505', detail = v_dup.id::text;
  end if;

  v_dono := case when v_gestao then nullif(p ->> 'vendedor_id', '')::uuid else auth.uid() end;
  v_status := coalesce(nullif(p ->> 'status', ''), 'em_prospeccao')::status_comercial;
  if not v_gestao and v_status not in ('ativo', 'em_prospeccao') then
    v_status := 'em_prospeccao';
  end if;

  insert into estabelecimentos
    (chave_externa, nome, razao_social, cnpj, codigo_erp, endereco, bairro, cidade, uf, cep,
     telefone, celular, contato, segmento, tier, status, vendedor_id, lat, lng,
     categoria, observacoes, atributos)
  values
    ('app:' || gen_random_uuid(), v_nome, nullif(trim(p ->> 'razao_social'), ''), nullif(trim(p ->> 'cnpj'), ''),
     nullif(trim(p ->> 'codigo_erp'), ''), nullif(trim(p ->> 'endereco'), ''), nullif(trim(p ->> 'bairro'), ''),
     nullif(trim(p ->> 'cidade'), ''), nullif(trim(p ->> 'uf'), ''), nullif(trim(p ->> 'cep'), ''),
     nullif(trim(p ->> 'telefone'), ''), nullif(trim(p ->> 'celular'), ''), nullif(trim(p ->> 'contato'), ''),
     coalesce(nullif(p ->> 'segmento', ''), 'outro')::segmento,
     coalesce(nullif(p ->> 'tier', ''), 'C')::tier_cliente,
     v_status, v_dono, v_lat, v_lng,
     'Cadastrado no app', nullif(trim(p ->> 'observacoes'), ''),
     jsonb_build_object('origem', 'app', 'cadastrado_por', auth.uid()))
  returning id into v_id;

  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- Localização de cliente que veio sem coordenada
-- ---------------------------------------------------------------------------
create function definir_localizacao(p_id uuid, p_lat double precision, p_lng double precision) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_papel  papel_usuario := meu_papel();
  v_gestao boolean;
  e        estabelecimentos;
begin
  if auth.uid() is null or v_papel is null then
    raise exception 'Usuário não autenticado ou inativo' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or p_lat not between -90 and 90 or p_lng not between -180 and 180 then
    raise exception 'Coordenadas inválidas' using errcode = '22023';
  end if;
  v_gestao := v_papel in ('admin', 'gestor');

  select * into e from estabelecimentos where id = p_id;
  if not found or not (v_gestao or (e.vendedor_id = auth.uid() and v_papel = 'vendedor')) then
    raise exception 'Sem permissão para definir a localização deste ponto' using errcode = '42501';
  end if;
  if e.lat is not null and not v_gestao then
    raise exception 'Este ponto já tem localização; só a gestão pode corrigi-la' using errcode = '42501';
  end if;

  update estabelecimentos
     set lat = p_lat,
         lng = p_lng,
         atributos = (atributos - 'coordenada_suspeita')
                     || jsonb_build_object('localizacao_definida_por', auth.uid(),
                                           'localizacao_definida_em', now())
   where id = p_id;
end $$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function norm_texto(text), so_digitos(text), buscar_duplicados(text, text, text, text),
  cadastrar_estabelecimento(jsonb), definir_localizacao(uuid, double precision, double precision)
  from public, anon, authenticated;
grant execute on function norm_texto(text), so_digitos(text) to authenticated;
grant execute on function buscar_duplicados(text, text, text, text) to authenticated;
grant execute on function cadastrar_estabelecimento(jsonb) to authenticated;
grant execute on function definir_localizacao(uuid, double precision, double precision) to authenticated;

revoke all on v_pontos_mapa from public, anon;
grant select on v_pontos_mapa to authenticated;

-- ============================================================================
-- 0005_importacao_de_planilha.sql
-- ============================================================================
-- Tempero Barão · Visitas — importação de planilha sem apagar o que o mapa já sabe
--
-- Linhas vindas de planilha do ERP (marcadas com atributos.fonte_planilha) casam com pontos do
-- Google Earth pelo código do ERP. Nesse caso:
--   * a planilha NÃO traz localização: coordenadas nulas não podem apagar o pino que já existe;
--   * o nome já curado no mapa (digitado pela equipe) é mantido; cadastro, endereço e telefones atualizam.
-- Mesma regra para qualquer item sem coordenada: o pino existente prevalece.

create or replace function importar_estabelecimentos(
  p_itens   jsonb,
  p_regioes jsonb default '[]'::jsonb,
  p_inicio  text  default 'zero'
)
returns jsonb
language plpgsql as $$
declare
  v_inseridos   int := 0;
  v_atualizados int := 0;
  v_regioes     int := 0;
  v_sem_dono    int := 0;
  r             record;
  v_nasceu      boolean;
  v_id          uuid;
  v_novos       uuid[] := '{}';
  v_vendedor    uuid;
begin
  if p_inicio not in ('zero', 'escalonado', 'vencidos') then
    raise exception 'p_inicio inválido: % (use zero, escalonado ou vencidos)', p_inicio;
  end if;

  for r in select * from jsonb_to_recordset(p_regioes) as x(nome text, poligono jsonb, atributos jsonb) loop
    insert into regioes (nome, poligono, atributos)
    values (r.nome, r.poligono, coalesce(r.atributos, '{}'::jsonb))
    on conflict (nome) do update
      set poligono  = excluded.poligono,
          atributos = regioes.atributos || excluded.atributos;
    v_regioes := v_regioes + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(p_itens) as x(
      chave_externa text, nome text, lat double precision, lng double precision,
      endereco text, bairro text, cidade text, uf text, cep text,
      telefone text, celular text, contato text,
      codigo_erp text, razao_social text, cnpj text, observacoes text,
      categoria text, grupo_origem text, regiao text, atributos jsonb,
      segmento text, status text, tier text, vendedor_chave text)
  loop
    v_vendedor := null;
    if r.vendedor_chave is not null then
      select id into v_vendedor from perfis where chave_import = r.vendedor_chave;
      if v_vendedor is null then v_sem_dono := v_sem_dono + 1; end if;
    end if;

    insert into estabelecimentos
      (chave_externa, nome, lat, lng, endereco, bairro, cidade, uf, cep, telefone, celular, contato,
       codigo_erp, razao_social, cnpj, observacoes, categoria, grupo_origem, regiao_id, atributos,
       segmento, status, tier, vendedor_id)
    values
      (r.chave_externa, r.nome, r.lat, r.lng, r.endereco, r.bairro, r.cidade, r.uf, r.cep,
       r.telefone, r.celular, r.contato,
       r.codigo_erp, r.razao_social, r.cnpj, r.observacoes, r.categoria, r.grupo_origem,
       (select id from regioes where nome = r.regiao),
       coalesce(r.atributos, '{}'::jsonb),
       coalesce(r.segmento, 'outro')::segmento,
       coalesce(r.status, 'prospecto')::status_comercial,
       coalesce(r.tier, 'C')::tier_cliente,
       v_vendedor)
    on conflict (chave_externa) do update set
      -- planilha do ERP não traz localização nem tem o nome "curado" do mapa: não pode apagar nenhum dos dois
      nome         = case when excluded.atributos ? 'fonte_planilha' then estabelecimentos.nome else excluded.nome end,
      lat          = coalesce(excluded.lat, estabelecimentos.lat),
      lng          = coalesce(excluded.lng, estabelecimentos.lng),
      endereco     = coalesce(excluded.endereco, estabelecimentos.endereco),
      bairro       = coalesce(excluded.bairro, estabelecimentos.bairro),
      cidade       = coalesce(excluded.cidade, estabelecimentos.cidade),
      uf           = coalesce(excluded.uf, estabelecimentos.uf),
      cep          = coalesce(excluded.cep, estabelecimentos.cep),
      telefone     = coalesce(excluded.telefone, estabelecimentos.telefone),
      celular      = coalesce(excluded.celular, estabelecimentos.celular),
      contato      = coalesce(excluded.contato, estabelecimentos.contato),
      codigo_erp   = coalesce(excluded.codigo_erp, estabelecimentos.codigo_erp),
      razao_social = coalesce(excluded.razao_social, estabelecimentos.razao_social),
      cnpj         = coalesce(excluded.cnpj, estabelecimentos.cnpj),
      observacoes  = coalesce(estabelecimentos.observacoes, excluded.observacoes),
      categoria    = coalesce(excluded.categoria, estabelecimentos.categoria),
      grupo_origem = coalesce(excluded.grupo_origem, estabelecimentos.grupo_origem),
      regiao_id    = coalesce(excluded.regiao_id, estabelecimentos.regiao_id),
      atributos    = estabelecimentos.atributos || excluded.atributos,
      vendedor_id  = coalesce(estabelecimentos.vendedor_id, excluded.vendedor_id)
    returning (xmax = 0), id into v_nasceu, v_id;

    if v_nasceu then
      v_inseridos := v_inseridos + 1;
      v_novos := v_novos || v_id;
    else
      v_atualizados := v_atualizados + 1;
    end if;
  end loop;

  -- início da cadência dos pontos novos que já têm vendedor e entram em cobrança
  if p_inicio <> 'zero' and cardinality(v_novos) > 0 then
    update estabelecimentos e
       set carteira_desde = now() - make_interval(days => (
             case p_inicio
               when 'vencidos' then coalesce(e.intervalo_dias_override, c.intervalo_dias)
               else (hashtext(e.chave_externa)::bigint & 2147483647)
                    % coalesce(e.intervalo_dias_override, c.intervalo_dias)
             end)::int)
      from regras_cadencia c
     where e.id = any (v_novos)
       and e.vendedor_id is not null
       and c.status = e.status and c.tier = e.tier;
  end if;

  return jsonb_build_object('inseridos', v_inseridos, 'atualizados', v_atualizados,
                            'regioes', v_regioes, 'vendedor_nao_encontrado', v_sem_dono);
end $$;

-- ============================================================================
-- 0006_planilha_casa_com_mapa.sql
-- ============================================================================
-- Tempero Barão · Visitas — planilha casa com o mapa por CNPJ e nome provisório vira nome real
--
-- Acrescenta à importação de 0005:
--   * linha de planilha sem código do ERP, com CNPJ já cadastrado em outro ponto (ex.: pino do mapa),
--     atualiza esse ponto em vez de criar um duplicado (e o contrário: mapa depois da planilha);
--   * cliente criado com nome provisório (atributos.nome_provisorio, a partir do endereço) é casado
--     por endereço + cidade quando a planilha seguinte traz o nome de verdade, e recebe esse nome.
--
-- (cabeçalho original da 0005 abaixo)
--
-- Linhas vindas de planilha do ERP (marcadas com atributos.fonte_planilha) casam com pontos do
-- Google Earth pelo código do ERP. Nesse caso:
--   * a planilha NÃO traz localização: coordenadas nulas não podem apagar o pino que já existe;
--   * o nome já curado no mapa (digitado pela equipe) é mantido; cadastro, endereço e telefones atualizam.
-- Mesma regra para qualquer item sem coordenada: o pino existente prevalece.

create or replace function importar_estabelecimentos(
  p_itens   jsonb,
  p_regioes jsonb default '[]'::jsonb,
  p_inicio  text  default 'zero'
)
returns jsonb
language plpgsql as $$
declare
  v_inseridos   int := 0;
  v_atualizados int := 0;
  v_regioes     int := 0;
  v_sem_dono    int := 0;
  r             record;
  v_nasceu      boolean;
  v_id          uuid;
  v_novos       uuid[] := '{}';
  v_vendedor    uuid;
  v_chave       text;
begin
  if p_inicio not in ('zero', 'escalonado', 'vencidos') then
    raise exception 'p_inicio inválido: % (use zero, escalonado ou vencidos)', p_inicio;
  end if;

  for r in select * from jsonb_to_recordset(p_regioes) as x(nome text, poligono jsonb, atributos jsonb) loop
    insert into regioes (nome, poligono, atributos)
    values (r.nome, r.poligono, coalesce(r.atributos, '{}'::jsonb))
    on conflict (nome) do update
      set poligono  = excluded.poligono,
          atributos = regioes.atributos || excluded.atributos;
    v_regioes := v_regioes + 1;
  end loop;

  for r in
    select * from jsonb_to_recordset(p_itens) as x(
      chave_externa text, nome text, lat double precision, lng double precision,
      endereco text, bairro text, cidade text, uf text, cep text,
      telefone text, celular text, contato text,
      codigo_erp text, razao_social text, cnpj text, observacoes text,
      categoria text, grupo_origem text, regiao text, atributos jsonb,
      segmento text, status text, tier text, vendedor_chave text)
  loop
    v_vendedor := null;
    if r.vendedor_chave is not null then
      select id into v_vendedor from perfis where chave_import = r.vendedor_chave;
      if v_vendedor is null then v_sem_dono := v_sem_dono + 1; end if;
    end if;

    -- mesmo cliente com outra chave? (CNPJ completo sem código; endereço de um cadastro provisório)
    if not exists (select 1 from estabelecimentos where chave_externa = r.chave_externa) then
      select e.chave_externa into v_chave
        from estabelecimentos e
       where ((r.atributos ? 'fonte_planilha') or (e.atributos ? 'fonte_planilha'))
         and (
              (nullif(r.codigo_erp, '') is null and length(so_digitos(r.cnpj)) = 14
               and so_digitos(e.cnpj) = so_digitos(r.cnpj))
           or (e.atributos ? 'nome_provisorio' and not coalesce(r.atributos ? 'nome_provisorio', false)
               and length(norm_texto(r.endereco)) >= 6
               and norm_texto(e.endereco) = norm_texto(r.endereco)
               and norm_texto(e.cidade) = norm_texto(r.cidade))
         )
       order by (so_digitos(e.cnpj) = so_digitos(r.cnpj)) desc nulls last, e.criado_em
       limit 1;
      if v_chave is not null then r.chave_externa := v_chave; v_chave := null; end if;
    end if;

    insert into estabelecimentos
      (chave_externa, nome, lat, lng, endereco, bairro, cidade, uf, cep, telefone, celular, contato,
       codigo_erp, razao_social, cnpj, observacoes, categoria, grupo_origem, regiao_id, atributos,
       segmento, status, tier, vendedor_id)
    values
      (r.chave_externa, r.nome, r.lat, r.lng, r.endereco, r.bairro, r.cidade, r.uf, r.cep,
       r.telefone, r.celular, r.contato,
       r.codigo_erp, r.razao_social, r.cnpj, r.observacoes, r.categoria, r.grupo_origem,
       (select id from regioes where nome = r.regiao),
       coalesce(r.atributos, '{}'::jsonb),
       coalesce(r.segmento, 'outro')::segmento,
       coalesce(r.status, 'prospecto')::status_comercial,
       coalesce(r.tier, 'C')::tier_cliente,
       v_vendedor)
    on conflict (chave_externa) do update set
      -- planilha do ERP não traz localização nem tem o nome "curado" do mapa: não pode apagar nenhum dos dois
      nome         = case when excluded.atributos ? 'fonte_planilha'
                           and not (estabelecimentos.atributos ? 'nome_provisorio'
                                    and not (excluded.atributos ? 'nome_provisorio'))
                          then estabelecimentos.nome else excluded.nome end,
      lat          = coalesce(excluded.lat, estabelecimentos.lat),
      lng          = coalesce(excluded.lng, estabelecimentos.lng),
      endereco     = coalesce(excluded.endereco, estabelecimentos.endereco),
      bairro       = coalesce(excluded.bairro, estabelecimentos.bairro),
      cidade       = coalesce(excluded.cidade, estabelecimentos.cidade),
      uf           = coalesce(excluded.uf, estabelecimentos.uf),
      cep          = coalesce(excluded.cep, estabelecimentos.cep),
      telefone     = coalesce(excluded.telefone, estabelecimentos.telefone),
      celular      = coalesce(excluded.celular, estabelecimentos.celular),
      contato      = coalesce(excluded.contato, estabelecimentos.contato),
      codigo_erp   = coalesce(excluded.codigo_erp, estabelecimentos.codigo_erp),
      razao_social = coalesce(excluded.razao_social, estabelecimentos.razao_social),
      cnpj         = coalesce(excluded.cnpj, estabelecimentos.cnpj),
      observacoes  = coalesce(estabelecimentos.observacoes, excluded.observacoes),
      categoria    = coalesce(excluded.categoria, estabelecimentos.categoria),
      grupo_origem = coalesce(excluded.grupo_origem, estabelecimentos.grupo_origem),
      regiao_id    = coalesce(excluded.regiao_id, estabelecimentos.regiao_id),
      atributos    = case when excluded.atributos ? 'nome_provisorio'
                          then estabelecimentos.atributos || excluded.atributos
                          else (estabelecimentos.atributos || excluded.atributos) - 'nome_provisorio' end,
      vendedor_id  = coalesce(estabelecimentos.vendedor_id, excluded.vendedor_id)
    returning (xmax = 0), id into v_nasceu, v_id;

    if v_nasceu then
      v_inseridos := v_inseridos + 1;
      v_novos := v_novos || v_id;
    else
      v_atualizados := v_atualizados + 1;
    end if;
  end loop;

  -- início da cadência dos pontos novos que já têm vendedor e entram em cobrança
  if p_inicio <> 'zero' and cardinality(v_novos) > 0 then
    update estabelecimentos e
       set carteira_desde = now() - make_interval(days => (
             case p_inicio
               when 'vencidos' then coalesce(e.intervalo_dias_override, c.intervalo_dias)
               else (hashtext(e.chave_externa)::bigint & 2147483647)
                    % coalesce(e.intervalo_dias_override, c.intervalo_dias)
             end)::int)
      from regras_cadencia c
     where e.id = any (v_novos)
       and e.vendedor_id is not null
       and c.status = e.status and c.tier = e.tier;
  end if;

  return jsonb_build_object('inseridos', v_inseridos, 'atualizados', v_atualizados,
                            'regioes', v_regioes, 'vendedor_nao_encontrado', v_sem_dono);
end $$;

-- ============================================================================
-- 0007_sincronizacao.sql
-- ============================================================================
-- Tempero Barão · Visitas — sincronização do celular (offline) com o servidor
--
-- O aparelho guarda uma cópia local (o mesmo Postgres, no navegador) do que o usuário pode ver e
-- trabalha nela mesmo sem sinal. Duas funções fazem a ponte:
--   sync_baixar(p)   servidor -> aparelho: só o que mudou desde a última vez (ou tudo, na 1ª vez),
--                    respeitando a visibilidade (cliente de outro vendedor chega só com nome, bairro,
--                    cidade e local). Roda com os direitos de quem chama: o RLS vale.
--   sync_enviar(ops) aparelho -> servidor: fila de ações feitas offline, aplicadas na ordem, cada
--                    uma isolada (uma recusada não derruba as outras) e idempotente (reenvio não duplica).
-- Toda regra continua sendo a do banco (cadência, raio de check-in, permissões): o servidor
-- revalida tudo, o aparelho nunca "manda" sozinho.

-- ---------------------------------------------------------------------------
-- Marca de alteração das visitas (para baixar só o que mudou)
-- ---------------------------------------------------------------------------
alter table visitas add column atualizado_em timestamptz not null default now();
create index visitas_atualizado_idx on visitas (atualizado_em);
create index estabelecimentos_atualizado_idx on estabelecimentos (atualizado_em);

create function visita_atualizado() returns trigger
language plpgsql as $$
begin
  new.atualizado_em := now();
  return new;
end $$;

create trigger trg_visita_atualizado
  before insert or update on visitas
  for each row execute function visita_atualizado();

-- ---------------------------------------------------------------------------
-- Cadastro com identificador do aparelho (reenvio não duplica)
-- ---------------------------------------------------------------------------
create or replace function cadastrar_estabelecimento(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_papel  papel_usuario := meu_papel();
  v_gestao boolean;
  v_nome   text := nullif(trim(p ->> 'nome'), '');
  v_dup    record;
  v_dono   uuid;
  v_status status_comercial;
  v_lat    double precision := nullif(p ->> 'lat', '')::double precision;
  v_lng    double precision := nullif(p ->> 'lng', '')::double precision;
  v_id     uuid := coalesce(nullif(p ->> 'id', '')::uuid, gen_random_uuid());
begin
  if auth.uid() is null or v_papel is null then
    raise exception 'Usuário não autenticado ou inativo' using errcode = '42501';
  end if;
  if v_papel not in ('admin', 'gestor', 'vendedor') then
    raise exception 'Apenas vendedores e gestão cadastram clientes' using errcode = '42501';
  end if;
  v_gestao := v_papel in ('admin', 'gestor');

  -- reenvio (fila offline do celular): o aparelho gera o id; se este cadastro já chegou, devolve o mesmo
  if exists (select 1 from estabelecimentos where id = v_id) then
    if exists (select 1 from estabelecimentos
                where id = v_id and atributos ->> 'cadastrado_por' = auth.uid()::text) then
      return v_id;
    end if;
    raise exception 'Identificador já usado por outro cadastro' using errcode = '42501';
  end if;

  if v_nome is null then
    raise exception 'Informe o nome do cliente' using errcode = '22023';
  end if;
  if (v_lat is null) <> (v_lng is null) then
    raise exception 'Informe latitude e longitude juntas' using errcode = '22023';
  end if;
  if v_lat is not null and (v_lat not between -90 and 90 or v_lng not between -180 and 180) then
    raise exception 'Coordenadas inválidas' using errcode = '22023';
  end if;

  select * into v_dup from buscar_duplicados(v_nome, p ->> 'cnpj', p ->> 'codigo_erp', p ->> 'cidade') limit 1;
  if found and not (v_gestao and coalesce((p ->> 'forcar')::boolean, false)) then
    raise exception 'Já existe "%" (%): %.', v_dup.nome, v_dup.motivo,
      case when v_dup.meu then 'já está na sua carteira'
           when v_dup.livre then 'está sem vendedor; assuma o ponto em vez de cadastrar de novo'
           else 'já vinculado a ' || coalesce(v_dup.vendedor_nome, 'outro vendedor') end
      using errcode = '23505', detail = v_dup.id::text;
  end if;

  v_dono := case when v_gestao then nullif(p ->> 'vendedor_id', '')::uuid else auth.uid() end;
  v_status := coalesce(nullif(p ->> 'status', ''), 'em_prospeccao')::status_comercial;
  if not v_gestao and v_status not in ('ativo', 'em_prospeccao') then
    v_status := 'em_prospeccao';
  end if;

  insert into estabelecimentos
    (id, chave_externa, nome, razao_social, cnpj, codigo_erp, endereco, bairro, cidade, uf, cep,
     telefone, celular, contato, segmento, tier, status, vendedor_id, lat, lng,
     categoria, observacoes, atributos)
  values
    (v_id, 'app:' || v_id, v_nome, nullif(trim(p ->> 'razao_social'), ''), nullif(trim(p ->> 'cnpj'), ''),
     nullif(trim(p ->> 'codigo_erp'), ''), nullif(trim(p ->> 'endereco'), ''), nullif(trim(p ->> 'bairro'), ''),
     nullif(trim(p ->> 'cidade'), ''), nullif(trim(p ->> 'uf'), ''), nullif(trim(p ->> 'cep'), ''),
     nullif(trim(p ->> 'telefone'), ''), nullif(trim(p ->> 'celular'), ''), nullif(trim(p ->> 'contato'), ''),
     coalesce(nullif(p ->> 'segmento', ''), 'outro')::segmento,
     coalesce(nullif(p ->> 'tier', ''), 'C')::tier_cliente,
     v_status, v_dono, v_lat, v_lng,
     'Cadastrado no app', nullif(trim(p ->> 'observacoes'), ''),
     jsonb_build_object('origem', 'app', 'cadastrado_por', auth.uid()));

  return v_id;
end $$;
-- ---------------------------------------------------------------------------
-- Clientes de outros vendedores, só o mínimo (janela controlada, como v_pontos_mapa)
-- ---------------------------------------------------------------------------
-- Para quem não é gestão. `removido` = ponto perdido (some do mapa de todos).
create view v_sync_outros as
select e.id, e.nome, e.segmento, e.bairro, e.cidade, e.lat, e.lng, e.vendedor_id,
       e.criado_em, e.atualizado_em, (e.status = 'perdido') as removido
  from estabelecimentos e
 where meu_papel() is not null
   and not sou_gestor()
   and e.vendedor_id is not null
   and e.vendedor_id <> auth.uid();

-- Nome de quem é dono dessas carteiras ("vinculado a Fulano"); perfis é restrito por RLS, então a janela é esta view.
create view v_sync_donos as
select p.id, p.nome, p.papel, p.ativo, p.criado_em, null::text as chave_import
  from perfis p
 where meu_papel() is not null
   and not sou_gestor()
   and p.id in (select vendedor_id from v_sync_outros);

-- ---------------------------------------------------------------------------
-- Servidor -> aparelho
-- ---------------------------------------------------------------------------
-- p: { "desde": timestamptz|null, "ids": [uuid...], "regioes": bool }
--   desde  só o que mudou depois (o aparelho já desconta uma folga); null = tudo
--   ids    reler estes pontos mesmo sem mudança (após uma ação recusada)
create function sync_baixar(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql stable set search_path = public as $$
declare
  v_desde  timestamptz := nullif(p ->> 'desde', '')::timestamptz;
  v_ids    uuid[] := coalesce(array(select jsonb_array_elements_text(p -> 'ids')::uuid), '{}');
  v_gestao boolean := sou_gestor();
  v_full   boolean := v_desde is null;
  v_visitas_desde timestamptz := coalesce(v_desde, now() - interval '800 days');
begin
  if auth.uid() is null or meu_papel() is null then
    raise exception 'Usuário não autenticado ou inativo' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'agora', clock_timestamp(),
    'completo', v_full,
    'eu', auth.uid(),
    'perfis', (
      select coalesce(jsonb_agg(to_jsonb(x)), '[]')
        from (
          select id, nome, papel, ativo, criado_em, chave_import from perfis -- RLS: eu, ou todos (gestão)
          union
          select id, nome, papel, ativo, criado_em, chave_import from v_sync_donos -- donos das carteiras que aparecem no mapa
        ) x
    ),
    'configuracoes', (select coalesce(jsonb_agg(to_jsonb(c)), '[]') from configuracoes c),
    'regras', (select coalesce(jsonb_agg(to_jsonb(r)), '[]') from regras_cadencia r),
    'regioes', case when v_full or coalesce((p ->> 'regioes')::boolean, false)
                    then (select coalesce(jsonb_agg(to_jsonb(g)), '[]') from regioes g)
                    else null end,
    'estabelecimentos', (
      select coalesce(jsonb_agg(x), '[]')
        from (
          select to_jsonb(e) as x                                          -- RLS: carteira própria + livres (gestão: tudo)
            from estabelecimentos e
           where v_full or e.atualizado_em > v_desde or e.id = any (v_ids)
          union all
          select jsonb_build_object(                                       -- carteira alheia: só o mínimo
                   'id', o.id, 'nome', o.nome, 'segmento', o.segmento, 'bairro', o.bairro, 'cidade', o.cidade,
                   'lat', o.lat, 'lng', o.lng, 'vendedor_id', o.vendedor_id,
                   'status', case when o.removido then 'perdido' else 'prospecto' end,
                   'tier', 'C', 'atributos', '{}'::jsonb,
                   'criado_em', o.criado_em, 'atualizado_em', o.atualizado_em)
            from v_sync_outros o
           where v_full or o.atualizado_em > v_desde or o.id = any (v_ids)
        ) t
    ),
    'visitas', (
      select coalesce(jsonb_agg(to_jsonb(v)), '[]')                        -- RLS: as minhas (gestão: todas)
        from visitas v
       where v.atualizado_em > v_visitas_desde
    )
  );
end $$;

-- ---------------------------------------------------------------------------
-- Aparelho -> servidor
-- ---------------------------------------------------------------------------
-- p_ops: [{ "id": "<uuid da ação>", "tipo": "...", "dados": {...} }, ...]
-- Resposta: [{ "id", "ok": true }, { "id", "ok": false, "erro": "...", "codigo": "42501", "tentar_de_novo": false }]
-- `tentar_de_novo` só para falha passageira (deadlock/serialização); o resto é recusa definitiva.
create function sync_enviar(p_ops jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  o        record;
  d        jsonb;
  n        int;
  v_res    jsonb := '[]'::jsonb;
  v_estab  estabelecimentos;
begin
  if auth.uid() is null or meu_papel() is null then
    raise exception 'Usuário não autenticado ou inativo' using errcode = '42501';
  end if;
  if jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) > 200 then
    raise exception 'Lote inválido (use até 200 ações)' using errcode = '22023';
  end if;

  for o in select value as op from jsonb_array_elements(p_ops) loop
    d := coalesce(o.op -> 'dados', '{}'::jsonb);
    begin
      case o.op ->> 'tipo'
        when 'visita' then
          -- usuario_id é SEMPRE quem está logado; o RLS exige que o ponto seja visível; o gatilho calcula
          -- distância e validação com o GPS e o raio do servidor
          insert into visitas (id, chave_idempotencia, estabelecimento_id, usuario_id, tipo, checkin_em, checkout_em,
                               checkin_lat, checkin_lng, resultado, valor_pedido, proximo_passo, retorno_em, observacao)
          values ((d ->> 'chave')::uuid, (d ->> 'chave')::uuid, (d ->> 'estabelecimento_id')::uuid, auth.uid(),
                  coalesce(nullif(d ->> 'tipo', ''), 'venda')::tipo_visita,
                  (d ->> 'checkin_em')::timestamptz, nullif(d ->> 'checkout_em', '')::timestamptz,
                  nullif(d ->> 'checkin_lat', '')::double precision, nullif(d ->> 'checkin_lng', '')::double precision,
                  nullif(d ->> 'resultado', '')::resultado_visita, nullif(d ->> 'valor_pedido', '')::numeric,
                  nullif(d ->> 'proximo_passo', ''), nullif(d ->> 'retorno_em', '')::date, nullif(d ->> 'observacao', ''))
          on conflict do nothing;

        when 'cadastro' then
          perform cadastrar_estabelecimento(d);

        when 'localizacao' then
          select * into v_estab from estabelecimentos where id = (d ->> 'id')::uuid;
          if found and v_estab.lat = (d ->> 'lat')::double precision and v_estab.lng = (d ->> 'lng')::double precision then
            null;   -- reenvio: já está assim
          else
            perform definir_localizacao((d ->> 'id')::uuid, (d ->> 'lat')::double precision, (d ->> 'lng')::double precision);
          end if;

        when 'assumir' then
          if exists (select 1 from estabelecimentos where id = (d ->> 'id')::uuid and vendedor_id = auth.uid()) then
            null;   -- reenvio: já é meu
          else
            perform assumir_estabelecimento((d ->> 'id')::uuid);
          end if;

        when 'contato' then
          update estabelecimentos
             set telefone = nullif(d ->> 'telefone', ''), celular = nullif(d ->> 'celular', ''),
                 contato = nullif(d ->> 'contato', ''), observacoes = nullif(d ->> 'observacoes', '')
           where id = (d ->> 'id')::uuid;
          get diagnostics n = row_count;
          if n = 0 then raise exception 'Ponto indisponível ou sem permissão para editar' using errcode = '42501'; end if;

        when 'atualizar_pontos' then      -- gestão (RLS e gatilho barram os demais)
          update estabelecimentos
             set status = coalesce(nullif(d ->> 'status', '')::status_comercial, status),
                 tier = coalesce(nullif(d ->> 'tier', '')::tier_cliente, tier),
                 segmento = coalesce(nullif(d ->> 'segmento', '')::segmento, segmento),
                 vendedor_id = case when d ? 'vendedor_id' then nullif(d ->> 'vendedor_id', '')::uuid else vendedor_id end
           where id in (select jsonb_array_elements_text(d -> 'ids')::uuid);
          get diagnostics n = row_count;
          if n = 0 then raise exception 'Nenhum ponto alterado (sem permissão?)' using errcode = '42501'; end if;

        when 'regra' then
          update regras_cadencia
             set intervalo_dias = (d ->> 'intervalo_dias')::int, peso = (d ->> 'peso')::numeric
           where status = (d ->> 'status')::status_comercial and tier = (d ->> 'tier')::tier_cliente;
          get diagnostics n = row_count;
          if n = 0 then raise exception 'Regra não alterada (sem permissão?)' using errcode = '42501'; end if;

        when 'raio' then
          update configuracoes set valor = to_jsonb((d ->> 'metros')::int) where chave = 'raio_checkin_m';
          get diagnostics n = row_count;
          if n = 0 then raise exception 'Configuração não alterada (sem permissão?)' using errcode = '42501'; end if;

        when 'validar_visita' then
          update visitas set validacao = 'validada_gestor' where id = (d ->> 'id')::uuid;
          get diagnostics n = row_count;
          if n = 0 then raise exception 'Visita não encontrada ou sem permissão' using errcode = '42501'; end if;

        else
          raise exception 'Tipo de ação desconhecido: %', o.op ->> 'tipo' using errcode = '22023';
      end case;
      v_res := v_res || jsonb_build_object('id', o.op ->> 'id', 'ok', true);
    exception when others then
      v_res := v_res || jsonb_build_object('id', o.op ->> 'id', 'ok', false, 'erro', sqlerrm, 'codigo', sqlstate,
                                            'tentar_de_novo', sqlstate in ('40001', '40P01', '55P03'));
    end;
  end loop;
  return v_res;
end $$;

-- ---------------------------------------------------------------------------
-- Privilégios
-- ---------------------------------------------------------------------------
revoke all on function sync_baixar(jsonb), sync_enviar(jsonb), visita_atualizado() from public, anon, authenticated;
grant execute on function sync_baixar(jsonb) to authenticated;
grant execute on function sync_enviar(jsonb) to authenticated;
revoke all on v_sync_outros, v_sync_donos from public, anon;
grant select on v_sync_outros, v_sync_donos to authenticated;

-- ============================================================================
-- 0008_ping.sql
-- ============================================================================
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
