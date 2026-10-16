import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { beforeAll, describe, expect, it } from 'vitest';
import { aplicarRegras, detectarVendedores, sugerirRegras } from '../kml/mapeamento';
import { parseKml } from '../kml/parseKml';
import {
  assumirPonto, atualizarPontos, criarUsuario, editarContato, esquecidos, ficha, fila, garantirVendedores,
  importarKml, listarPontos, painelCobertura, pontosMapa, registrarVisita, totais, validarVisita,
  visitasParaValidar, type Usuario,
} from './api';
import { abrirBanco, comoUsuario } from './banco';

const xml = readFileSync(new URL('../kml/__fixtures__/exemplo.kml', import.meta.url), 'utf8');
const kml = parseKml(xml, new DOMParser() as never);
const vendedoresKml = detectarVendedores(kml.pastas);
const itens = aplicarRegras(kml.itens, sugerirRegras(kml.pastas, vendedoresKml));

let gestor: Usuario;
let joao: Usuario;
let gislandio: Usuario;
const idDe = async (nome: string) =>
  (await comoUsuario(null, (tx) => tx.query<{ id: string }>(`select id from estabelecimentos where nome = $1`, [nome]))).rows[0].id;
const nova = (extra: Partial<Parameters<typeof registrarVisita>[1]> = {}) => ({
  chave: crypto.randomUUID(), tipo: 'venda' as const, checkinEm: new Date(), checkoutEm: new Date(),
  resultado: 'pedido' as const, valorPedido: 120, proximoPasso: null, retornoEm: null, observacao: null,
  gps: { lat: -2.905, lng: -41.776 }, estabelecimentoId: '', ...extra,
});

beforeAll(async () => {
  await abrirBanco(); // memória
  gestor = await criarUsuario('Gestor', 'gestor');
  const [j, g] = await garantirVendedores(vendedoresKml);
  joao = j; gislandio = g;
}, 120_000);

describe('importação pelo pipeline completo', () => {
  it('grava os pontos com mapeamento de pasta, vendedor e região', async () => {
    const r = await importarKml(gestor.id, itens, kml.regioes);
    expect(r).toEqual({ inseridos: 12, atualizados: 0, regioes: 1, vendedorNaoEncontrado: 0 });
    const t = await totais(gestor.id);
    expect(t.porStatus).toMatchObject({ ativo: 6, inativo: 4, em_prospeccao: 2 });
    expect(t.semCoordenada).toBe(2); // coordenadas suspeitas entram sem localização
    expect(t.semDono).toBe(0);
  });

  it('é idempotente e preserva decisões comerciais', async () => {
    await atualizarPontos(gestor.id, [await idDe('CHALANA TESTE')], { status: 'ativo', tier: 'A' });
    const r = await importarKml(gestor.id, itens, kml.regioes);
    expect(r).toMatchObject({ inseridos: 0, atualizados: 12 });
    const f = await ficha(gestor.id, await idDe('CHALANA TESTE'));
    expect(f).toMatchObject({ status: 'ativo', tier: 'A', codigoErp: '100001', regiao: 'CARMO', vendedor: 'João Oliveira' });
    expect(f?.cadencia?.intervaloDias).toBe(15); // ativo A
  });

  it('o banco não guarda CPF/RG/e-mail', async () => {
    const r = await comoUsuario(null, (tx) => tx.query(`select * from estabelecimentos`));
    expect(JSON.stringify(r.rows)).not.toMatch(/123\.456\.789-09|12345678909|196097401|teste@example/);
  });
});

describe('permissões (RLS) pelo app', () => {
  it('cada vendedor só enxerga a própria carteira', async () => {
    expect((await listarPontos(joao.id)).total).toBe(8);
    expect((await listarPontos(gislandio.id)).total).toBe(4);
    expect((await listarPontos(gestor.id)).total).toBe(12);
    expect((await pontosMapa(gislandio.id)).every((p) => p.vendedorId === gislandio.id)).toBe(true);
  });

  it('vendedor não registra visita em ponto alheio', async () => {
    const alheio = await idDe('PADARIA EXEMPLO'); // do Gislandio
    await expect(registrarVisita(joao.id, nova({ estabelecimentoId: alheio }))).rejects.toThrow();
  });

  it('vendedor edita contato do próprio ponto, mas não o status', async () => {
    const meu = await idDe('MERCANTIL TESTE B');
    await editarContato(joao.id, meu, { telefone: null, celular: '(86) 90000-1234', contato: 'Seu Zé', observacoes: 'só manhã' });
    expect((await ficha(joao.id, meu))?.contato).toBe('Seu Zé');
    await expect(comoUsuario(joao.id, (tx) => tx.query(`update estabelecimentos set status='perdido' where id=$1`, [meu]))).rejects.toThrow();
  });
});

