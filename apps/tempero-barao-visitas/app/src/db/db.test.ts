import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { beforeAll, describe, expect, it } from 'vitest';
import { aplicarRegras, detectarVendedores, sugerirRegras } from '../kml/mapeamento';
import { parseKml } from '../kml/parseKml';
import {
  assumirPonto, atualizarPontos, buscarDuplicados, cadastrarCliente, criarUsuario, definirLocalizacao, editarContato,
  ErroDuplicado, esquecidos, ficha, fila, garantirVendedores, importarKml, listarPontos, listarPontosVisiveis,
  painelCobertura, pontosMapa, registrarVisita, relatorioVisitas, resumoPonto, totais, validarVisita,
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
    // o mapa mostra todos, mas só os dele vêm com detalhe; os do colega vêm sem status/classe
    const mapa = await pontosMapa(gislandio.id);
    expect(mapa.filter((p) => p.meu).every((p) => p.vendedorId === gislandio.id && p.status !== null)).toBe(true);
    expect(mapa.filter((p) => !p.meu && !p.livre).every((p) => p.status === null && p.tier === null)).toBe(true);
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

describe('vendedor vê os clientes dos colegas só como "vinculado a" (0004)', () => {
  it('lista e mapa mostram os pontos de outros, sem dados de cadastro', async () => {
    const todos = await listarPontosVisiveis(joao.id, { limite: 1000 });
    const dosColegas = todos.itens.filter((p) => !p.meu && !p.livre);
    expect(dosColegas.length).toBeGreaterThan(0);
    expect(dosColegas.every((p) => p.vendedorNome === 'Gislandio Silveira' && p.status === null && p.tier === null)).toBe(true);
    expect((await listarPontosVisiveis(joao.id, { escopo: 'outros', limite: 1000 })).itens.every((p) => !p.meu && !p.livre)).toBe(true);
    expect((await listarPontosVisiveis(joao.id, { escopo: 'meus', limite: 1000 })).itens.every((p) => p.meu)).toBe(true);
    const mapa = await pontosMapa(joao.id);
    const alheio = mapa.find((p) => p.vendedorNome === 'Gislandio Silveira')!;
    expect(alheio).toMatchObject({ meu: false, livre: false, semaforo: null, status: null });
  });

  it('a ficha do cliente alheio é negada, mas o resumo diz de quem é', async () => {
    const id = await idDe('PADARIA EXEMPLO'); // do Gislandio
    expect(await ficha(joao.id, id)).toBeNull();
    expect(await resumoPonto(joao.id, id)).toMatchObject({ nome: 'PADARIA EXEMPLO', vendedorNome: 'Gislandio Silveira', meu: false });
    expect((await ficha(gestor.id, id))?.codigoErp).toBe('100020'); // gestão vê tudo
  });

  it('a busca ignora acento e caixa', async () => {
    const r = await listarPontosVisiveis(gestor.id, { busca: 'padaria EXÉMPLO' });
    expect(r.itens.map((p) => p.nome)).toContain('PADARIA EXEMPLO');
  });
});

describe('cadastro de cliente na plataforma (0004)', () => {
  it('vendedor cadastra na própria carteira, com localização, e já entra na cadência', async () => {
    const id = await cadastrarCliente(joao.id, {
      nome: 'Tempero & Cia Novo', cnpj: '12.345.678/0001-90', telefone: '(86) 91111-2222', cidade: 'Parnaíba',
      bairro: 'Centro', segmento: 'varejo', status: 'ativo', lat: -2.905, lng: -41.776,
    });
    const f = await ficha(joao.id, id);
    expect(f).toMatchObject({ vendedor: 'João Oliveira', status: 'ativo', lat: -2.905, segmento: 'varejo', cnpj: '12.345.678/0001-90' });
    expect(f?.cadencia?.semaforo).toBe('verde');
    // o colega já o enxerga, vinculado ao João
    expect((await resumoPonto(gislandio.id, id))?.vendedorNome).toBe('João Oliveira');
  });

  it('barra duplicado por CNPJ (formatado diferente), código do ERP e nome+cidade, dizendo de quem é', async () => {
    const porCnpj = cadastrarCliente(gislandio.id, { nome: 'Outro nome qualquer', cnpj: '12345678000190' });
    await expect(porCnpj).rejects.toBeInstanceOf(ErroDuplicado);
    await expect(porCnpj).rejects.toThrow(/mesmo CNPJ.*vinculado a João Oliveira/);
    await expect(cadastrarCliente(gislandio.id, { nome: 'Zzz', codigoErp: '100001' })).rejects.toThrow(/código do ERP/);
    await expect(cadastrarCliente(gislandio.id, { nome: 'TEMPERO & CIA  NOVO', cidade: 'PARNAIBA' })).rejects.toThrow(/nome e cidade/);
    // mesmo nome em outra cidade é outro cliente
    await expect(cadastrarCliente(gislandio.id, { nome: 'Tempero & Cia Novo', cidade: 'Luís Correia' })).resolves.toBeTruthy();
    const d = await buscarDuplicados(gislandio.id, { cnpj: '12.345.678/0001-90' });
    expect(d[0]).toMatchObject({ vendedorNome: 'João Oliveira', meu: false, motivo: 'mesmo CNPJ' });
  });

  it('vendedor não força nem escolhe vendedor; a gestão sim', async () => {
    await expect(cadastrarCliente(joao.id, { nome: 'X', codigoErp: '100001', forcar: true })).rejects.toBeInstanceOf(ErroDuplicado);
    const id = await cadastrarCliente(joao.id, { nome: 'Cliente do Gislandio?', vendedorId: gislandio.id, status: 'inativo' });
    expect(await ficha(gislandio.id, id)).toBeNull(); // ficou com o João, não com o Gislandio
    const g = await cadastrarCliente(gestor.id, { nome: 'Por conta da gestão', vendedorId: gislandio.id, status: 'ativo', tier: 'A' });
    expect(await ficha(gislandio.id, g)).toMatchObject({ vendedor: 'Gislandio Silveira', status: 'ativo', tier: 'A' });
    await expect(cadastrarCliente(gestor.id, { nome: 'Forçado', codigoErp: '100001', forcar: true })).resolves.toBeTruthy();
  });
});

describe('localização definida pelo GPS (0004)', () => {
  it('vendedor define o ponto de cliente sem localização uma única vez; a gestão corrige', async () => {
    const id = await cadastrarCliente(joao.id, { nome: 'Sem pino ainda', cidade: 'Piracuruca' });
    expect((await ficha(joao.id, id))?.lat).toBeNull();
    await definirLocalizacao(joao.id, id, -3.9, -41.7);
    expect((await ficha(joao.id, id))?.lat).toBe(-3.9);
    await expect(definirLocalizacao(joao.id, id, -1, -1)).rejects.toThrow(/só a gestão/);
    await definirLocalizacao(gestor.id, id, -3.95, -41.75);
    expect((await ficha(gestor.id, id))?.lat).toBe(-3.95);
    await expect(definirLocalizacao(gislandio.id, id, 0, 0)).rejects.toThrow();
  });
});

describe('relatório de visitas', () => {
  it('lista com data e hora, respeita permissões e filtros', async () => {
    const id = await idDe('CHALANA TESTE');
    await registrarVisita(joao.id, nova({ estabelecimentoId: id, gps: { lat: -2.905, lng: -41.776 }, valorPedido: 200, observacao: 'primeira' }));
    const meu = await relatorioVisitas(joao.id);
    expect(meu.length).toBeGreaterThan(0);
    expect(meu.every((l) => l.vendedor === 'João Oliveira')).toBe(true);
    expect(meu[0].checkinEm).toBeInstanceOf(Date);
    expect(meu.some((l) => l.ponto === 'CHALANA TESTE' && l.valorPedido === 200)).toBe(true);
    expect(await relatorioVisitas(gislandio.id)).toHaveLength(0); // não vê visitas do colega
    const todas = await relatorioVisitas(gestor.id);
    expect(todas.length).toBe(meu.length);
    expect(await relatorioVisitas(gestor.id, { pontoId: id })).not.toHaveLength(0);
    expect(await relatorioVisitas(gestor.id, { vendedorId: gislandio.id })).toHaveLength(0);
    expect(await relatorioVisitas(gestor.id, { de: '2999-01-01' })).toHaveLength(0);
  });
});

describe('planilha do ERP sobre pontos do mapa (0005)', () => {
  it('atualiza cadastro mas preserva nome curado e localização; clientes novos entram sem local', async () => {
    const { paraItens } = await import('../planilha/clientes');
    const antes = await ficha(gestor.id, await idDe('CHALANA TESTE'));
    expect(antes?.lat).toBe(-2.905);

    const { itens: doErp } = paraItens(
      [
        { codigoErp: '100001', nome: 'JULIA TESTE DA SILVA', celular: '(86) 97777-1234', endereco: 'Av Nova, 99' }, // já está no mapa
        { codigoErp: '555001', nome: 'CLIENTE SO NA PLANILHA', cnpj: '55.666.777/0001-88', bairro: 'Centro', cidade: 'Parnaíba' },
      ],
      { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null },
    );
    const r = await importarKml(gestor.id, doErp, [], 'zero');
    expect(r).toMatchObject({ inseridos: 1, atualizados: 1 });

    const depois = await ficha(gestor.id, await idDe('CHALANA TESTE'));
    expect(depois).toMatchObject({ nome: 'CHALANA TESTE', lat: -2.905, lng: -41.776, celular: '(86) 97777-1234', endereco: 'Av Nova, 99' });
    const novo = await ficha(gestor.id, await idDe('CLIENTE SO NA PLANILHA'));
    expect(novo).toMatchObject({ lat: null, status: 'prospecto', cnpj: '55.666.777/0001-88', codigoErp: '555001', vendedor: null });
    // sem dono e sem localização: aparece para qualquer vendedor assumir e marcar o ponto
    expect((await listarPontosVisiveis(gislandio.id, { escopo: 'livres', limite: 1000 })).itens.some((p) => p.nome === 'CLIENTE SO NA PLANILHA' && !p.temCoordenada)).toBe(true);
  });
});

describe('planilha casa com o mapa por CNPJ e nome provisório (0006)', () => {
  it('não duplica por CNPJ nem por endereço provisório; nome real substitui o provisório', async () => {
    const { paraItens } = await import('../planilha/clientes');
    const base = { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null } as const;
    const sem = paraItens(
      [{ endereco: 'Rua das Acácias, 77', cidade: 'Parnaíba', cnpj: '12.345.678/0001-95' }, { endereco: 'Rua dos Ipês, 3', cidade: 'Parnaíba' }],
      { ...base, incluirSemNome: true },
    );
    expect(sem.itens.every((i) => i.atributos?.nome_provisorio)).toBe(true);
    await importarKml(gestor.id, sem.itens, [], 'zero');
    const total = (await listarPontosVisiveis(gestor.id, { escopo: 'todos', limite: 5000 })).total;

    // mesma planilha de novo: idempotente
    await importarKml(gestor.id, sem.itens, [], 'zero');
    expect((await listarPontosVisiveis(gestor.id, { escopo: 'todos', limite: 5000 })).total).toBe(total);

    // exportação nova, agora com nomes e códigos: atualiza os mesmos pontos
    const com = paraItens(
      [{ codigoErp: '700001', nome: 'PADARIA ACACIAS', endereco: 'RUA DAS ACACIAS, 77', cidade: 'Parnaiba', cnpj: '12.345.678/0001-95' },
       { codigoErp: '700002', nome: 'BAR DOS IPES', endereco: 'Rua dos Ipês, 3', cidade: 'Parnaíba' }],
      base,
    );
    const r = await importarKml(gestor.id, com.itens, [], 'zero');
    expect(r).toMatchObject({ inseridos: 0, atualizados: 2 });
    expect((await listarPontosVisiveis(gestor.id, { escopo: 'todos', limite: 5000 })).total).toBe(total);
    const f = await ficha(gestor.id, await idDe('PADARIA ACACIAS'));
    expect(f).toMatchObject({ codigoErp: '700001' });
    expect(await idDe('BAR DOS IPES')).toBeTruthy();
  });
});

describe('cópia de segurança', () => {
  it('a gestão leva tudo; vendedor não gera a cópia da empresa', async () => {
    const { copiaDeSeguranca } = await import('./api');
    const c = await copiaDeSeguranca(gestor.id);
    expect(c.versao).toBe(1);
    expect(c.estabelecimentos.length).toBeGreaterThan(10);
    expect(c.visitas.length).toBeGreaterThan(0);
    expect(c.perfis.length).toBeGreaterThanOrEqual(3);
    expect(JSON.parse(JSON.stringify(c)).regras).toHaveLength(9);
    await expect(copiaDeSeguranca(joao.id)).rejects.toThrow(/gestão/);
  });
});

describe('migrações do app', () => {
  it('o banco do navegador aplica TODAS as migrações da pasta supabase/migrations, na ordem', async () => {
    const { readdirSync } = await import('node:fs');
    const { MIGRACOES } = await import('./schema');
    const arquivos = readdirSync(new URL('../../../supabase/migrations/', import.meta.url)).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRACOES.map((m) => m.nome + '.sql')).toEqual(arquivos);
  });

  it('o setup_producao.sql (colado no Supabase) contém exatamente as migrações atuais', async () => {
    const { readFileSync } = await import('node:fs');
    const pasta = new URL('../../../supabase/', import.meta.url);
    const setup = readFileSync(new URL('setup_producao.sql', pasta), 'utf8');
    const { MIGRACOES } = await import('./schema');
    for (const m of MIGRACOES) {
      expect(setup, `rode supabase/gerar_setup.sh (faltou ${m.nome})`).toContain(m.sql);
    }
  });
});
