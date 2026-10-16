-- Testes da base. Roda como superusuário num banco descartável (ver run_tests.sh).
-- Falha = psql aborta (ON_ERROR_STOP) e o runner retorna erro.
-- Convenção: cada bloco que mexe em dados roda em transação e termina com ROLLBACK.
\set ON_ERROR_STOP on
\set G  '00000000-0000-0000-0000-00000000000a'
\set V1 '00000000-0000-0000-0000-000000000001'
\set V2 '00000000-0000-0000-0000-000000000002'
\set P1 '00000000-0000-0000-0000-0000000000f1'

-- Ajudantes só de teste ------------------------------------------------------
create function t_eid(p_chave text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from estabelecimentos where chave_externa = p_chave
$$;

-- Visita "histórica": p_dias atrás, no ponto exato (ou ~1 km longe).
create function t_visita(p_chave text, p_usuario uuid, p_dias int,
                         p_tipo tipo_visita default 'venda', p_retorno date default null,
                         p_longe boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  insert into visitas (estabelecimento_id, usuario_id, tipo, checkin_em,
                       checkin_lat, checkin_lng, retorno_em)
  select e.id, p_usuario, p_tipo, now() - make_interval(days => p_dias),
         e.lat + case when p_longe then 0.01 else 0 end, e.lng, p_retorno
    from estabelecimentos e where e.chave_externa = p_chave
  returning id into v_id;
  return v_id;
end $$;

grant execute on function t_eid(text), t_visita(text, uuid, int, tipo_visita, date, boolean)
  to authenticated;

-- ===========================================================================
-- Massa de teste (commitada; os testes seguintes não a alteram de forma permanente)
-- ===========================================================================
insert into auth.users (id, email, raw_user_meta_data) values
  (:'G',  'gestor@exemplo.test',    '{"nome":"Gestor"}'),
  (:'V1', 'vendedor1@exemplo.test', '{"nome":"Vendedor 1"}'),
  (:'V2', 'vendedor2@exemplo.test', '{}'),
  (:'P1', 'promotor1@exemplo.test', '{"nome":"Promotor 1"}');

update perfis set papel = 'gestor'   where id = :'G';
update perfis set papel = 'promotor' where id = :'P1';

select importar_estabelecimentos('[
  {"chave_externa":"k1","nome":"Restaurante Teste 1","lat":-2.9050,"lng":-41.7760,"categoria":"Restaurantes"},
  {"chave_externa":"k2","nome":"Mercado Teste 2","lat":-2.9100,"lng":-41.7800,"categoria":"Mercados"},
  {"chave_externa":"k3","nome":"Lanchonete Teste 3","lat":-2.9150,"lng":-41.7700},
  {"chave_externa":"k4","nome":"Padaria Sem GPS","lat":null,"lng":null},
  {"chave_externa":"k5","nome":"Bar Teste 5","lat":-2.9200,"lng":-41.7650}
]'::jsonb);

-- k1 A/V1 · k2 B/V1 · k3 C/V2 · k4 C/V1 (sem coordenadas) · k5 sem dono (prospecto)
update estabelecimentos set status='ativo', tier='A', vendedor_id=:'V1' where chave_externa='k1';
update estabelecimentos set status='ativo', tier='B', vendedor_id=:'V1' where chave_externa='k2';
update estabelecimentos set status='ativo', tier='C', vendedor_id=:'V2' where chave_externa='k3';
update estabelecimentos set status='ativo', tier='C', vendedor_id=:'V1' where chave_externa='k4';

-- ===========================================================================
-- 1. Usuários e perfis
-- ===========================================================================
do $$ begin
  assert (select count(*) from perfis) = 4, 'trigger deve criar um perfil por usuário';
  assert (select nome from perfis where id = '00000000-0000-0000-0000-000000000002') = 'vendedor2',
         'sem nome no metadata, usa a parte local do e-mail';
  assert (select papel from perfis where id = '00000000-0000-0000-0000-000000000001') = 'vendedor',
         'perfil novo nasce como vendedor';
end $$;

-- ===========================================================================
-- 2. Importação idempotente
-- ===========================================================================
begin;
do $$
declare r jsonb;
begin
  assert (select count(*) from estabelecimentos) = 5, 'import inicial deve gerar 5 pontos';
  assert (select status from estabelecimentos where chave_externa = 'k5') = 'prospecto',
         'ponto importado nasce como prospecto';

  r := importar_estabelecimentos('[
    {"chave_externa":"k1","nome":"Restaurante Teste 1 (renomeado)","lat":-2.9050,"lng":-41.7760},
    {"chave_externa":"k6","nome":"Ponto Novo 6","lat":-2.9300,"lng":-41.7900}
  ]'::jsonb);
  assert (r ->> 'inseridos')::int = 1 and (r ->> 'atualizados')::int = 1, 'contagem do reimport: ' || r::text;
  assert (select count(*) from estabelecimentos) = 6;
  assert (select nome from estabelecimentos where chave_externa = 'k1') = 'Restaurante Teste 1 (renomeado)';
  assert (select status from estabelecimentos where chave_externa = 'k1') = 'ativo',
         'reimport NÃO pode sobrescrever status';
  assert (select tier from estabelecimentos where chave_externa = 'k1') = 'A', 'reimport preserva tier';
  assert (select vendedor_id from estabelecimentos where chave_externa = 'k1') is not null,
         'reimport preserva carteira';
  assert (select categoria from estabelecimentos where chave_externa = 'k1') = 'Restaurantes',
         'campo ausente no reimport não apaga o valor existente';
end $$;
rollback;

-- ===========================================================================
-- 3. Distância (haversine)
-- ===========================================================================
do $$ begin
  assert distancia_m(0, 0, 1, 0) between 111000 and 111400, '1 grau de latitude ~ 111,2 km';
  assert distancia_m(-2.9050, -41.7760, -2.9050, -41.7760) = 0;
  assert distancia_m(null, 0, 1, 0) is null, 'sem coordenada = distância nula';
end $$;

-- ===========================================================================
-- 4. Validação de check-in feita pelo servidor
-- ===========================================================================
begin;
do $$
declare v visitas;
begin
  -- ~50 m do ponto: confirmada
  insert into visitas (estabelecimento_id, usuario_id, checkin_lat, checkin_lng)
  values (t_eid('k1'), '00000000-0000-0000-0000-000000000001', -2.90455, -41.7760) returning * into v;
  assert v.validacao = 'confirmada' and v.distancia_m between 40 and 60, 'dentro do raio: ' || v.validacao;

  -- ~555 m: fora do raio — e o cliente tentando forçar 'validada_gestor' é ignorado
  insert into visitas (estabelecimento_id, usuario_id, checkin_lat, checkin_lng, validacao, validada_por)
  values (t_eid('k1'), '00000000-0000-0000-0000-000000000001', -2.9100, -41.7760,
          'validada_gestor', '00000000-0000-0000-0000-00000000000a') returning * into v;
  assert v.validacao = 'fora_do_raio', 'servidor decide a validação: ' || v.validacao;
  assert v.validada_por is null, 'validada_por não pode vir do cliente';

  -- sem GPS
  insert into visitas (estabelecimento_id, usuario_id)
  values (t_eid('k1'), '00000000-0000-0000-0000-000000000001') returning * into v;
  assert v.validacao = 'sem_gps';

  -- ponto sem coordenadas cadastradas
  insert into visitas (estabelecimento_id, usuario_id, checkin_lat, checkin_lng)
  values (t_eid('k4'), '00000000-0000-0000-0000-000000000001', -2.9, -41.7) returning * into v;
  assert v.validacao = 'sem_coordenadas';
end $$;
rollback;

-- ===========================================================================
-- 5. Cadência: semáforo, base do relógio e regras
-- ===========================================================================
begin;
do $$
declare
  r record;
  c v_cadencia;
begin
  -- k1: ativo/A => intervalo 15 dias, peso 3
  for r in select * from (values (40,'preto'),(25,'vermelho'),(20,'amarelo'),(16,'amarelo'),
                                 (15,'verde'),(5,'verde')) t(dias, esperado)
  loop
    delete from visitas;
    perform t_visita('k1', '00000000-0000-0000-0000-000000000001', r.dias);
    select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
    assert c.semaforo = r.esperado,
      format('visita há %s dias deveria ser %s, veio %s', r.dias, r.esperado, c.semaforo);
    assert not c.nunca_visitado;
  end loop;

  -- números exatos para 40 dias atrás
  delete from visitas;
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 40);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.intervalo_dias = 15 and c.dias_atraso = 25, 'atraso=25: ' || c.dias_atraso;
  assert c.proxima_devida = hoje_local() - 25;
  assert c.prioridade = round(3 * (1 + 25 / 15.0), 3), 'prioridade: ' || c.prioridade;

  -- visita FORA DO RAIO não zera o relógio
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 0, 'venda', null, true);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.semaforo = 'preto', 'visita fora do raio não pode zerar a cadência';

  -- promotoria também não substitui a visita do vendedor
  perform t_visita('k1', '00000000-0000-0000-0000-0000000000f1', 0, 'promotoria');
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.semaforo = 'preto', 'promotoria não zera a cadência de venda';

  -- visita confirmada hoje zera
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 0);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.semaforo = 'verde' and c.dias_atraso = -15, 'visita confirmada hoje: ' || c.dias_atraso;
end $$;
rollback;

