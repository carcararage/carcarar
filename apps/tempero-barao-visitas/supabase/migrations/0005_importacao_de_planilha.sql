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
