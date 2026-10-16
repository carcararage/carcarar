import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { aplicarMapa, detectarLayout, lerRelatorioErp, lerTabela, paraItens } from './clientes';
import { lerCsv } from './csvLeitor';
import { lerXlsx } from './xlsx';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const letra = (i: number) => String.fromCharCode(65 + i);

/** Monta um .xlsx mínimo; `compartilhado` usa sharedStrings (como o Excel), senão inlineStr. */
function montarXlsx(linhas: (string | number)[][], compartilhado = true, extra = ''): Uint8Array {
  const ss: string[] = [];
  const idx = (s: string) => { let i = ss.indexOf(s); if (i < 0) { i = ss.length; ss.push(s); } return i; };
  const rows = linhas.map((l, r) => {
    const cels = l.map((v, c) => {
      const ref = `${letra(c)}${r + 1}`;
      if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
      if (v === '') return `<c r="${ref}" t="s"><v>${idx('')}</v></c>`;
      return compartilhado ? `<c r="${ref}" t="s"><v>${idx(v)}</v></c>` : `<c r="${ref}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    });
    return `<row r="${r + 1}">${cels.join('')}</row>`;
  });
  return zipSync({
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Page 1" sheetId="1" r:id="rId1"/><sheet name="Outra" sheetId="2" r:id="rId2"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<sst>${ss.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`),
    // estilo "quebrado" de propósito: bibliotecas completas falham aqui, o leitor mínimo ignora
    'xl/styles.xml': strToU8('<styleSheet><fills><fill><patternFill><fgColor rgb="ZZZ"/></patternFill></fill></fills></styleSheet>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData>${rows.join('')}${extra}</sheetData></worksheet>`),
    'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>só isto</t></is></c></row></sheetData></worksheet>'),
  });
}

describe('lerXlsx', () => {
  it('lê textos, números, células vazias e linhas puladas; ignora estilos inválidos', () => {
    for (const compartilhado of [true, false]) {
      const abas = lerXlsx(montarXlsx([['Nome', 'Fone'], [], ['Mercado A & B', 86999], ['', 'x']], compartilhado));
      expect(abas.map((a) => a.nome)).toEqual(['Page 1', 'Outra']);
      expect(abas[0].linhas[0]).toEqual(['Nome', 'Fone']);
      expect(abas[0].linhas[1]).toEqual([]); // linha vazia mantém a posição
      expect(abas[0].linhas[2]).toEqual(['Mercado A & B', '86999']);
      expect(abas[0].linhas[3]).toEqual(['', 'x']);
      expect(abas[1].linhas[0]).toEqual(['só isto']);
    }
  });
  it('recusa arquivo que não é xlsx', () => {
    expect(() => lerXlsx(zipSync({ 'a.txt': strToU8('oi') }))).toThrow(/xlsx/);
  });
});

describe('lerCsv', () => {
  it('detecta separador, aspas, vírgula e quebra de linha dentro de aspas, BOM', () => {
    expect(lerCsv('﻿Nome;Obs\r\n"A; B";"linha1\nlinha2"\r\n"diz ""oi""";x')).toEqual([
      ['Nome', 'Obs'], ['A; B', 'linha1\nlinha2'], ['diz "oi"', 'x'],
    ]);
    expect(lerCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

// relatório impresso do ERP: células mescladas repetem o valor
const rep = (...c: string[]) => c;
const bloco = (nome: string | null, end: string, cnpj: string) => [
  ...(nome ? [rep(nome, nome, nome, nome)] : []),
  rep('Endereço:', end, end, end, 'Bairro:', 'CENTRO', 'CENTRO'),
  rep('Cidade:', 'Parnaíba', 'UF:', 'PI', 'CEP:', '64.200-040', 'Telefone:', '(86) 3322-0001'),
  rep('Região:', 'Contato:', 'Celular:', '(86) 99999-0001'),
  rep('Classe:', 'Pessoa Jurídica', 'Email:', 'segredo@x.com'),
  rep('CPF/CNPJ:', cnpj, cnpj, 'RG/IE:', '123456789'),
  rep('Responsável:', 'Limite:', '0,00', '0,00'),
  rep('Observações:'),
  [],
];
const RELATORIO = [
  rep('Temperos Barão'), rep('Listagem de clientes'),
  ...bloco('EMPRESA UM LTDA 100001 Fantasia: MERCADO UM', 'RUA A, Nº 1', '11.222.333/0001-81'),
  ...bloco(null, 'RUA B, Nº 2', '22.333.444/0001-92'), // o ERP perdeu o nome deste
  rep('Folha 2 de 3'),
  ...bloco('FULANO DA SILVA 100003 Apelido: BAR DO ZE', 'RUA C, Nº 3', '123.456.789-09'), // CPF
];

describe('relatório impresso do ERP', () => {
  const linhas = lerXlsx(montarXlsx(RELATORIO.map((l) => [...l]), true))[0].linhas;
  it('reconhece o formato', () => {
    expect(detectarLayout(linhas)).toBe('relatorio-erp');
    expect(detectarLayout([['Nome', 'CNPJ'], ['a', 'b']])).toBe('tabela');
  });
  it('separa os blocos, acha nome/código e conta quem veio sem nome', () => {
    const r = lerRelatorioErp(linhas);
    expect(r.blocos).toBe(3);
    expect(r.semNome).toBe(1);
    expect(r.linhas[0]).toMatchObject({ codigoErp: '100001', nome: 'MERCADO UM', razaoSocial: 'EMPRESA UM LTDA', endereco: 'RUA A, Nº 1', bairro: 'CENTRO', cidade: 'Parnaíba', uf: 'PI', cnpj: '11.222.333/0001-81', telefone: '(86) 3322-0001', celular: '(86) 99999-0001' });
    expect(r.linhas[1].nome).toBeUndefined();
    expect(r.linhas[2]).toMatchObject({ codigoErp: '100003', nome: 'BAR DO ZE' });
  });
  it('LGPD: CPF, RG, e-mail e limite nunca viram dado', () => {
    const r = lerRelatorioErp(linhas);
    const tudo = JSON.stringify(r) + JSON.stringify(paraItens(r.linhas, { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null }));
    expect(tudo).not.toMatch(/123\.456\.789-09|123456789|segredo@x\.com|Limite/);
  });
  it('sem nome não é importado (a menos que se peça nome provisório)', () => {
    const r = lerRelatorioErp(linhas);
    const a = paraItens(r.linhas, { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null });
    expect(a.itens.map((i) => i.nome)).toEqual(['MERCADO UM', 'BAR DO ZE']);
    expect(a.semNome).toBe(1);
    const b = paraItens(r.linhas, { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null, incluirSemNome: true });
    expect(b.itens).toHaveLength(3);
    expect(b.itens[1].nome).toBe('Sem nome · RUA B, Nº 2');
    expect(b.itens[1].chave_externa).toBe('cnpj:22333444000192');
  });
  it('chaves estáveis: código do ERP, depois CNPJ; planilha nunca apaga localização', () => {
    const a = paraItens(lerRelatorioErp(linhas).linhas, { statusPadrao: 'inativo', tierPadrao: 'B', vendedorPadrao: 'joao', incluirSemNome: true });
    expect(a.itens[0]).toMatchObject({ chave_externa: 'erp:100001', lat: null, lng: null, status: 'inativo', tier: 'B', vendedor_chave: 'joao', cnpj: '11.222.333/0001-81' });
    expect(a.itens.every((i) => i.atributos.fonte_planilha === true)).toBe(true);
    expect(a.itens[2].cnpj).toBeNull(); // era CPF
  });
});

describe('tabela simples (CSV/Excel comum)', () => {
  const csv = lerCsv('Código;Nome Fantasia;CNPJ/CPF;Endereço;Bairro;Município;UF;Celular;Vendedor;Situação\n' +
    '101;Padaria Boa;11.222.333/0001-81;Rua X, 1;Centro;Parnaíba;PI;(86) 98888-7777;João Oliveira;Ativo\n' +
    '102;Mercado Sem Vendedor;123.456.789-09;Rua Y, 2;Pindorama;Parnaíba;PI;;Fulano Desconhecido;Inativo\n' +
    '101;Padaria Boa (repetida);;;;;;;;');
  it('acha o cabeçalho e sugere as colunas por sinônimos', () => {
    const t = lerTabela(csv);
    expect(t.mapa).toMatchObject({ codigoErp: 0, nome: 1, cnpj: 2, endereco: 3, bairro: 4, cidade: 5, uf: 6, celular: 7, vendedor: 8, status: 9 });
    expect(t.dados).toHaveLength(3);
  });
  it('gera itens com vendedor, status, dedupe e CPF descartado', () => {
    const t = lerTabela(csv);
    const r = paraItens(aplicarMapa(t.dados, t.mapa), {
      statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null,
      resolverVendedor: (n) => (n === 'João Oliveira' ? 'joao-oliveira' : null),
    });
    expect(r.itens).toHaveLength(2);
    expect(r.duplicadosNoArquivo).toBe(1);
    expect(r.cpfDescartados).toBe(1);
    expect(r.vendedoresNaoReconhecidos).toEqual(['Fulano Desconhecido']);
    expect(r.itens[0]).toMatchObject({ chave_externa: 'erp:101', status: 'ativo', vendedor_chave: 'joao-oliveira', celular: '(86) 98888-7777', cidade: 'Parnaíba', segmento: 'food_service' });
    expect(r.itens[1]).toMatchObject({ status: 'inativo', vendedor_chave: null, cnpj: null });
  });
  it('permite mapear manualmente colunas que não foram reconhecidas', () => {
    const t = lerTabela([['Coluna1', 'Coluna2'], ['Loja X', 'Rua Z']]);
    expect(t.mapa).toEqual({});
    const linhas = aplicarMapa(t.dados, { nome: 0, endereco: 1 });
    expect(linhas).toEqual([{ nome: 'Loja X', endereco: 'Rua Z' }]);
  });
});