begin;
do $$
declare c v_cadencia;
begin
  -- retorno combinado ANTECIPA a próxima visita
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 2, 'venda', hoje_local() + 3);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.proxima_devida = hoje_local() + 3, 'retorno antecipa: ' || c.proxima_devida;

  -- mas NUNCA adia além do intervalo-alvo
  delete from visitas;
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 2, 'venda', hoje_local() + 60);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.proxima_devida = hoje_local() - 2 + 15, 'retorno não pode adiar: ' || c.proxima_devida;

  -- retorno anterior à própria visita é ignorado
  delete from visitas;
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 2, 'venda', hoje_local() - 10);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.proxima_devida = hoje_local() - 2 + 15, 'retorno inválido ignorado';

  -- override de intervalo por ponto
  delete from visitas;
  update estabelecimentos set intervalo_dias_override = 7 where chave_externa = 'k1';
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 10);
  select * into c from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.intervalo_dias = 7 and c.dias_atraso = 3 and c.semaforo = 'amarelo', 'override: ' || c.semaforo;
end $$;
rollback;

begin;
do $$
declare c v_cadencia;
begin
  -- nunca visitado: o relógio começa quando entrou na carteira
  select * into c from v_cadencia where estabelecimento_id = t_eid('k2');
  assert c.nunca_visitado and c.semaforo = 'verde' and c.dias_atraso = -30,
         'recém-atribuído é verde: ' || c.dias_atraso;

  update estabelecimentos set carteira_desde = now() - interval '70 days' where chave_externa = 'k2';
  select * into c from v_cadencia where estabelecimento_id = t_eid('k2');
  assert c.semaforo = 'preto' and c.nunca_visitado, 'na carteira há 70 dias sem visita = esquecido';

  -- fora da cadência: prospecto sem dono e status sem regra
  assert not exists (select 1 from v_cadencia where estabelecimento_id = t_eid('k5')),
         'prospecto não entra na cobrança';
  update estabelecimentos set status = 'perdido' where chave_externa = 'k1';
  assert not exists (select 1 from v_cadencia where estabelecimento_id = t_eid('k1')),
         'perdido sai da cobrança';

  -- inativo entra em modo resgate
  update estabelecimentos set status = 'inativo' where chave_externa = 'k1';
  assert (select intervalo_dias from v_cadencia where estabelecimento_id = t_eid('k1')) = 20,
         'inativo A usa regra de resgate';
