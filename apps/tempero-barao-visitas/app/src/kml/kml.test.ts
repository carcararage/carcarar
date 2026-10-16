import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { lerKmlDeBytes } from './arquivo';
import { parseDescricaoErp, redigir } from './erp';
import { hash53, pontoNoAnel } from './geo';
import { aplicarRegras, detectarVendedores, sugerirRegras } from './mapeamento';
import { parseKml, type ResultadoKml } from './parseKml';

const parser = new DOMParser() as unknown as Parameters<typeof parseKml>[1];
const xml = readFileSync(new URL('./__fixtures__/exemplo.kml', import.meta.url), 'utf8');
const res: ResultadoKml = parseKml(xml, parser);
const por = (nome: string) => res.itens.find((i) => i.nome === nome)!;

describe('parseKml: contagens', () => {
  it('conta pontos, regiões e o que foi ignorado', () => {
    expect(res.resumo).toMatchObject({
      placemarks: 18,
      pontos: 12,
      duplicadosNoArquivo: 1, // mesmo código ERP marcado duas vezes
      rotulosRegiao: 2, // valores por bairro não viram estabelecimento
      linhasIgnoradas: 1,
      semGeometria: 1,
      regioes: 1,
      comCodigoErp: 6,
      comRegiao: 4,
      coordenadasSuspeitas: 2,
    });
  });
  it('região sem nome usa o nome da pasta; rótulos de valores vão para a região', () => {
    expect(res.regioes[0].nome).toBe('CARMO');
    expect(res.regioes[0].atributos.rotulos_vendas).toEqual([
      'DO CARMO - RESTAURANTE: 301,98',
      'COMERCIO R$ 931,30',
    ]);
    expect(res.itens.some((i) => /R\$|301,98/.test(i.nome))).toBe(false);
  });
  it('ponto recebe a região que o contém', () => {
    expect(por('CHALANA TESTE').regiao).toBe('CARMO');
    expect(por('MERCANTIL TESTE B').regiao).toBeNull();
  });
});

describe('texto do ERP (3 layouts)', () => {
  it('layout A', () => {
    expect(por('CHALANA TESTE')).toMatchObject({
      chave_externa: 'erp:100001',
      codigo_erp: '100001',
      razao_social: 'JULIA TESTE DA SILVA',
      endereco: 'AV EXEMPLO, Nº 188 ANEXO A',
      bairro: 'CARMO',
      cidade: 'Parnaíba',
      uf: 'PI',
      cep: '64.200-040',
      telefone: '(86) 3322-0001',
      celular: '(86) 99999-0001',
      cnpj: '11.222.333/0001-81',
      observacoes: null,
    });
  });
  it('layout B: CNPJ solto no endereço e cidade na linha após o bairro', () => {
    expect(por('MERCANTIL TESTE B')).toMatchObject({
      codigo_erp: '100002',
      razao_social: 'J R TESTE COMERCIAL',
      endereco: 'AVENIDA FICTICIA, Nº 1400',
      bairro: 'CENTRO',
      cidade: 'Luís Correia',
      cnpj: '07.965.850/0001-73',
      telefone: '(86) 9478-0002',
    });
  });
  it('layout C: nota antes da razão social, CPF colado, observação preenchida', () => {
    const c = por('CANTINHO TESTE');
    expect(c.codigo_erp).toBe('100003');
    expect(c.razao_social).toBe('Maria Fulana da Silva');
    expect(c.cnpj).toBeNull(); // era CPF: não vira CNPJ
    expect(c.celular).toBe('(86) 94222-0003');
    expect(c.telefone).toBeNull();
    expect(c.observacoes).toContain('MUDOU DE ENDEREÇO');
    expect(c.observacoes).toContain('histórico de atrasos');
  });
  it('texto livre e ponto sem descrição seguem sem erro', () => {
    expect(por('BAR DO ZÉ').codigo_erp).toBeNull();
    expect(por('BAR DO ZÉ').chave_externa).toMatch(/^kml:[0-9a-f]{14}$/);
    expect(parseDescricaoErp('só um texto qualquer').estruturado).toBe(false);
  });
});

describe('LGPD: nada de CPF/RG/e-mail/limite no resultado', () => {
  it('não vaza dado pessoal em nenhum campo', () => {
    const tudo = JSON.stringify(res);
    expect(tudo).not.toMatch(/123\.456\.789-09|12345678909/);
    expect(tudo).not.toMatch(/196097401|194602290/); // RG/IE
    expect(tudo).not.toMatch(/teste@example\.com/);
    expect(tudo).not.toMatch(/Limite/);
  });
  it('redigir mascara CPF e números longos em texto livre', () => {
    expect(redigir('doc 123.456.789-09 e 12345678909')).toBe('doc [CPF omitido] e [nº omitido]');
  });
});