describe('cadência, fila e visitas', () => {
  it('fila ordena pelo mais atrasado e traz distância', async () => {
    await comoUsuario(null, (tx) =>
      tx.query(`update estabelecimentos set carteira_desde = now() - interval '70 days' where nome = 'SUPERMERCADO ATIVO 1'`));
    const f = await fila(joao.id, { lat: -2.909, lng: -41.772 }, 3);
    expect(f.map((x) => x.nome)).toEqual(['SUPERMERCADO ATIVO 1']); // só ele está vencido (ativo B: 30 dias)
    expect(f[0]).toMatchObject({ semaforo: 'preto', nuncaVisitado: true, tier: 'B' });
    expect(f[0].diasAtraso).toBe(40);
    expect(f[0].distanciaM).toBeLessThan(100);
    expect((await fila(joao.id, null, 100)).length).toBe(8);
    expect((await fila(joao.id, null, 100))[0].nome).toBe('SUPERMERCADO ATIVO 1');
  });

  it('visita confirmada zera o relógio; fora do raio, não; reenvio não duplica', async () => {
    const id = await idDe('SUPERMERCADO ATIVO 1'); // -2.9090, -41.7720
    const longe = await registrarVisita(joao.id, nova({ estabelecimentoId: id, gps: { lat: -2.95, lng: -41.7 } }));
    expect(longe.validacao).toBe('fora_do_raio');
    expect((await esquecidos(gestor.id, 'preto')).map((e) => e.nome)).toContain('SUPERMERCADO ATIVO 1');

    const chave = crypto.randomUUID();
    const v = nova({ estabelecimentoId: id, chave, gps: { lat: -2.9091, lng: -41.7721 } });
    const ok1 = await registrarVisita(joao.id, v);
    const ok2 = await registrarVisita(joao.id, v); // reenvio offline
    expect(ok1.validacao).toBe('confirmada');
    expect(ok2.id).toBe(ok1.id);
    const f = await ficha(joao.id, id);
    expect(f?.visitas.filter((x) => x.validacao === 'confirmada')).toHaveLength(1);
    expect(f?.cadencia).toMatchObject({ semaforo: 'verde', nuncaVisitado: false });
    expect((await fila(joao.id, null, 3)).length).toBe(0);
  });

  it('gestor valida visita fora do raio e ela passa a contar', async () => {
    const pendentes = await visitasParaValidar(gestor.id);
    expect(pendentes.some((p) => p.vendedor === 'João Oliveira' && p.validacao === 'fora_do_raio')).toBe(true);
    for (const p of pendentes) await validarVisita(gestor.id, p.id);
    expect(await visitasParaValidar(gestor.id)).toHaveLength(0);
  });

  it('painel de cobertura por vendedor', async () => {
    const painel = await painelCobertura(gestor.id);
    const j = painel.find((p) => p.vendedor === 'João Oliveira')!;
    expect(j.pontos).toBe(8);
    expect(j.emDia).toBe(8);
    expect(j.coberturaPct).toBe(100);
    expect((await painelCobertura(gislandio.id)).map((p) => p.vendedor)).toEqual(['Gislandio Silveira']);
  });
});

describe('assumir ponto sem dono', () => {
  it('vendedor assume prospecto livre e ele entra na cadência', async () => {
    await importarKml(gestor.id, [{ ...itens[0], chave_externa: 'kml:livre', nome: 'PONTO LIVRE', codigo_erp: null,
      status: 'prospecto', vendedor_chave: null, lat: -2.9, lng: -41.77 }], []);
    const livre = await idDe('PONTO LIVRE');
    expect((await listarPontos(joao.id)).itens.some((p) => p.nome === 'PONTO LIVRE')).toBe(true); // vê para prospectar
    await assumirPonto(joao.id, livre);
    const f = await ficha(joao.id, livre);
    expect(f).toMatchObject({ status: 'em_prospeccao', vendedor: 'João Oliveira' });
    await expect(assumirPonto(gislandio.id, livre)).rejects.toThrow();
  });
});

describe('início da cadência na importação (0003)', () => {
  const lote = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      ...itens[0], chave_externa: `kml:lote${i}`, nome: `LOTE ${i}`, codigo_erp: null, status: 'ativo' as const,
      tier: 'B' as const, vendedor_chave: 'joao-oliveira', lat: -2.9, lng: -41.7,
    }));

  it('escalonado espalha os vencimentos dentro do ciclo, sem atrasar ninguém', async () => {
    await importarKml(gestor.id, lote(40), [], 'escalonado');
    const f = (await fila(joao.id, null, 365, 500)).filter((x) => x.nome.startsWith('LOTE '));
    expect(f).toHaveLength(40);
    const dias = new Set(f.map((x) => x.diasAtraso));
    expect(Math.max(...dias)).toBeLessThanOrEqual(-1);
    expect(Math.min(...dias)).toBeGreaterThanOrEqual(-30);
    expect(dias.size).toBeGreaterThan(10);
  });

  it('"cobrar já" faz todos vencerem hoje e aparecerem como vencidos', async () => {
    await importarKml(gestor.id, lote(5).map((x, i) => ({ ...x, chave_externa: `kml:hoje${i}`, nome: `HOJE ${i}` })), [], 'vencidos');
    const f = (await fila(joao.id, null, 0, 500)).filter((x) => x.nome.startsWith('HOJE '));
    expect(f).toHaveLength(5);
    expect(f.every((x) => x.diasAtraso === 0)).toBe(true);
  });
});
