import type { ItemImportado, RegiaoImportada } from '../kml/parseKml';
import { slug, type Vendedor } from '../kml/mapeamento';
import { abrirBanco, comoUsuario } from './banco';
import { avisarFila, enfileirarTx } from '../sync/fila';
import { modoReal } from '../sync/modo';
import { sincronizar } from '../sync/motor';
import { ErroRede, transporteAtual } from '../sync/transporte';

/**
 * Camada de dados do app. Cada função roda como um usuário (RLS vale) e devolve tipos simples.
 * Para trocar o banco local pelo Supabase, só este arquivo muda: as regras estão no SQL.
 */

export type Papel = 'admin' | 'gestor' | 'vendedor' | 'promotor';
export type Semaforo = 'verde' | 'amarelo' | 'vermelho' | 'preto';
export type StatusComercial = 'prospecto' | 'em_prospeccao' | 'ativo' | 'inativo' | 'perdido';
export type TipoVisita = 'venda' | 'prospeccao' | 'pos_venda' | 'promotoria';
export type ResultadoVisita =
  | 'pedido'
  | 'orcamento'
  | 'sem_demanda'
  | 'decisor_ausente'
  | 'reclamacao'
  | 'fechado'
  | 'outro';
export type Validacao = 'confirmada' | 'fora_do_raio' | 'sem_gps' | 'sem_coordenadas' | 'validada_gestor';

export interface Usuario {
  id: string;
  nome: string;
  papel: Papel;
  chaveImport: string | null;
}

const num = (v: unknown) => (v == null ? null : Number(v));
const semAcento = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ---------------------------------------------------------------------------------------------
// Usuários (modo demonstração: sem senha; no Supabase entra o Auth)
// ---------------------------------------------------------------------------------------------

export async function listarUsuarios(): Promise<Usuario[]> {
  const db = await abrirBanco();
  const r = await db.query<{ id: string; nome: string; papel: Papel; chave_import: string | null }>(
    `select id, nome, papel, chave_import from perfis where ativo
      order by case papel when 'admin' then 0 when 'gestor' then 1 when 'vendedor' then 2 else 3 end, nome`,
  );
  return r.rows.map((u) => ({ id: u.id, nome: u.nome, papel: u.papel, chaveImport: u.chave_import }));
}

export async function criarUsuario(nome: string, papel: Papel, chaveImport: string | null = null): Promise<Usuario> {
  const db = await abrirBanco();
  const id = crypto.randomUUID();
  await db.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`, [
    id,
    `${chaveImport ?? id.slice(0, 8)}@demo.local`,
    JSON.stringify({ nome }),
  ]);
  await db.query(`update perfis set papel = $2, chave_import = $3 where id = $1`, [id, papel, chaveImport]);
  return { id, nome, papel, chaveImport };
}

/** Garante os vendedores detectados no KML (modo demo cria; no Supabase o admin cria no Auth). */
export async function garantirVendedores(vendedores: Vendedor[]): Promise<Usuario[]> {
  const existentes = await listarUsuarios();
  const out: Usuario[] = [];
  for (const v of vendedores) {
    const ja = existentes.find((u) => u.chaveImport === v.chave);
    if (ja) out.push(ja);
    else if (!modoReal()) out.push(await criarUsuario(v.nome, 'vendedor', v.chave));
    // modo real: quem cria usuário é a administração (Supabase Auth); sem perfil, a importação conta "vendedor não encontrado"
  }
  return out;
}

/** Modo demo: dá ao vendedor a chave de vínculo usada nas importações (no Supabase, o admin define). */
export async function garantirChaveImport(id: string, nome: string): Promise<string> {
  const db = await abrirBanco();
  if (modoReal()) {
    const r = await db.query<{ c: string | null }>(`select chave_import as c from perfis where id = $1`, [id]);
    return r.rows[0]?.c ?? slug(nome);
  }
  await db.query(`update perfis set chave_import = coalesce(chave_import, $2) where id = $1`, [id, slug(nome)]);
  return (await db.query<{ c: string }>(`select chave_import as c from perfis where id = $1`, [id])).rows[0].c;
}

export async function totalPontos(): Promise<number> {
  const db = await abrirBanco();
  return (await db.query<{ n: number }>(`select count(*)::int as n from estabelecimentos`)).rows[0].n;
}

/** Apaga TODOS os dados do modo demonstração (usuários, pontos, visitas). */
export async function zerarTudo() {
  const db = await abrirBanco();
  await db.exec(`
    delete from visitas; delete from estabelecimentos; delete from regioes;
    delete from perfis; delete from auth.users;`);
}

// ---------------------------------------------------------------------------------------------
// Vendedor: fila, mapa, ficha, visita
// ---------------------------------------------------------------------------------------------

export interface ItemFila {
  id: string;
  nome: string;
  segmento: string;
  status: StatusComercial;
  tier: 'A' | 'B' | 'C';
  bairro: string | null;
  cidade: string | null;
  endereco: string | null;
  telefone: string | null;
  celular: string | null;
  lat: number | null;
  lng: number | null;
  ultimaVisitaEm: Date | null;
  nuncaVisitado: boolean;
  proximaDevida: string;
  diasAtraso: number;
  semaforo: Semaforo;
  prioridade: number;
  distanciaM: number | null;
}

export async function fila(
  uid: string,
  pos: { lat: number; lng: number } | null = null,
  horizonteDias = 3,
  limite = 80,
): Promise<ItemFila[]> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select f.estabelecimento_id as id, f.nome, f.segmento::text, f.status::text, f.tier::text, f.bairro,
              e.cidade, e.endereco, e.telefone, e.celular, f.lat, f.lng,
              f.ultima_visita_em, f.nunca_visitado, to_char(f.proxima_devida, 'YYYY-MM-DD') as proxima_devida,
              f.dias_atraso, f.semaforo, f.prioridade, f.distancia_m
         from fila_do_dia($1::float8, $2::float8, $3::int, $4::int) f
         join estabelecimentos e on e.id = f.estabelecimento_id`,
      [pos?.lat ?? null, pos?.lng ?? null, horizonteDias, limite],
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      nome: x.nome as string,
      segmento: x.segmento as string,
      status: x.status as StatusComercial,
      tier: x.tier as 'A' | 'B' | 'C',
      bairro: x.bairro as string | null,
      cidade: x.cidade as string | null,
      endereco: x.endereco as string | null,
      telefone: x.telefone as string | null,
      celular: x.celular as string | null,
      lat: num(x.lat),
      lng: num(x.lng),
      ultimaVisitaEm: (x.ultima_visita_em as Date | null) ?? null,
      nuncaVisitado: x.nunca_visitado as boolean,
      proximaDevida: x.proxima_devida as string,
      diasAtraso: Number(x.dias_atraso),
      semaforo: x.semaforo as Semaforo,
      prioridade: Number(x.prioridade),
      distanciaM: num(x.distancia_m),
    }));
  });
}