end $$;
rollback;

-- ===========================================================================
-- 6. Painel de cobertura (gestor) e fila do dia (vendedor)
-- ===========================================================================
begin;
do $$ begin
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 40);   -- k1: esquecido
end $$;

do $$
declare r v_cobertura_vendedor;
begin
  select * into r from v_cobertura_vendedor where vendedor_id = '00000000-0000-0000-0000-000000000001';
  assert r.pontos_em_cadencia = 3 and r.em_dia = 2 and r.esquecidos = 1, 'cobertura V1: ' || r::text;
  assert r.cobertura_pct = 66.7, 'cobertura_pct: ' || r.cobertura_pct;
  assert r.nunca_visitados = 2;
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'V1', true);
do $$
declare n int; primeiro uuid;
begin
  select count(*) into n from fila_do_dia(-2.9050, -41.7760);
  assert n = 1, 'horizonte padrão (3 dias): só o k1 vencido. veio ' || n;

  select estabelecimento_id into primeiro from fila_do_dia(-2.9050, -41.7760);
  assert primeiro = t_eid('k1');
  assert (select distancia_m from fila_do_dia(-2.9050, -41.7760)) = 0, 'distância até o ponto';

  select count(*) into n from fila_do_dia(null, null, 100);
  assert n = 3, 'horizonte largo traz toda a carteira do V1 (k1,k2,k4), nunca a do V2. veio ' || n;
  select estabelecimento_id into primeiro from fila_do_dia(null, null, 100);
  assert primeiro = t_eid('k1'), 'mais urgente primeiro';

  select count(*) into n from v_cobertura_vendedor;
  assert n = 1, 'vendedor só enxerga a própria linha de cobertura';