describe('coordenadas suspeitas', () => {
  it('importa o cliente sem coordenada e guarda a original para correção', () => {
    expect(res.suspeitos.map((s) => s.nome).sort()).toEqual(['COMERCIAL COORDENADA ERRADA', 'MERCADINHO LONGE']);
    const longe = por('MERCADINHO LONGE');
    expect(longe.lat).toBeNull();
    expect(longe.lng).toBeNull();
    expect(longe.atributos.coordenada_original).toEqual([-29.12, -56.56]);
    expect(res.suspeitos.find((s) => s.nome === 'COMERCIAL COORDENADA ERRADA')!.motivo).toMatch(/km|igual/);
  });
  it('KML guarda lng,lat — não inverter', () => {
    expect(por('CHALANA TESTE')).toMatchObject({ lat: -2.905, lng: -41.776 });
  });
});

describe('segmento sugerido por palavras-chave', () => {
  it('classifica pelos nomes', () => {
    expect(por('CANTINHO TESTE').segmento).toBe('food_service');
    expect(por('BAR DO ZÉ').segmento).toBe('food_service');
    expect(por('PADARIA EXEMPLO').segmento).toBe('food_service');
    expect(por('MERCANTIL TESTE B').segmento).toBe('varejo');
    expect(por('CASA DE CARNES TESTE').segmento).toBe('varejo');
    expect(por('VANGUARDA SUPERMERCADOS - LOJA TESTE').segmento).toBe('rede');
    expect(por('CHALANA TESTE').segmento).toBe('outro');
  });
});

describe('chave estável', () => {
  it('é a mesma ao reler e independe de acento/caixa', () => {
    const outra = parseKml(xml, parser);
    expect(outra.itens.map((i) => i.chave_externa)).toEqual(res.itens.map((i) => i.chave_externa));
    expect(hash53('a')).toBe(hash53('a'));
    expect(hash53('a')).not.toBe(hash53('b'));
  });
});

describe('mapeamento de pastas', () => {
  const vendedores = detectarVendedores(res.pastas);
  const regras = sugerirRegras(res.pastas, vendedores);

  it('detecta os vendedores pelos nomes das pastas e une variações', () => {
    expect(vendedores).toEqual([
      { chave: 'joao-oliveira', nome: 'João Oliveira' },
      { chave: 'gislandio-silveira', nome: 'Gislandio Silveira' },
    ]);
  });
  it('VENDAS ATIVAS = ativo; demais: com ERP = inativo (resgate), sem ERP = em prospecção', () => {
    const itens = aplicarRegras(res.itens, regras);
    const g = (nome: string) => itens.find((i) => i.nome === nome)!;
    expect(g('SUPERMERCADO ATIVO 1')).toMatchObject({ status: 'ativo', tier: 'B', vendedor_chave: 'joao-oliveira' });
    expect(g('CHALANA TESTE')).toMatchObject({ status: 'inativo', tier: 'C', vendedor_chave: 'joao-oliveira' });
    expect(g('BAR DO ZÉ')).toMatchObject({ status: 'em_prospeccao', vendedor_chave: 'joao-oliveira' });
    // subpasta "Restaurante" dentro de "VENDAS ATIVAS GISLANDIO"
    expect(g('RESTAURANTE BOI TESTE')).toMatchObject({ status: 'ativo', vendedor_chave: 'gislandio-silveira' });
    expect(g('PADARIA EXEMPLO')).toMatchObject({ status: 'inativo', vendedor_chave: 'gislandio-silveira' });
  });
  it('pasta desmarcada não é importada', () => {
    const sem = regras.map((r) => (r.pasta.includes('GISLANDIO SILVEIRA') ? { ...r, importar: false } : r));
    expect(aplicarRegras(res.itens, sem).some((i) => i.nome === 'PADARIA EXEMPLO')).toBe(false);
  });
});

describe('arquivo', () => {
  it('lê KMZ (zip com doc.kml)', () => {
    const kmz = zipSync({ 'doc.kml': strToU8(xml), 'imagens/x.png': new Uint8Array([1, 2, 3]) });
    expect(parseKml(lerKmlDeBytes(kmz), parser).resumo.pontos).toBe(12);
  });
  it('lê KML puro', () => {
    expect(lerKmlDeBytes(strToU8(xml))).toContain('<kml');
  });
  it('recusa DOCTYPE/ENTITY e KMZ sem kml', () => {
    expect(() => parseKml('<?xml version="1.0"?><!DOCTYPE kml [<!ENTITY a "x">]><kml/>', parser)).toThrow(/DOCTYPE/);
    expect(() => lerKmlDeBytes(zipSync({ 'leia.txt': strToU8('nada') }))).toThrow(/sem arquivo/);
  });
  it('recusa arquivo que não é KML', () => {
    expect(() => parseKml('<html/>', parser)).toThrow(/KML/);
  });
});

describe('geometria', () => {
  it('ponto no polígono', () => {
    const q: [number, number][] = [[0, 0], [2, 0], [2, 2], [0, 2]];
    expect(pontoNoAnel(1, 1, q)).toBe(true);
    expect(pontoNoAnel(3, 1, q)).toBe(false);
  });
});