export interface PontoMapa {
  id: string;
  nome: string;
  lat: number;
  lng: number;
  /** null quando o ponto é de OUTRO vendedor (não mostramos status/classe) */
  status: StatusComercial | null;
  tier: 'A' | 'B' | 'C' | null;
  segmento: string;
  vendedorId: string | null;
  vendedorNome: string | null;
  meu: boolean;
  livre: boolean;
  semaforo: Semaforo | null;
  diasAtraso: number | null;
}

/** Todos os pontos com localização. Os de outros vendedores vêm só com o mínimo (nome, local, de quem é). */
export async function pontosMapa(uid: string): Promise<PontoMapa[]> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select p.id, p.nome, p.lat, p.lng, p.status::text, p.tier::text, p.segmento::text, p.vendedor_id,
              p.vendedor_nome, p.meu, p.livre, c.semaforo, c.dias_atraso
         from v_pontos_mapa p
         left join v_cadencia c on c.estabelecimento_id = p.id
        where p.lat is not null`,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      nome: x.nome as string,
      lat: Number(x.lat),
      lng: Number(x.lng),
      status: (x.status as StatusComercial | null) ?? null,
      tier: (x.tier as 'A' | 'B' | 'C' | null) ?? null,
      segmento: x.segmento as string,
      vendedorId: x.vendedor_id as string | null,
      vendedorNome: x.vendedor_nome as string | null,
      meu: x.meu as boolean,
      livre: x.livre as boolean,
      semaforo: (x.semaforo as Semaforo | null) ?? null,
      diasAtraso: num(x.dias_atraso),
    }));
  });
}

export interface PontoVisivel {
  id: string;
  nome: string;
  segmento: string;
  bairro: string | null;
  cidade: string | null;
  temCoordenada: boolean;
  vendedorId: string | null;
  vendedorNome: string | null;
  meu: boolean;
  livre: boolean;
  status: StatusComercial | null;
  tier: 'A' | 'B' | 'C' | null;
  semaforo: Semaforo | null;
}

export type Escopo = 'todos' | 'meus' | 'livres' | 'outros';

/** Lista para o vendedor: os dele, os livres e — só como "vinculado a Fulano" — os dos colegas. */
export async function listarPontosVisiveis(
  uid: string,
  f: { busca?: string; escopo?: Escopo; segmento?: string; limite?: number } = {},
): Promise<{ total: number; itens: PontoVisivel[] }> {
  return comoUsuario(uid, async (tx) => {
    const cond: string[] = [];
    const par: unknown[] = [];
    const p = (v: unknown) => (par.push(v), `$${par.length}`);
    if (f.busca) {
      const q = `%${semAcento(f.busca).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}%`;
      cond.push(`(norm_texto(v.nome) like ${p(q)} or norm_texto(v.bairro) like ${p(q)})`);
    }
    if (f.segmento) cond.push(`v.segmento = ${p(f.segmento)}::segmento`);
    if (f.escopo === 'meus') cond.push('v.meu');
    else if (f.escopo === 'livres') cond.push('v.livre');
    else if (f.escopo === 'outros') cond.push('(not v.meu and not v.livre)');
    const where = cond.length ? `where ${cond.join(' and ')}` : '';
    const total = (await tx.query<{ n: number }>(`select count(*)::int as n from v_pontos_mapa v ${where}`, par)).rows[0].n;
    const r = await tx.query<Record<string, unknown>>(
      `select v.id, v.nome, v.segmento::text, v.bairro, v.cidade, (v.lat is not null) as tem_coord, v.vendedor_id,
              v.vendedor_nome, v.meu, v.livre, v.status::text, v.tier::text, c.semaforo
         from v_pontos_mapa v
         left join v_cadencia c on c.estabelecimento_id = v.id
         ${where}
        order by v.meu desc, v.livre desc, v.nome
        limit ${Number(f.limite ?? 150)}`,
      par,
    );
    return {
      total,
      itens: r.rows.map((x) => ({
        id: x.id as string,
        nome: x.nome as string,
        segmento: x.segmento as string,
        bairro: x.bairro as string | null,
        cidade: x.cidade as string | null,
        temCoordenada: x.tem_coord as boolean,
        vendedorId: x.vendedor_id as string | null,
        vendedorNome: x.vendedor_nome as string | null,
        meu: x.meu as boolean,
        livre: x.livre as boolean,
        status: (x.status as StatusComercial | null) ?? null,
        tier: (x.tier as 'A' | 'B' | 'C' | null) ?? null,
        semaforo: (x.semaforo as Semaforo | null) ?? null,
      })),
    };
  });
}

/** O que se pode saber de um ponto que NÃO é seu (para a tela "vinculado a outro vendedor"). */
export async function resumoPonto(uid: string, id: string): Promise<PontoVisivel | null> {
  const r = await listarPontosVisiveis(uid, { limite: 100000 });
  return r.itens.find((p) => p.id === id) ?? null;
}

export interface VisitaResumo {
  id: string;
  vendedor: string;
  tipo: TipoVisita;
  checkinEm: Date;
  resultado: ResultadoVisita | null;
  valorPedido: number | null;
  proximoPasso: string | null;
  retornoEm: string | null;
  observacao: string | null;
  validacao: Validacao;
  distanciaM: number | null;
}

export interface Ficha {
  id: string;
  nome: string;
  segmento: string;
  categoria: string | null;
  status: StatusComercial;
  tier: 'A' | 'B' | 'C';
  vendedorId: string | null;
  vendedor: string | null;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
  celular: string | null;
  contato: string | null;
  codigoErp: string | null;
  razaoSocial: string | null;
  cnpj: string | null;
  observacoes: string | null;
  regiao: string | null;
  lat: number | null;
  lng: number | null;
  coordenadaSuspeita: string | null;
  cadencia: {
    semaforo: Semaforo;
    diasAtraso: number;
    intervaloDias: number;
    proximaDevida: string;
    ultimaVisitaEm: Date | null;
    nuncaVisitado: boolean;
  } | null;
  visitas: VisitaResumo[];
}

export async function ficha(uid: string, id: string): Promise<Ficha | null> {
  return comoUsuario(uid, async (tx) => {
    const e = (
      await tx.query<Record<string, unknown>>(
        `select e.*, e.status::text as status_t, e.tier::text as tier_t, e.segmento::text as segmento_t,
                p.nome as vendedor, r.nome as regiao_nome
           from estabelecimentos e
           left join perfis p on p.id = e.vendedor_id
           left join regioes r on r.id = e.regiao_id
          where e.id = $1`,
        [id],
      )
    ).rows[0];
    if (!e) return null;
    const c = (
      await tx.query<Record<string, unknown>>(
        `select semaforo, dias_atraso, intervalo_dias, to_char(proxima_devida,'YYYY-MM-DD') as proxima_devida,
                ultima_visita_em, nunca_visitado
           from v_cadencia where estabelecimento_id = $1`,
        [id],
      )
    ).rows[0];
    const v = await tx.query<Record<string, unknown>>(
      `select v.id, p.nome as vendedor, v.tipo::text, v.checkin_em, v.resultado::text, v.valor_pedido,
              v.proximo_passo, to_char(v.retorno_em,'YYYY-MM-DD') as retorno_em, v.observacao,
              v.validacao::text, v.distancia_m
         from visitas v join perfis p on p.id = v.usuario_id
        where v.estabelecimento_id = $1 order by v.checkin_em desc limit 30`,
      [id],
    );
    const atr = (e.atributos ?? {}) as Record<string, unknown>;
    return {
      id: e.id as string,
      nome: e.nome as string,
      segmento: e.segmento_t as string,
      categoria: e.categoria as string | null,
      status: e.status_t as StatusComercial,
      tier: e.tier_t as 'A' | 'B' | 'C',
      vendedorId: e.vendedor_id as string | null,
      vendedor: e.vendedor as string | null,
      endereco: e.endereco as string | null,
      bairro: e.bairro as string | null,
      cidade: e.cidade as string | null,
      uf: e.uf as string | null,
      cep: e.cep as string | null,
      telefone: e.telefone as string | null,
      celular: e.celular as string | null,
      contato: e.contato as string | null,
      codigoErp: e.codigo_erp as string | null,
      razaoSocial: e.razao_social as string | null,
      cnpj: e.cnpj as string | null,
      observacoes: e.observacoes as string | null,
      regiao: e.regiao_nome as string | null,
      lat: num(e.lat),
      lng: num(e.lng),
      coordenadaSuspeita: (atr.coordenada_suspeita as string | undefined) ?? null,
      cadencia: c
        ? {
            semaforo: c.semaforo as Semaforo,
            diasAtraso: Number(c.dias_atraso),
            intervaloDias: Number(c.intervalo_dias),
            proximaDevida: c.proxima_devida as string,
            ultimaVisitaEm: (c.ultima_visita_em as Date | null) ?? null,
            nuncaVisitado: c.nunca_visitado as boolean,
          }
        : null,
      visitas: v.rows.map((x) => ({
        id: x.id as string,
        vendedor: x.vendedor as string,
        tipo: x.tipo as TipoVisita,
        checkinEm: x.checkin_em as Date,
        resultado: (x.resultado as ResultadoVisita | null) ?? null,
        valorPedido: num(x.valor_pedido),
        proximoPasso: x.proximo_passo as string | null,
        retornoEm: x.retorno_em as string | null,
        observacao: x.observacao as string | null,
        validacao: x.validacao as Validacao,
        distanciaM: num(x.distancia_m),
      })),
    };
  });
}

export interface NovaVisita {
  /** gerada no aparelho: reenvio offline não duplica */
  chave: string;
  estabelecimentoId: string;
  tipo: TipoVisita;
  checkinEm: Date;
  checkoutEm: Date;
  gps: { lat: number; lng: number } | null;
  resultado: ResultadoVisita;
  valorPedido: number | null;
  proximoPasso: string | null;
  retornoEm: string | null; // YYYY-MM-DD
  observacao: string | null;
}

export interface VisitaRegistrada {
  id: string;
  validacao: Validacao;
  distanciaM: number | null;
}

export async function registrarVisita(uid: string, v: NovaVisita): Promise<VisitaRegistrada> {
  return comoUsuario(uid, async (tx) => {
    // id = chave: o aparelho decide o id, então a visita offline e a do servidor são a MESMA linha
    const ins = await tx.query(
      `insert into visitas (id, chave_idempotencia, estabelecimento_id, usuario_id, tipo, checkin_em, checkout_em,
                            checkin_lat, checkin_lng, resultado, valor_pedido, proximo_passo, retorno_em, observacao)
       values ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (chave_idempotencia) do nothing`,
      [
        v.chave, v.estabelecimentoId, uid, v.tipo, v.checkinEm.toISOString(), v.checkoutEm.toISOString(),
        v.gps?.lat ?? null, v.gps?.lng ?? null, v.resultado, v.valorPedido, v.proximoPasso, v.retornoEm, v.observacao,
      ],
    );
    if (ins.affectedRows) {
      await enfileirarTx(tx, 'visita', {
        chave: v.chave, estabelecimento_id: v.estabelecimentoId, tipo: v.tipo,
        checkin_em: v.checkinEm.toISOString(), checkout_em: v.checkoutEm.toISOString(),
        checkin_lat: v.gps?.lat ?? null, checkin_lng: v.gps?.lng ?? null, resultado: v.resultado,
        valor_pedido: v.valorPedido, proximo_passo: v.proximoPasso, retorno_em: v.retornoEm, observacao: v.observacao,
      }, v.estabelecimentoId);
    }
    const r = await tx.query<{ id: string; validacao: Validacao; distancia_m: number | null }>(
      `select id, validacao::text as validacao, distancia_m from visitas where chave_idempotencia = $1`,
      [v.chave],
    );
    const x = r.rows[0];
    return { id: x.id, validacao: x.validacao, distanciaM: num(x.distancia_m) };
  }).then((r) => (avisarFila(), r));
}

export async function assumirPonto(uid: string, id: string): Promise<void> {
  await comoUsuario(uid, async (tx) => {
    await tx.query(`select assumir_estabelecimento($1)`, [id]);
    await enfileirarTx(tx, 'assumir', { id }, id);
  });
  avisarFila();
}

export async function editarContato(
  uid: string,
  id: string,
  d: { telefone: string | null; celular: string | null; contato: string | null; observacoes: string | null },
): Promise<void> {
  await comoUsuario(uid, async (tx) => {
    await tx.query(
      `update estabelecimentos set telefone = $2, celular = $3, contato = $4, observacoes = $5 where id = $1`,
      [id, d.telefone, d.celular, d.contato, d.observacoes],
    );
    await enfileirarTx(tx, 'contato', { id, ...d }, id);
  });
  avisarFila();
}

// ---------------------------------------------------------------------------------------------
// Gestão
// ---------------------------------------------------------------------------------------------

export interface CoberturaVendedor {
  vendedorId: string | null;
  vendedor: string;
  pontos: number;
  emDia: number;
  atrasados: number;
  criticos: number;
  esquecidos: number;
  nuncaVisitados: number;
  coberturaPct: number;
}

export async function painelCobertura(uid: string): Promise<CoberturaVendedor[]> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select vendedor_id, coalesce(vendedor, 'Sem vendedor') as vendedor, pontos_em_cadencia::int as pontos,
              em_dia::int, atrasados::int, criticos::int, esquecidos::int, nunca_visitados::int, cobertura_pct
         from v_cobertura_vendedor order by cobertura_pct, vendedor`,
    );
    return r.rows.map((x) => ({
      vendedorId: x.vendedor_id as string | null,
      vendedor: x.vendedor as string,
      pontos: Number(x.pontos),
      emDia: Number(x.em_dia),
      atrasados: Number(x.atrasados),
      criticos: Number(x.criticos),
      esquecidos: Number(x.esquecidos),
      nuncaVisitados: Number(x.nunca_visitados),
      coberturaPct: Number(x.cobertura_pct),
    }));
  });
}