end $$;
rollback;

-- ===========================================================================
-- 7. Permissões (RLS)
-- ===========================================================================
-- 7.1 vendedor
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'V1', true);
do $$
declare n int;
begin
  select count(*) into n from estabelecimentos;
  assert n = 4, 'V1 vê a própria carteira (k1,k2,k4) + pontos sem dono (k5). veio ' || n;
  assert not exists (select 1 from estabelecimentos where chave_externa = 'k3'),
         'carteira de outro vendedor é invisível';

  -- edita contato do próprio ponto
  update estabelecimentos set telefone = '86 90000-0000' where chave_externa = 'k1';
  get diagnostics n = row_count;
  assert n = 1, 'V1 edita telefone do próprio ponto';

  -- não edita decisões comerciais
  begin
    update estabelecimentos set status = 'inativo' where chave_externa = 'k1';
    raise exception 'ERRO: V1 conseguiu alterar status';
  exception when insufficient_privilege then null; end;
  begin
    update estabelecimentos set vendedor_id = '00000000-0000-0000-0000-000000000002' where chave_externa = 'k1';
    raise exception 'ERRO: V1 conseguiu repassar carteira';
  exception when insufficient_privilege then null; end;

  -- não pega ponto sem dono por UPDATE direto (só via assumir_estabelecimento)
  update estabelecimentos set vendedor_id = '00000000-0000-0000-0000-000000000001' where chave_externa = 'k5';
  get diagnostics n = row_count;
  assert n = 0, 'V1 não pode se atribuir ponto por UPDATE direto';

  -- não mexe em ponto alheio
  update estabelecimentos set telefone = 'x' where chave_externa = 'k3';
  get diagnostics n = row_count;
  assert n = 0, 'V1 não edita ponto do V2';

  -- importação é só da gestão
  begin
    perform importar_estabelecimentos('[{"chave_externa":"kx","nome":"Intruso","lat":0,"lng":0}]'::jsonb);
    raise exception 'ERRO: V1 conseguiu importar';
  exception when insufficient_privilege then null; end;

  -- perfis: vê só o próprio, não muda o próprio papel
  select count(*) into n from perfis;
  assert n = 1, 'V1 vê só o próprio perfil';
  update perfis set papel = 'admin' where id = '00000000-0000-0000-0000-000000000001';
  get diagnostics n = row_count;
  assert n = 0, 'V1 não promove a si mesmo';
end $$;
rollback;

