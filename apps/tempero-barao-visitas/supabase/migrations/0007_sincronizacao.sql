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
