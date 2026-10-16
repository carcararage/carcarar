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