export interface Esquecido {
  id: string;
  nome: string;
  vendedor: string | null;
  status: StatusComercial;
  tier: 'A' | 'B' | 'C';
  bairro: string | null;
  cidade: string | null;
  diasAtraso: number;
  nuncaVisitado: boolean;
  ultimaVisitaEm: Date | null;
  semaforo: Semaforo;
}

export async function esquecidos(uid: string, minimo: Semaforo = 'vermelho', limite = 200): Promise<Esquecido[]> {
  const niveis: Semaforo[] = minimo === 'preto' ? ['preto'] : minimo === 'vermelho' ? ['vermelho', 'preto'] : ['amarelo', 'vermelho', 'preto'];
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select c.estabelecimento_id as id, c.nome, p.nome as vendedor, c.status::text, c.tier::text, c.bairro,
              e.cidade, c.dias_atraso, c.nunca_visitado, c.ultima_visita_em, c.semaforo
         from v_cadencia c
         join estabelecimentos e on e.id = c.estabelecimento_id
         left join perfis p on p.id = c.vendedor_id
        where c.semaforo = any($1::text[])
        order by c.prioridade desc, c.nome
        limit $2`,
      [niveis, limite],
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      nome: x.nome as string,
      vendedor: x.vendedor as string | null,
      status: x.status as StatusComercial,
      tier: x.tier as 'A' | 'B' | 'C',
      bairro: x.bairro as string | null,
      cidade: x.cidade as string | null,
      diasAtraso: Number(x.dias_atraso),
      nuncaVisitado: x.nunca_visitado as boolean,
      ultimaVisitaEm: (x.ultima_visita_em as Date | null) ?? null,
      semaforo: x.semaforo as Semaforo,
    }));
  });
}

export interface VisitaParaValidar {
  id: string;
  ponto: string;
  pontoId: string;
  vendedor: string;
  checkinEm: Date;
  validacao: Validacao;
  distanciaM: number | null;
  resultado: ResultadoVisita | null;
}

export async function visitasParaValidar(uid: string): Promise<VisitaParaValidar[]> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select v.id, e.nome as ponto, e.id as ponto_id, p.nome as vendedor, v.checkin_em,
              v.validacao::text, v.distancia_m, v.resultado::text
         from visitas v
         join estabelecimentos e on e.id = v.estabelecimento_id
         join perfis p on p.id = v.usuario_id
        where v.validacao in ('fora_do_raio', 'sem_gps', 'sem_coordenadas')
          and v.checkin_em > now() - interval '45 days'
        order by v.checkin_em desc limit 100`,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      ponto: x.ponto as string,
      pontoId: x.ponto_id as string,
      vendedor: x.vendedor as string,
      checkinEm: x.checkin_em as Date,
      validacao: x.validacao as Validacao,
      distanciaM: num(x.distancia_m),
      resultado: (x.resultado as ResultadoVisita | null) ?? null,
    }));
  });
}

