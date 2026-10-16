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
