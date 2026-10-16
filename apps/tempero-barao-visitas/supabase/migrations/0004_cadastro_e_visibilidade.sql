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