export async function validarVisita(uid: string, id: string): Promise<void> {
  await comoUsuario(uid, async (tx) => {
    await tx.query(`update visitas set validacao = 'validada_gestor' where id = $1`, [id]);
    await enfileirarTx(tx, 'validar_visita', { id });
  });
  avisarFila();
}

export interface Totais {
  pontos: number;
  porStatus: Record<StatusComercial, number>;
  semCoordenada: number;
  semDono: number;
  visitas30d: number;
  visitasHoje: number;
}

export async function totais(uid: string): Promise<Totais> {
  return comoUsuario(uid, async (tx) => {
    const s = await tx.query<{ status: StatusComercial; n: number }>(
      `select status::text as status, count(*)::int as n from estabelecimentos group by 1`,
    );
    const porStatus = { prospecto: 0, em_prospeccao: 0, ativo: 0, inativo: 0, perdido: 0 } as Record<StatusComercial, number>;
    for (const x of s.rows) porStatus[x.status] = x.n;
    const o = (
      await tx.query<Record<string, number>>(
        `select (select count(*) from estabelecimentos where lat is null)::int as sem_coord,
                (select count(*) from estabelecimentos where vendedor_id is null and status in ('ativo','inativo','em_prospeccao'))::int as sem_dono,
                (select count(*) from visitas where checkin_em > now() - interval '30 days')::int as v30,
                (select count(*) from visitas where (checkin_em at time zone 'America/Fortaleza')::date = hoje_local())::int as vhoje`,
      )
    ).rows[0];
    return {
      pontos: Object.values(porStatus).reduce((a, b) => a + b, 0),
      porStatus,
      semCoordenada: Number(o.sem_coord),
      semDono: Number(o.sem_dono),
      visitas30d: Number(o.v30),
      visitasHoje: Number(o.vhoje),
    };
  });
}

