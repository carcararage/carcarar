/**
 * Sincronização ponta a ponta: celulares (PGlite, o mesmo banco do navegador) × servidor (Postgres de
 * verdade com as migrações do Supabase). O transporte aqui executa as mesmas funções (RPC) que o
 * Supabase expõe, como o usuário `authenticated` com o login de cada pessoa — então RLS, gatilhos e
 * validações do servidor valem como em produção. Só não passa por PostgREST/Auth.
 * Pula sozinho se não houver Postgres local (createdb/psql).
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assumirPonto, atualizarPontos, cadastrarCliente, definirLocalizacao, editarContato, ErroDuplicado, ficha,
  importarKml, listarPontosVisiveis, registrarVisita, relatorioVisitas, resumoPonto, validarVisita,
} from '../db/api';
import { abrirBanco, comoUsuario, esquecerBanco, usarBanco } from '../db/banco';
import { forcarModoReal } from './modo';
import { baixar, contarFila, descartarRejeitadas, listarFila, sincronizar } from './motor';
import { definirTransporte, ErroRede, type Transporte } from './transporte';

const BANCO = `barao_sync_${process.pid}`;
const SOCKET = process.env.PGHOST ?? '/var/run/postgresql';
const raiz = join(import.meta.dirname, '../../../supabase');

const pgDisponivel = (() => {
  try {
    execSync('psql -X -qc "select 1" postgres', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const G = '00000000-0000-0000-0000-00000000000a';
const J = '00000000-0000-0000-0000-000000000001';
const S = '00000000-0000-0000-0000-000000000002';

let srv: Client;
let queda = false; // sem sinal: o transporte falha antes de falar com o servidor
let perdeResposta = 0; // o servidor executa, mas a resposta se perde (celular perde sinal no meio)

/** Executa uma RPC no servidor como o usuário `uid` (papel authenticated), igual ao PostgREST. */
function transporteDe(uid: string): Transporte {
  return {
    async rpc<T>(nome: string, args: Record<string, unknown> = {}): Promise<T> {
      if (queda) throw new ErroRede();
      const chaves = Object.keys(args);
      const params = chaves.map((k) => (typeof args[k] === 'string' ? (args[k] as string) : JSON.stringify(args[k])));
      const lista = chaves.map((k, i) => `${k} => $${i + 1}::${typeof args[k] === 'string' ? 'text' : 'jsonb'}`).join(', ');
      await srv.query('begin');
      try {
        await srv.query('set local role authenticated');
        await srv.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
        const r = await srv.query(`select ${nome}(${lista}) as r`, params);
        await srv.query('commit');
        if (perdeResposta > 0 && nome === 'sync_enviar') {
          perdeResposta--;
          throw new ErroRede('resposta perdida');
        }
        return r.rows[0].r as T;
      } catch (e) {
        await srv.query('rollback').catch(() => undefined);
        throw e;
      }
    },
  };
}

interface Aparelho { db: PGlite; uid: string }
async function novoAparelho(uid: string): Promise<Aparelho> {
  esquecerBanco();
  const db = await abrirBanco();
  return { db, uid };
}
async function usar(a: Aparelho) {
  usarBanco(a.db);
  definirTransporte(transporteDe(a.uid));
}

const ids: Record<string, string> = {};
const idDoServidor = async (nome: string) => (await srv.query(`select id from estabelecimentos where nome = $1`, [nome])).rows[0].id as string;
const nova = (estabelecimentoId: string, extra: Record<string, unknown> = {}) => ({
  chave: crypto.randomUUID(), estabelecimentoId, tipo: 'venda' as const, checkinEm: new Date(), checkoutEm: new Date(),
  resultado: 'pedido' as const, valorPedido: 100, proximoPasso: null, retornoEm: null, observacao: 'visita de teste',
  gps: null as { lat: number; lng: number } | null, ...extra,
});

let joao: Aparelho;
let gislandio: Aparelho;
let gestao: Aparelho;