-- 7.2 visitas: autoria, isolamento, idempotência, edição
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'V1', true);
do $$
declare n int; v_id uuid;
begin
  insert into visitas (estabelecimento_id, usuario_id, checkin_lat, checkin_lng, chave_idempotencia)
  values (t_eid('k1'), '00000000-0000-0000-0000-000000000001', -2.9050, -41.7760,
          'aaaaaaaa-0000-0000-0000-000000000001') returning id into v_id;

  -- reenvio offline (mesma chave) não duplica
  insert into visitas (estabelecimento_id, usuario_id, checkin_lat, checkin_lng, chave_idempotencia)
  values (t_eid('k1'), '00000000-0000-0000-0000-000000000001', -2.9050, -41.7760,
          'aaaaaaaa-0000-0000-0000-000000000001')
  on conflict (chave_idempotencia) do nothing;
  select count(*) into n from visitas where chave_idempotencia = 'aaaaaaaa-0000-0000-0000-000000000001';
  assert n = 1, 'idempotência do reenvio offline';

  -- não registra em nome de outro
  begin
    insert into visitas (estabelecimento_id, usuario_id) values (t_eid('k1'), '00000000-0000-0000-0000-000000000002');
    raise exception 'ERRO: V1 registrou visita em nome do V2';
  exception when insufficient_privilege then null; end;

  -- não registra em ponto que não enxerga
  begin
    insert into visitas (estabelecimento_id, usuario_id) values (t_eid('k3'), '00000000-0000-0000-0000-000000000001');
    raise exception 'ERRO: V1 registrou visita em ponto do V2';
  exception when insufficient_privilege then null; end;

  -- completa a própria visita (checkout, resultado, retorno)
  update visitas set checkout_em = now() + interval '10 minutes', resultado = 'pedido',
         valor_pedido = 350.00, proximo_passo = 'Levar amostra', retorno_em = hoje_local() + 7,
         observacao = 'Pediu 2 caixas'
   where id = v_id;
  get diagnostics n = row_count;
  assert n = 1, 'autor completa a própria visita';

  -- mas não adultera check-in/validação
  begin
    update visitas set validacao = 'validada_gestor' where id = v_id;
    raise exception 'ERRO: autor alterou validação';
  exception when insufficient_privilege then null; end;
  begin
    update visitas set checkin_lat = -2.0 where id = v_id;
    raise exception 'ERRO: autor alterou GPS do check-in';
  exception when insufficient_privilege then null; end;
end $$;

-- V2 não enxerga visitas do V1; gestão enxerga
select set_config('request.jwt.claim.sub', :'V2', true);
do $$ begin
  assert (select count(*) from visitas) = 0, 'V2 não vê visitas do V1';
end $$;
select set_config('request.jwt.claim.sub', :'G', true);
do $$ begin
  assert (select count(*) from visitas) = 1, 'gestor vê todas as visitas';
  assert (select count(*) from estabelecimentos) = 5, 'gestor vê todos os pontos';
  assert (select count(*) from perfis) = 4, 'gestor vê todos os perfis';
end $$;
rollback;

-- 7.3 janela de edição e validação manual pelo gestor
begin;
do $$ begin
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 0, 'venda', null, true);  -- fora do raio
end $$;

set local role authenticated;
select set_config('request.jwt.claim.sub', :'G', true);
do $$
declare c v_cadencia; v visitas;
begin
  select semaforo into c.semaforo from v_cadencia where estabelecimento_id = t_eid('k1');
  assert c.semaforo = 'verde', 'ainda sem visita contada: nasce na carteira hoje';  -- carteira_desde = agora

  update visitas set validacao = 'validada_gestor' where estabelecimento_id = t_eid('k1') returning * into v;
  assert v.validada_por = '00000000-0000-0000-0000-00000000000a', 'registra quem validou';
  assert (select ultima_visita_em from v_cadencia where estabelecimento_id = t_eid('k1')) is not null,
         'visita validada pelo gestor passa a contar na cadência';
end $$;
rollback;

begin;
do $$ begin
  perform t_visita('k1', '00000000-0000-0000-0000-000000000001', 0);
  update visitas set recebido_em = now() - interval '30 hours';   -- superusuário simula visita antiga
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'V1', true);
do $$ begin
  begin
    update visitas set observacao = 'editando tarde demais';
    raise exception 'ERRO: edição fora da janela de 24h';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

-- 7.4 assumir ponto (governança da carteira)
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', :'V1', true);
do $$
declare e estabelecimentos;
begin
  perform assumir_estabelecimento(t_eid('k5'));
  select * into e from estabelecimentos where chave_externa = 'k5';
  assert e.vendedor_id = '00000000-0000-0000-0000-000000000001', 'V1 assumiu o ponto';
  assert e.status = 'em_prospeccao', 'prospecto vira em_prospeccao ao ser assumido';
  assert e.carteira_desde is not null;
end $$;

select set_config('request.jwt.claim.sub', :'V2', true);
do $$ begin
  begin
    perform assumir_estabelecimento(t_eid('k5'));
    raise exception 'ERRO: V2 assumiu ponto que já tem dono';
  exception when sqlstate 'P0001' then null; end;
  begin
    perform assumir_estabelecimento(t_eid('k1'));
    raise exception 'ERRO: V2 assumiu cliente ativo do V1';
  exception when sqlstate 'P0001' then null; end;