export interface PontoLista {
  id: string;
  nome: string;
  segmento: string;
  status: StatusComercial;
  tier: 'A' | 'B' | 'C';
  bairro: string | null;
  cidade: string | null;
  vendedorId: string | null;
  vendedor: string | null;
  semaforo: Semaforo | null;
  temCoordenada: boolean;
}

export interface FiltroCarteira {
  busca?: string;
  status?: StatusComercial | '';
  vendedorId?: string | '' | 'sem';
  segmento?: string;
  limite?: number;
}

export async function listarPontos(uid: string, f: FiltroCarteira = {}): Promise<{ total: number; itens: PontoLista[] }> {
  return comoUsuario(uid, async (tx) => {
    const cond: string[] = [];
    const par: unknown[] = [];
    const p = (v: unknown) => {
      par.push(v);
      return `$${par.length}`;
    };
    if (f.busca) cond.push(`(e.nome ilike ${p(`%${f.busca}%`)} or e.codigo_erp = ${p(f.busca)} or e.bairro ilike ${p(`%${f.busca}%`)})`);
    if (f.status) cond.push(`e.status = ${p(f.status)}::status_comercial`);
    if (f.segmento) cond.push(`e.segmento = ${p(f.segmento)}::segmento`);
    if (f.vendedorId === 'sem') cond.push(`e.vendedor_id is null`);
    else if (f.vendedorId) cond.push(`e.vendedor_id = ${p(f.vendedorId)}`);
    const where = cond.length ? `where ${cond.join(' and ')}` : '';
    const total = (await tx.query<{ n: number }>(`select count(*)::int as n from estabelecimentos e ${where}`, par)).rows[0].n;
    const r = await tx.query<Record<string, unknown>>(
      `select e.id, e.nome, e.segmento::text, e.status::text, e.tier::text, e.bairro, e.cidade,
              e.vendedor_id, pf.nome as vendedor, c.semaforo, (e.lat is not null) as tem_coord
         from estabelecimentos e
         left join perfis pf on pf.id = e.vendedor_id
         left join v_cadencia c on c.estabelecimento_id = e.id
         ${where}
        order by e.nome limit ${Number(f.limite ?? 100)}`,
      par,
    );
    return {
      total,
      itens: r.rows.map((x) => ({
        id: x.id as string,
        nome: x.nome as string,
        segmento: x.segmento as string,
        status: x.status as StatusComercial,
        tier: x.tier as 'A' | 'B' | 'C',
        bairro: x.bairro as string | null,
        cidade: x.cidade as string | null,
        vendedorId: x.vendedor_id as string | null,
        vendedor: x.vendedor as string | null,
        semaforo: (x.semaforo as Semaforo | null) ?? null,
        temCoordenada: x.tem_coord as boolean,
      })),
    };
  });
}