describe.skipIf(!pgDisponivel)('sincronização celular × servidor', () => {
  beforeAll(async () => {
    execSync(`createdb ${BANCO}`);
    srv = new Client({ host: SOCKET, database: BANCO, user: process.env.PGUSER ?? userInfo().username });
    await srv.connect();
    await srv.query(readFileSync(join(raiz, 'local/stub_supabase.sql'), 'utf8'));
    for (const f of readdirSync(join(raiz, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
      await srv.query(readFileSync(join(raiz, 'migrations', f), 'utf8'));
    }
    await srv.query(`
      insert into auth.users (id, email, raw_user_meta_data) values
        ('${G}', 'gestor@x.test', '{"nome":"Gestão Barão"}'),
        ('${J}', 'joao@x.test', '{"nome":"João Oliveira"}'),
        ('${S}', 'gislandio@x.test', '{"nome":"Gislandio Silveira"}');
      update perfis set papel = 'gestor' where id = '${G}';
      update perfis set chave_import = 'joao-oliveira' where id = '${J}';
      update perfis set chave_import = 'gislandio-silveira' where id = '${S}';
      select importar_estabelecimentos('[
        {"chave_externa":"k1","nome":"Restaurante do João","lat":-2.9050,"lng":-41.7760,"telefone":"(86) 3000-0001","cidade":"Parnaíba","status":"ativo","tier":"A","vendedor_chave":"joao-oliveira"},
        {"chave_externa":"k2","nome":"Mercado do João","lat":-2.9100,"lng":-41.7800,"cidade":"Parnaíba","status":"ativo","tier":"B","vendedor_chave":"joao-oliveira"},
        {"chave_externa":"k3","nome":"Padaria do Gislandio","lat":-2.9150,"lng":-41.7700,"telefone":"(86) 3000-0003","cidade":"Parnaíba","status":"ativo","tier":"C","vendedor_chave":"gislandio-silveira"},
        {"chave_externa":"k4","nome":"Sem Local","lat":null,"lng":null,"cidade":"Parnaíba","status":"ativo","tier":"C","vendedor_chave":"joao-oliveira"},
        {"chave_externa":"k5","nome":"Bar Livre","lat":-2.9200,"lng":-41.7650,"cidade":"Parnaíba","status":"prospecto"},
        {"chave_externa":"k6","nome":"Bar Livre Dois","lat":-2.9210,"lng":-41.7660,"cidade":"Parnaíba","status":"prospecto"}
      ]'::jsonb);`);
    for (const n of ['Restaurante do João', 'Mercado do João', 'Padaria do Gislandio', 'Sem Local', 'Bar Livre', 'Bar Livre Dois']) ids[n] = await idDoServidor(n);

    forcarModoReal(true);
    joao = await novoAparelho(J);
    gislandio = await novoAparelho(S);
    gestao = await novoAparelho(G);
  }, 180_000);

  afterAll(async () => {
    forcarModoReal(null);
    definirTransporte(null);
    await srv?.end();
    try { execSync(`dropdb --if-exists ${BANCO}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  });

  it('1ª sincronização: o vendedor recebe a própria carteira completa e a dos outros só como "vinculado"', async () => {
    await usar(joao);
    await sincronizar({ completo: true });
    const lista = await listarPontosVisiveis(J, { escopo: 'todos', limite: 100 });
    expect(lista.total).toBe(6);
    const f = await ficha(J, ids['Restaurante do João']);
    expect(f).toMatchObject({ nome: 'Restaurante do João', telefone: '(86) 3000-0001', status: 'ativo', tier: 'A' });
    expect(await ficha(J, ids['Padaria do Gislandio'])).toBeNull(); // sem acesso à ficha
    const alheio = await resumoPonto(J, ids['Padaria do Gislandio']);
    expect(alheio).toMatchObject({ nome: 'Padaria do Gislandio', vendedorNome: 'Gislandio Silveira', meu: false });
    // o aparelho do João não guarda contato de cliente alheio, nem mesmo "escondido"
    const bruto = await comoUsuario(null, (tx) => tx.query(`select telefone, status from estabelecimentos where id = $1`, [ids['Padaria do Gislandio']]));
    expect(bruto.rows[0]).toMatchObject({ telefone: null, status: 'prospecto' });
    expect(await contarFila()).toEqual({ pendentes: 0, rejeitadas: 0 });
  });

  it('sem sinal: tudo funciona no aparelho e fica na fila; ao voltar o sinal vai para o servidor', async () => {
    await usar(joao);
    queda = true;
    const v = nova(ids['Restaurante do João'], { gps: { lat: -2.905, lng: -41.776 } });
    const r = await registrarVisita(J, v);
    expect(r.validacao).toBe('confirmada'); // a validação local usa a mesma função do servidor
    await editarContato(J, ids['Restaurante do João'], { telefone: '(86) 3000-9999', celular: null, contato: 'Dona Maria', observacoes: 'prefere manhã' });
    await assumirPonto(J, ids['Bar Livre']);
    await definirLocalizacao(J, ids['Sem Local'], -2.93, -41.76);
    const novoId = await cadastrarCliente(J, { nome: 'Lanchonete Cadastrada Offline', cidade: 'Parnaíba', bairro: 'Centro', status: 'ativo', lat: -2.9, lng: -41.77 });
    const v2 = nova(novoId, { gps: { lat: -2.9, lng: -41.77 }, observacao: 'primeira visita ao cliente novo' });
    await registrarVisita(J, v2);

    await sincronizar();
    expect(await contarFila()).toEqual({ pendentes: 6, rejeitadas: 0 });
    expect((await srv.query(`select count(*)::int n from visitas`)).rows[0].n).toBe(0); // nada chegou ainda

    queda = false;
    await sincronizar();
    expect(await contarFila()).toEqual({ pendentes: 0, rejeitadas: 0 });

    // no servidor: mesmas linhas, mesmos ids, validação do servidor
    const sv = (await srv.query(`select id, validacao, usuario_id from visitas where chave_idempotencia = $1`, [v.chave])).rows[0];
    expect(sv).toMatchObject({ id: v.chave, validacao: 'confirmada', usuario_id: J });
    expect((await srv.query(`select count(*)::int n from visitas`)).rows[0].n).toBe(2);
    expect((await srv.query(`select telefone, contato from estabelecimentos where id = $1`, [ids['Restaurante do João']])).rows[0]).toMatchObject({ telefone: '(86) 3000-9999', contato: 'Dona Maria' });
    expect((await srv.query(`select vendedor_id from estabelecimentos where id = $1`, [ids['Bar Livre']])).rows[0].vendedor_id).toBe(J);
    expect((await srv.query(`select lat from estabelecimentos where id = $1`, [ids['Sem Local']])).rows[0].lat).toBeCloseTo(-2.93);
    const cad = (await srv.query(`select id, vendedor_id, status from estabelecimentos where id = $1`, [novoId])).rows[0];
    expect(cad).toMatchObject({ id: novoId, vendedor_id: J, status: 'ativo' });
  });

  it('o outro vendedor passa a ver o que mudou — só como "vinculado" — e nunca as visitas do colega', async () => {
    await usar(gislandio);
    await sincronizar({ completo: true });
    const livres = await listarPontosVisiveis(S, { escopo: 'livres', limite: 100 });
    expect(livres.itens.map((p) => p.nome)).toEqual(['Bar Livre Dois']); // o Bar Livre já é do João
    expect(await ficha(S, ids['Bar Livre'])).toBeNull();
    expect((await resumoPonto(S, ids['Bar Livre']))?.vendedorNome).toBe('João Oliveira');
    expect(await relatorioVisitas(S)).toHaveLength(0);
    expect((await listarPontosVisiveis(S, { escopo: 'todos', limite: 100 })).total).toBe(7);
  });

  it('incremental: só baixa o que mudou; reatribuição esconde o cliente do antigo dono', async () => {
    await usar(gestao);
    await sincronizar({ completo: true });
    await atualizarPontos(G, [ids['Mercado do João']], { tier: 'A' });
    await sincronizar();
    expect((await srv.query(`select tier from estabelecimentos where id = $1`, [ids['Mercado do João']])).rows[0].tier).toBe('A');

    await usar(joao);
    await sincronizar();
    expect((await ficha(J, ids['Mercado do João']))?.tier).toBe('A'); // veio no delta

    // a gestão passa o Mercado para o Gislandio: no aparelho do João ele vira "vinculado"
    await usar(gestao);
    await atualizarPontos(G, [ids['Mercado do João']], { vendedorId: S });
    await sincronizar();
    await usar(joao);
    await sincronizar();
    expect(await ficha(J, ids['Mercado do João'])).toBeNull();
    const bruto = await comoUsuario(null, (tx) => tx.query(`select telefone, status, tier from estabelecimentos where id = $1`, [ids['Mercado do João']]));
    expect(bruto.rows[0]).toMatchObject({ status: 'prospecto', tier: 'C' }); // nada do cadastro ficou no aparelho
    expect((await resumoPonto(J, ids['Mercado do João']))?.vendedorNome).toBe('Gislandio Silveira');
  });

  it('o servidor recusa o que não pode: o aparelho desfaz o efeito e guarda o motivo (nada some sem aviso)', async () => {
    await usar(joao);
    queda = true;
    // 1) assume o Bar Livre Dois offline...
    await assumirPonto(J, ids['Bar Livre Dois']);
    // 2) cadastra um cliente que na verdade já existe (do Gislandio) e visita esse "novo" cliente
    const dupId = await cadastrarCliente(J, { nome: 'Padaria Do Gislandio', cidade: 'Parnaíba' }).catch((e) => e);
    // o aparelho do João só vê o nome (mínimo) do cliente do Gislandio, então a duplicidade é barrada já no aparelho
    expect(dupId).toBeInstanceOf(ErroDuplicado);
    await sincronizar();
    expect((await contarFila()).pendentes).toBe(1);

    // enquanto isso, o Gislandio assumiu o mesmo ponto no servidor
    await srv.query(`update estabelecimentos set vendedor_id = $2, carteira_desde = now() where id = $1`, [ids['Bar Livre Dois'], S]);
    queda = false;
    await sincronizar();

    const fila = await listarFila();
    expect(fila).toHaveLength(1);
    expect(fila[0]).toMatchObject({ tipo: 'assumir', estado: 'rejeitada' });
    expect(fila[0].erro).toMatch(/Ponto indisponível/);
    expect(await contarFila()).toEqual({ pendentes: 0, rejeitadas: 1 });
    // o aparelho voltou a refletir o servidor: o ponto é do Gislandio, não do João
    expect((await resumoPonto(J, ids['Bar Livre Dois']))?.vendedorNome).toBe('Gislandio Silveira');
    expect(await ficha(J, ids['Bar Livre Dois'])).toBeNull();
    await descartarRejeitadas();
    expect(await contarFila()).toEqual({ pendentes: 0, rejeitadas: 0 });
  });

  it('cadastro recusado no servidor derruba o cliente e as visitas que dependiam dele', async () => {
    await usar(joao);
    queda = true;
    // cliente com CNPJ igual ao de um cadastro que só o servidor conhece (o aparelho não tem CNPJ de outros)
    await srv.query(`update estabelecimentos set cnpj = '11.222.333/0001-81' where id = $1`, [ids['Padaria do Gislandio']]);
    const novoId = await cadastrarCliente(J, { nome: 'Nome Totalmente Diferente', cnpj: '11.222.333/0001-81', cidade: 'Parnaíba' });
    await registrarVisita(J, nova(novoId));
    await sincronizar();
    expect((await contarFila()).pendentes).toBe(2);
    queda = false;
    const antes = (await srv.query(`select count(*)::int n from estabelecimentos`)).rows[0].n;
    await sincronizar();
    expect((await srv.query(`select count(*)::int n from estabelecimentos`)).rows[0].n).toBe(antes);
    const fila = await listarFila();
    expect(fila.map((f) => f.estado)).toEqual(['rejeitada', 'rejeitada']);
    expect(fila[0].erro).toMatch(/mesmo CNPJ/);
    expect(fila[1].erro).toMatch(/Cliente não foi cadastrado/);
    // aparelho limpo: o cliente fantasma sumiu
    const sobrou = await comoUsuario(null, (tx) => tx.query(`select 1 from estabelecimentos where id = $1`, [novoId]));
    expect(sobrou.rows).toHaveLength(0);
    await descartarRejeitadas();
  });

  it('resposta perdida: o servidor já gravou, o aparelho reenvia, e não duplica', async () => {
    await usar(joao);
    const v = nova(ids['Restaurante do João'], { gps: { lat: -2.905, lng: -41.776 } });
    await registrarVisita(J, v); // tenta enviar sozinho: o servidor grava, a resposta se perde
    perdeResposta = 1;
    await sincronizar();
    // (a chamada automática do registrarVisita pode ter sido a que "perdeu"; de qualquer forma, reenvia)
    await sincronizar();
    perdeResposta = 0;
    await sincronizar();
    expect(await contarFila()).toEqual({ pendentes: 0, rejeitadas: 0 });
    expect((await srv.query(`select count(*)::int n from visitas where chave_idempotencia = $1`, [v.chave])).rows[0].n).toBe(1);
  });

  it('gestão: a importação vai direto ao servidor (em lotes) e volta para o aparelho', async () => {
    await usar(gestao);
    const itens = Array.from({ length: 650 }, (_, i) => ({
      chave_externa: `imp${i}`, nome: `Importado ${i}`, lat: -2.9 - i / 100000, lng: -41.7, endereco: null, bairro: null, cidade: 'Parnaíba',
      uf: 'PI', cep: null, telefone: null, celular: null, contato: null, codigo_erp: null, razao_social: null, cnpj: null,
      observacoes: null, categoria: null, grupo_origem: 'teste', regiao: null, segmento: 'outro' as const, atributos: {},
      status: 'ativo' as const, tier: 'C' as const, vendedor_chave: i % 2 ? 'joao-oliveira' : 'gislandio-silveira',
    }));
    const r = await importarKml(G, itens as never, [], 'escalonado');
    expect(r).toMatchObject({ inseridos: 650, atualizados: 0, vendedorNaoEncontrado: 0 });
    expect((await srv.query(`select count(*)::int n from estabelecimentos where nome like 'Importado %'`)).rows[0].n).toBe(650);
    expect((await listarPontosVisiveis(G, { escopo: 'todos', limite: 1 })).total).toBeGreaterThanOrEqual(650);
    // o vendedor recebe só a parte dele completa; a do outro, mínima
    await usar(joao);
    await sincronizar();
    const meus = await listarPontosVisiveis(J, { escopo: 'meus', limite: 1000 });
    expect(meus.itens.filter((p) => p.nome.startsWith('Importado ')).length).toBe(325);
  });

  it('gestão valida visita e o vendedor enxerga a validação depois de sincronizar', async () => {
    await usar(joao);
    const v = nova(ids['Restaurante do João'], { gps: { lat: -2.99, lng: -41.776 } }); // longe: fora do raio
    expect((await registrarVisita(J, v)).validacao).toBe('fora_do_raio');
    await sincronizar();
    const id = (await srv.query(`select id from visitas where chave_idempotencia = $1`, [v.chave])).rows[0].id;
    await usar(gestao);
    await sincronizar();
    await validarVisita(G, id);
    await sincronizar();
    expect((await srv.query(`select validacao from visitas where id = $1`, [id])).rows[0].validacao).toBe('validada_gestor');
    await usar(joao);
    await sincronizar();
    const rel = await relatorioVisitas(J);
    expect(rel.find((x) => x.id === id)?.validacao).toBe('validada_gestor');
  });

  it('baixar de novo não perde nada nem bagunça (idempotente)', async () => {
    await usar(joao);
    const antes = (await listarPontosVisiveis(J, { escopo: 'todos', limite: 5000 })).total;
    await baixar({ completo: true });
    await baixar();
    expect((await listarPontosVisiveis(J, { escopo: 'todos', limite: 5000 })).total).toBe(antes);
  });
});