end $$;

select set_config('request.jwt.claim.sub', :'P1', true);
do $$ begin
  begin
    perform assumir_estabelecimento(t_eid('k5'));
    raise exception 'ERRO: promotor assumiu ponto';
  exception when insufficient_privilege or sqlstate 'P0001' then null; end;
end $$;
rollback;

-- 7.5 sem login: nada
begin;
set local role anon;
do $$ begin
  begin
    perform count(*) from estabelecimentos;
    raise exception 'ERRO: anon leu estabelecimentos';
  exception when insufficient_privilege then null; end;
  begin
    perform assumir_estabelecimento(gen_random_uuid());
    raise exception 'ERRO: anon executou assumir_estabelecimento';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

-- ===========================================================================
-- 8. Importação v2 (ERP, mapeamento de pastas -> status/tier/vendedor)
-- ===========================================================================
begin;
update perfis set chave_import = 'joao-oliveira' where id = :'V1';
do $$
declare r jsonb; e estabelecimentos;
begin
  r := importar_estabelecimentos('[
    {"chave_externa":"erp:100001","nome":"Mercado ERP","lat":-2.9,"lng":-41.7,"codigo_erp":"100001",
     "razao_social":"ERP COMERCIO LTDA","cnpj":"11.222.333/0001-81","cep":"64.200-040",
     "celular":"(86) 99999-0000","observacoes":"Vendas apenas à vista",
     "status":"ativo","tier":"B","segmento":"varejo","vendedor_chave":"joao-oliveira"},
    {"chave_externa":"erp:100002","nome":"Ponto sem coordenada","lat":null,"lng":null,
     "status":"inativo","vendedor_chave":"inexistente"}
  ]'::jsonb,
  '[{"nome":"Bairro X","poligono":[[0,0],[1,0],[1,1]],"atributos":{"rotulos":["R$ 10,00"]}}]'::jsonb);

  assert (r ->> 'inseridos')::int = 2 and (r ->> 'regioes')::int = 1, 'contagens: ' || r::text;
  assert (r ->> 'vendedor_nao_encontrado')::int = 1, 'chave sem perfil é contada: ' || r::text;

  select * into e from estabelecimentos where chave_externa = 'erp:100001';
  assert e.status = 'ativo' and e.tier = 'B' and e.segmento = 'varejo', 'mapeamento aplicado na criação';
  assert e.vendedor_id = '00000000-0000-0000-0000-000000000001' and e.carteira_desde is not null,
         'vendedor resolvido pela chave_import e carteira iniciada';
  assert e.codigo_erp = '100001' and e.cnpj = '11.222.333/0001-81' and e.celular = '(86) 99999-0000';
  assert (select atributos -> 'rotulos' ->> 0 from regioes where nome = 'Bairro X') = 'R$ 10,00';

  -- ponto sem coordenada é aceito e fica fora do mapa, mas dentro da cadência (ninguém o visita!)
  assert (select lat from estabelecimentos where chave_externa = 'erp:100002') is null;
  assert exists (select 1 from v_cadencia where nome = 'Ponto sem coordenada' and vendedor_id is null);

  -- reimport: preserva decisões comerciais e observações; atualiza cadastro
  r := importar_estabelecimentos('[
    {"chave_externa":"erp:100001","nome":"Mercado ERP Novo Nome","lat":-2.9,"lng":-41.7,
     "celular":"(86) 98888-1111","observacoes":"outra nota","status":"perdido","tier":"A","segmento":"rede"}
  ]'::jsonb);
  select * into e from estabelecimentos where chave_externa = 'erp:100001';
  assert e.nome = 'Mercado ERP Novo Nome' and e.celular = '(86) 98888-1111', 'cadastro atualiza';
  assert e.status = 'ativo' and e.tier = 'B' and e.segmento = 'varejo', 'decisões comerciais preservadas';
  assert e.observacoes = 'Vendas apenas à vista', 'observação já existente é preservada';

  -- ponto sem vendedor recebe o do arquivo no reimport
  update estabelecimentos set vendedor_id = null where chave_externa = 'erp:100001';
  perform importar_estabelecimentos('[{"chave_externa":"erp:100001","nome":"X","vendedor_chave":"joao-oliveira"}]'::jsonb);
  assert (select vendedor_id from estabelecimentos where chave_externa = 'erp:100001')
         = '00000000-0000-0000-0000-000000000001', 'vendedor aplicado quando ponto estava sem dono';