export interface EdicaoPonto {
  status?: StatusComercial;
  tier?: 'A' | 'B' | 'C';
  segmento?: string;
  vendedorId?: string | null;
}

/** Edita um ou vários pontos de uma vez (gestão). */
export async function atualizarPontos(uid: string, ids: string[], e: EdicaoPonto): Promise<number> {
  return comoUsuario(uid, async (tx) => {
    const sets: string[] = [];
    const par: unknown[] = [ids];
    const p = (v: unknown) => {
      par.push(v);
      return `$${par.length}`;
    };
    if (e.status) sets.push(`status = ${p(e.status)}::status_comercial`);
    if (e.tier) sets.push(`tier = ${p(e.tier)}::tier_cliente`);
    if (e.segmento) sets.push(`segmento = ${p(e.segmento)}::segmento`);
    if ('vendedorId' in e) sets.push(`vendedor_id = ${p(e.vendedorId ?? null)}::uuid`);
    if (!sets.length) return 0;
    const r = await tx.query(`update estabelecimentos set ${sets.join(', ')} where id = any($1::uuid[])`, par);
    await enfileirarTx(tx, 'atualizar_pontos', {
      ids, status: e.status, tier: e.tier, segmento: e.segmento,
      ...('vendedorId' in e ? { vendedor_id: e.vendedorId ?? null } : {}),
    });
    return r.affectedRows ?? 0;
  }).then((n) => (avisarFila(), n));
}

// ---------------------------------------------------------------------------------------------
// Importação
// ---------------------------------------------------------------------------------------------

export interface ResultadoImportacao {
  inseridos: number;
  atualizados: number;
  regioes: number;
  vendedorNaoEncontrado: number;
}

/** Como a cadência dos pontos NOVOS começa (ver migração 0003). */
export type InicioCadencia = 'zero' | 'escalonado' | 'vencidos';

export async function importarKml(
  uid: string,
  itens: ItemImportado[],
  regioes: RegiaoImportada[],
  inicio: InicioCadencia = 'zero',
): Promise<ResultadoImportacao> {
  if (modoReal()) return importarNoServidor(itens, regioes, inicio);
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<{ r: Record<string, number> }>(
      `select importar_estabelecimentos($1::jsonb, $2::jsonb, $3::text) as r`,
      [JSON.stringify(itens), JSON.stringify(regioes), inicio],
    );
    const x = r.rows[0].r;
    return {
      inseridos: x.inseridos,
      atualizados: x.atualizados,
      regioes: x.regioes,
      vendedorNaoEncontrado: x.vendedor_nao_encontrado,
    };
  });
}

/**
 * Modo real: a importação é do servidor (fonte da verdade) e exige internet. Vai em lotes para não
 * estourar o tempo limite de uma chamada; as regiões (polígonos) seguem no primeiro lote. Depois,
 * baixa tudo de novo para o aparelho.
 */
async function importarNoServidor(itens: ItemImportado[], regioes: RegiaoImportada[], inicio: InicioCadencia): Promise<ResultadoImportacao> {
  const t = transporteAtual();
  if (!t) throw new ErroRede('Importar exige conexão com a internet e login.');
  const total: ResultadoImportacao = { inseridos: 0, atualizados: 0, regioes: 0, vendedorNaoEncontrado: 0 };
  const LOTE = 300;
  for (let i = 0; i < Math.max(itens.length, 1); i += LOTE) {
    const x = await t.rpc<Record<string, number>>('importar_estabelecimentos', {
      p_itens: itens.slice(i, i + LOTE),
      p_regioes: i === 0 ? regioes : [],
      p_inicio: inicio,
    });
    total.inseridos += x.inseridos;
    total.atualizados += x.atualizados;
    total.regioes += x.regioes;
    total.vendedorNaoEncontrado += x.vendedor_nao_encontrado;
  }
  await sincronizar({ completo: true });
  return total;
}

// ---------------------------------------------------------------------------------------------
// Regras e configuração (gestão)
// ---------------------------------------------------------------------------------------------

export interface RegraCadencia {
  status: StatusComercial;
  tier: 'A' | 'B' | 'C';
  intervaloDias: number;
  peso: number;
}

export async function listarRegras(uid: string): Promise<RegraCadencia[]> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select status::text, tier::text, intervalo_dias, peso from regras_cadencia
        order by array_position(array['em_prospeccao','ativo','inativo'], status::text), tier`,
    );
    return r.rows.map((x) => ({
      status: x.status as StatusComercial,
      tier: x.tier as 'A' | 'B' | 'C',
      intervaloDias: Number(x.intervalo_dias),
      peso: Number(x.peso),
    }));
  });
}

export async function salvarRegra(uid: string, r: RegraCadencia): Promise<void> {
  await comoUsuario(uid, async (tx) => {
    await tx.query(
      `update regras_cadencia set intervalo_dias = $3, peso = $4
        where status = $1::status_comercial and tier = $2::tier_cliente`,
      [r.status, r.tier, r.intervaloDias, r.peso],
    );
    await enfileirarTx(tx, 'regra', { status: r.status, tier: r.tier, intervalo_dias: r.intervaloDias, peso: r.peso });
  });
  avisarFila();
}

export async function lerRaioCheckin(uid: string): Promise<number> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<{ v: string }>(`select valor #>> '{}' as v from configuracoes where chave = 'raio_checkin_m'`);
    return Number(r.rows[0]?.v ?? 150);
  });
}

export async function salvarRaioCheckin(uid: string, metros: number): Promise<void> {
  await comoUsuario(uid, async (tx) => {
    await tx.query(`update configuracoes set valor = to_jsonb($1::int) where chave = 'raio_checkin_m'`, [metros]);
    await enfileirarTx(tx, 'raio', { metros });
  });
  avisarFila();
}

// ---------------------------------------------------------------------------------------------
// Cadastro na plataforma, duplicados e localização (migração 0004)
// ---------------------------------------------------------------------------------------------

export interface Duplicado {
  id: string;
  nome: string;
  bairro: string | null;
  cidade: string | null;
  vendedorNome: string | null;
  meu: boolean;
  livre: boolean;
  motivo: string;
}

export async function buscarDuplicados(
  uid: string,
  d: { nome?: string; cnpj?: string; codigoErp?: string; cidade?: string },
): Promise<Duplicado[]> {
  return comoUsuario(uid, async (tx) => {
    const r = await tx.query<Record<string, unknown>>(
      `select id, nome, bairro, cidade, vendedor_nome, meu, livre, motivo
         from buscar_duplicados($1, $2, $3, $4)`,
      [d.nome ?? null, d.cnpj ?? null, d.codigoErp ?? null, d.cidade ?? null],
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      nome: x.nome as string,
      bairro: x.bairro as string | null,
      cidade: x.cidade as string | null,
      vendedorNome: x.vendedor_nome as string | null,
      meu: x.meu as boolean,
      livre: x.livre as boolean,
      motivo: x.motivo as string,
    }));
  });
}

export interface NovoCliente {
  nome: string;
  razaoSocial?: string;
  cnpj?: string;
  codigoErp?: string;
  telefone?: string;
  celular?: string;
  contato?: string;
  endereco?: string;
  bairro?: string;
  cidade?: string;
  uf?: string;
  cep?: string;
  segmento?: string;
  tier?: 'A' | 'B' | 'C';
  status?: StatusComercial;
  vendedorId?: string | null;
  lat?: number | null;
  lng?: number | null;
  observacoes?: string;
  /** só a gestão: cadastra mesmo havendo possível duplicado */
  forcar?: boolean;
}

export class ErroDuplicado extends Error {
  constructor(
    message: string,
    public readonly existenteId: string | null,
  ) {
    super(message);
    this.name = 'ErroDuplicado';
  }
}