end $$;

-- vendedor não altera dados do ERP do próprio ponto, mas edita contato
update estabelecimentos set vendedor_id = :'V1' where chave_externa = 'erp:100001';
set local role authenticated;
select set_config('request.jwt.claim.sub', :'V1', true);
do $$
declare n int;
begin
  update estabelecimentos set celular = '(86) 97777-2222', contato = 'Dona Maria' where chave_externa = 'erp:100001';
  get diagnostics n = row_count;
  assert n = 1, 'vendedor atualiza celular/contato do próprio ponto';
  begin
    update estabelecimentos set codigo_erp = '999999' where chave_externa = 'erp:100001';
    raise exception 'ERRO: vendedor alterou código do ERP';
  exception when insufficient_privilege then null; end;
  begin
    update estabelecimentos set cnpj = '00.000.000/0000-00' where chave_externa = 'erp:100001';
    raise exception 'ERRO: vendedor alterou CNPJ';
  exception when insufficient_privilege then null; end;
end $$;
rollback;

-- ===========================================================================
-- 9. Início da cadência na importação (zero | escalonado | vencidos)
-- ===========================================================================
begin;
update perfis set chave_import = 'joao-oliveira' where id = :'V1';
do $$
declare
  itens jsonb;
  v_min int; v_max int; v_dist int;
begin
  -- 60 clientes ativos classe B (intervalo 30) do mesmo vendedor
  select jsonb_agg(jsonb_build_object('chave_externa', 'ini:' || g, 'nome', 'Cliente ' || g,
           'status', 'ativo', 'tier', 'B', 'vendedor_chave', 'joao-oliveira', 'lat', -2.9, 'lng', -41.7))
    into itens from generate_series(1, 60) g;

  -- zero: todos em dia, vencem só daqui a um intervalo inteiro
  perform importar_estabelecimentos(itens, '[]', 'zero');
  select min(dias_atraso), max(dias_atraso) into v_min, v_max from v_cadencia where nome like 'Cliente %';
  assert v_min = -30 and v_max = -30, format('zero: esperado -30, veio %s..%s', v_min, v_max);
  delete from estabelecimentos where chave_externa like 'ini:%';

  -- vencidos: todos vencem hoje
  perform importar_estabelecimentos(itens, '[]', 'vencidos');
  select min(dias_atraso), max(dias_atraso) into v_min, v_max from v_cadencia where nome like 'Cliente %';
  assert v_min = 0 and v_max = 0, format('vencidos: esperado 0, veio %s..%s', v_min, v_max);
  delete from estabelecimentos where chave_externa like 'ini:%';

  -- escalonado: vencimentos espalhados dentro do ciclo, nenhum já atrasado
  perform importar_estabelecimentos(itens, '[]', 'escalonado');
  select min(dias_atraso), max(dias_atraso), count(distinct dias_atraso)
    into v_min, v_max, v_dist from v_cadencia where nome like 'Cliente %';
  assert v_min >= -30 and v_max <= -1, format('escalonado dentro do ciclo: %s..%s', v_min, v_max);
  assert v_dist >= 15, format('escalonado deve espalhar (>=15 dias distintos de 30), veio %s', v_dist);

  -- reimportar não embaralha nem recomeça quem já existe
  perform importar_estabelecimentos(itens, '[]', 'vencidos');
  select min(dias_atraso), max(dias_atraso) into v_min, v_max from v_cadencia where nome like 'Cliente %';
  assert v_max <= -1, 'reimport com outro modo não pode mexer em pontos existentes';

  -- modo inválido é recusado
  begin
    perform importar_estabelecimentos(itens, '[]', 'qualquer');
    raise exception 'ERRO: aceitou modo inválido';
  exception when raise_exception then
    assert sqlerrm like 'p_inicio inválido%', sqlerrm;
  end;
end $$;
rollback;

\echo 'OK: todos os testes de banco passaram'