export async function cadastrarCliente(uid: string, c: NovoCliente): Promise<string> {
  const id = crypto.randomUUID(); // o aparelho decide o id: cadastro offline e servidor são a mesma linha
  const payload = {
    id, nome: c.nome, razao_social: c.razaoSocial, cnpj: c.cnpj, codigo_erp: c.codigoErp, telefone: c.telefone,
    celular: c.celular, contato: c.contato, endereco: c.endereco, bairro: c.bairro, cidade: c.cidade, uf: c.uf,
    cep: c.cep, segmento: c.segmento, tier: c.tier, status: c.status, vendedor_id: c.vendedorId ?? undefined,
    lat: c.lat ?? undefined, lng: c.lng ?? undefined, observacoes: c.observacoes, forcar: c.forcar,
  };
  try {
    const novo = await comoUsuario(uid, async (tx) => {
      const r = await tx.query<{ id: string }>(`select cadastrar_estabelecimento($1::jsonb) as id`, [JSON.stringify(payload)]);
      await enfileirarTx(tx, 'cadastro', payload, r.rows[0].id);
      return r.rows[0].id;
    });
    avisarFila();
    return novo;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    if (err.code === '23505') throw new ErroDuplicado(err.message ?? 'Cliente já cadastrado', err.detail ?? null);
    throw e;
  }
}

export async function definirLocalizacao(uid: string, id: string, lat: number, lng: number): Promise<void> {
  await comoUsuario(uid, async (tx) => {
    await tx.query(`select definir_localizacao($1, $2::float8, $3::float8)`, [id, lat, lng]);
    await enfileirarTx(tx, 'localizacao', { id, lat, lng }, id);
  });
  avisarFila();
}

// ---------------------------------------------------------------------------------------------
// Relatório de visitas
// ---------------------------------------------------------------------------------------------

export interface LinhaRelatorio {
  id: string;
  checkinEm: Date;
  checkoutEm: Date | null;
  pontoId: string;
  ponto: string;
  codigoErp: string | null;
  bairro: string | null;
  cidade: string | null;
  vendedor: string;
  tipo: TipoVisita;
  resultado: ResultadoVisita | null;
  valorPedido: number | null;
  proximoPasso: string | null;
  retornoEm: string | null;
  observacao: string | null;
  validacao: Validacao;
  distanciaM: number | null;
}

export interface FiltroRelatorio {
  /** AAAA-MM-DD, inclusive (fuso de Parnaíba) */
  de?: string;
  ate?: string;
  vendedorId?: string;
  pontoId?: string;
  resultado?: ResultadoVisita | '';
  limite?: number;
}

export async function relatorioVisitas(uid: string, f: FiltroRelatorio = {}): Promise<LinhaRelatorio[]> {
  return comoUsuario(uid, async (tx) => {
    const cond: string[] = [];
    const par: unknown[] = [];
    const p = (v: unknown) => (par.push(v), `$${par.length}`);
    const dia = `(v.checkin_em at time zone 'America/Fortaleza')::date`;
    if (f.de) cond.push(`${dia} >= ${p(f.de)}::date`);
    if (f.ate) cond.push(`${dia} <= ${p(f.ate)}::date`);
    if (f.vendedorId) cond.push(`v.usuario_id = ${p(f.vendedorId)}`);
    if (f.pontoId) cond.push(`v.estabelecimento_id = ${p(f.pontoId)}`);
    if (f.resultado) cond.push(`v.resultado = ${p(f.resultado)}::resultado_visita`);
    const where = cond.length ? `where ${cond.join(' and ')}` : '';
    const r = await tx.query<Record<string, unknown>>(
      `select v.id, v.checkin_em, v.checkout_em, e.id as ponto_id, e.nome as ponto, e.codigo_erp, e.bairro, e.cidade,
              p.nome as vendedor, v.tipo::text, v.resultado::text, v.valor_pedido, v.proximo_passo,
              to_char(v.retorno_em, 'YYYY-MM-DD') as retorno_em, v.observacao, v.validacao::text, v.distancia_m
         from visitas v
         join estabelecimentos e on e.id = v.estabelecimento_id
         join perfis p on p.id = v.usuario_id
         ${where}
        order by v.checkin_em desc
        limit ${Number(f.limite ?? 1000)}`,
      par,
    );
    return r.rows.map((x) => ({
      id: x.id as string,
      checkinEm: x.checkin_em as Date,
      checkoutEm: (x.checkout_em as Date | null) ?? null,
      pontoId: x.ponto_id as string,
      ponto: x.ponto as string,
      codigoErp: x.codigo_erp as string | null,
      bairro: x.bairro as string | null,
      cidade: x.cidade as string | null,
      vendedor: x.vendedor as string,
      tipo: x.tipo as TipoVisita,
      resultado: (x.resultado as ResultadoVisita | null) ?? null,
      valorPedido: num(x.valor_pedido),
      proximoPasso: x.proximo_passo as string | null,
      retornoEm: x.retorno_em as string | null,
      observacao: x.observacao as string | null,
      validacao: x.validacao as Validacao,
      distanciaM: num(x.distancia_m),
    }));
  });
}
