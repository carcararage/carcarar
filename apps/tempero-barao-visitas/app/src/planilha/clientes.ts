import { parseDescricaoErp, telefoneValido } from '../kml/erp';
import { hash53, normaliza } from '../kml/geo';
import type { ItemImportado, Status, Tier } from '../kml/parseKml';
import { inferirSegmento, type Segmento } from '../kml/segmento';

/**
 * Planilha de clientes -> itens para importar_estabelecimentos().
 * Dois formatos:
 *  - "relatorio-erp": a listagem impressa do ERP (um bloco por cliente, células mescladas);
 *  - "tabela": uma linha por cliente com cabeçalho (CSV/Excel comum), com mapeamento de colunas.
 * LGPD: CPF (11 dígitos), RG, e-mail e limite de crédito nunca entram; só CNPJ (14 dígitos).
 */

export type Campo =
  | 'codigoErp' | 'razaoSocial' | 'nome' | 'cnpj' | 'endereco' | 'bairro' | 'cidade' | 'uf' | 'cep'
  | 'telefone' | 'celular' | 'contato' | 'observacoes' | 'vendedor' | 'status' | 'segmento' | 'tier';

export type LinhaCliente = Partial<Record<Campo, string>>;
export type Layout = 'relatorio-erp' | 'tabela';

export const ROTULO_CAMPO: Record<Campo, string> = {
  codigoErp: 'Código do cliente (ERP)', razaoSocial: 'Razão social', nome: 'Nome / fantasia', cnpj: 'CNPJ', endereco: 'Endereço',
  bairro: 'Bairro', cidade: 'Cidade', uf: 'UF', cep: 'CEP', telefone: 'Telefone', celular: 'Celular / WhatsApp',
  contato: 'Pessoa de contato', observacoes: 'Observações', vendedor: 'Vendedor', status: 'Status', segmento: 'Segmento', tier: 'Classe (A/B/C)',
};

const SINONIMOS: Record<Campo, string[]> = {
  codigoErp: ['codigo', 'cod', 'cod cliente', 'codigo cliente', 'codigo do cliente', 'cod erp', 'codigo erp', 'id cliente', 'id'],
  razaoSocial: ['razao social', 'razao', 'nome empresarial'],
  nome: ['nome', 'fantasia', 'nome fantasia', 'cliente', 'nome do cliente', 'estabelecimento', 'apelido', 'nome cliente'],
  cnpj: ['cnpj', 'cpf cnpj', 'cnpj cpf', 'cnpj/cpf', 'cpf/cnpj'],
  endereco: ['endereco', 'logradouro', 'rua', 'endereco completo'],
  bairro: ['bairro'],
  cidade: ['cidade', 'municipio'],
  uf: ['uf', 'estado'],
  cep: ['cep'],
  telefone: ['telefone', 'fone', 'tel', 'telefone fixo'],
  celular: ['celular', 'whatsapp', 'cel', 'telefone celular'],
  contato: ['contato', 'responsavel', 'comprador'],
  observacoes: ['observacoes', 'observacao', 'obs'],
  vendedor: ['vendedor', 'representante', 'rca'],
  status: ['status', 'situacao'],
  segmento: ['segmento', 'categoria', 'ramo', 'ramo de atividade'],
  tier: ['classe', 'classificacao', 'curva', 'abc'],
};

const chave = (h: string) => normaliza(h).replace(/[^a-z0-9]+/g, ' ').trim();
const CAMPOS = Object.keys(SINONIMOS) as Campo[];

// ---------------------------------------------------------------------------------------------
// Detecção de formato
// ---------------------------------------------------------------------------------------------

/** Cada linha da planilha vira um texto; células mescladas repetem o valor, então juntamos só as diferentes. */
export function linhasComoTexto(linhas: string[][]): string[] {
  return linhas.map((cels) => {
    const out: string[] = [];
    for (const c of cels) {
      const v = (c ?? '').trim();
      if (v && out[out.length - 1] !== v) out.push(v);
    }
    return out.join(' ');
  });
}

export function detectarLayout(linhas: string[][]): Layout {
  const textos = linhasComoTexto(linhas.slice(0, 400));
  return textos.filter((t) => t.startsWith('Endereço:')).length >= 3 ? 'relatorio-erp' : 'tabela';
}

// ---------------------------------------------------------------------------------------------
// Relatório impresso do ERP
// ---------------------------------------------------------------------------------------------

const RE_ROTULO = /^(Endereço|Bairro|Cidade|UF|CEP|Telefone|Região|Contato|Celular|Classe|Email|CPF\/CNPJ|RG\/IE|Responsável|Limite|Observações|Fantasia|Apelido)\s*:/;
const RE_CODIGO = /(?<![\d.\-/])\d{6}(?![\d.\-/])/;

export interface LeituraRelatorio {
  linhas: LinhaCliente[];
  blocos: number;
  /** blocos em que o ERP não exportou nem o nome nem o código */
  semNome: number;
}

export function lerRelatorioErp(linhas: string[][]): LeituraRelatorio {
  const L = linhasComoTexto(linhas);
  const inicios: number[] = []; // índice de cada "Endereço:"
  L.forEach((t, i) => t.startsWith('Endereço:') && inicios.push(i));

  // a linha de nome/código, quando existe, é a não-vazia imediatamente acima do "Endereço:"
  const cabeca = inicios.map((i) => {
    for (let k = i - 1; k >= 0 && k >= i - 3; k--) {
      if (!L[k]) continue;
      return !RE_ROTULO.test(L[k]) && RE_CODIGO.test(L[k]) ? k : -1;
    }
    return -1;
  });

  const out: LinhaCliente[] = [];
  let semNome = 0;
  inicios.forEach((ini, n) => {
    const proximo = n + 1 < inicios.length ? (cabeca[n + 1] >= 0 ? cabeca[n + 1] : inicios[n + 1]) : L.length;
    const corpo = L.slice(ini, proximo).filter((t) => t && !/^Folha \d+ de \d+$/i.test(t));
    const texto = (cabeca[n] >= 0 ? L[cabeca[n]] + '\n' : '') + corpo.join('\n');
    const d = parseDescricaoErp(texto);
    if (!d.codigo && !d.fantasia && !d.razaoSocial) semNome++;
    out.push({
      codigoErp: d.codigo, razaoSocial: d.razaoSocial, nome: d.fantasia ?? d.razaoSocial, cnpj: d.cnpj, endereco: d.endereco,
      bairro: d.bairro, cidade: d.cidade, uf: d.uf, cep: d.cep, telefone: d.telefone, celular: d.celular, contato: d.contato,
      observacoes: d.observacoes,
    });
  });
  return { linhas: out, blocos: inicios.length, semNome };
}

// ---------------------------------------------------------------------------------------------
// Tabela simples
// ---------------------------------------------------------------------------------------------

export type MapaColunas = Partial<Record<Campo, number>>;

export interface LeituraTabela {
  cabecalho: string[];
  mapa: MapaColunas;
  dados: string[][];
}

/** Acha o cabeçalho (a linha que mais parece um) e sugere qual coluna é cada campo. */
export function lerTabela(linhas: string[][]): LeituraTabela {
  let melhor = { i: 0, mapa: {} as MapaColunas, n: -1 };
  for (let i = 0; i < Math.min(linhas.length, 15); i++) {
    const mapa: MapaColunas = {};
    linhas[i].forEach((h, col) => {
      const k = chave(h ?? '');
      const campo = CAMPOS.find((c) => mapa[c] === undefined && SINONIMOS[c].includes(k));
      if (campo) mapa[campo] = col;
    });
    const n = Object.keys(mapa).length;
    if (n > melhor.n) melhor = { i, mapa, n };
  }
  return { cabecalho: linhas[melhor.i] ?? [], mapa: melhor.mapa, dados: linhas.slice(melhor.i + 1).filter((l) => l.some((c) => (c ?? '').trim())) };
}

export function aplicarMapa(dados: string[][], mapa: MapaColunas): LinhaCliente[] {
  return dados.map((l) => {
    const o: LinhaCliente = {};
    for (const c of CAMPOS) {
      const col = mapa[c];
      const v = col === undefined ? '' : (l[col] ?? '').trim();
      if (v) o[c] = v;
    }
    return o;
  });
}

// ---------------------------------------------------------------------------------------------
// Linhas -> itens
// ---------------------------------------------------------------------------------------------

export interface OpcoesItens {
  statusPadrao: Status;
  tierPadrao: Tier;
  /** chave do vendedor (perfis.chave_import) aplicada a quem vier sem vendedor na planilha */
  vendedorPadrao: string | null;
  /** converte o texto da coluna "vendedor" em chave de vendedor (null = não reconhecido) */
  resolverVendedor?: (nome: string) => string | null;
  /** cria o cliente sem nome, usando o endereço como nome provisório */
  incluirSemNome?: boolean;
}

export interface ResultadoItens {
  itens: ItemImportado[];
  semNome: number;
  duplicadosNoArquivo: number;
  cpfDescartados: number;
  vendedoresNaoReconhecidos: string[];
}

const STATUS_TEXTO: [RegExp, Status][] = [[/inativ|bloquead|parad/, 'inativo'], [/ativ/, 'ativo'], [/prospect|potencial/, 'prospecto'], [/perdid/, 'perdido']];
const SEG_TEXTO: Segmento[] = ['food_service', 'varejo', 'rede', 'outro'];

function formatarCnpj(d: string) {
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

export function paraItens(linhas: LinhaCliente[], o: OpcoesItens): ResultadoItens {
  const itens: ItemImportado[] = [];
  const vistos = new Set<string>();
  const naoReconhecidos = new Set<string>();
  let semNome = 0;
  let duplicados = 0;
  let cpf = 0;

  for (const l of linhas) {
    const digitos = (l.cnpj ?? '').replace(/\D/g, '');
    let cnpj: string | null = null;
    if (digitos.length === 14) cnpj = formatarCnpj(digitos);
    else if (digitos.length === 11) cpf++; // CPF de pessoa física: descartado

    let nome = l.nome ?? l.razaoSocial ?? '';
    if (!nome) {
      if (!o.incluirSemNome) { semNome++; continue; }
      nome = `Sem nome · ${l.endereco ?? l.cidade ?? 'cliente'}`;
    }
    const codigo = (l.codigoErp ?? '').replace(/\D/g, '') || null;
    const ch = codigo ? `erp:${codigo}` : cnpj ? `cnpj:${digitos}` : `plan:${hash53(`${normaliza(nome)}|${normaliza(l.endereco ?? '')}`)}`;
    if (vistos.has(ch)) { duplicados++; continue; }
    vistos.add(ch);

    let vendedor = o.vendedorPadrao;
    if (l.vendedor) {
      const r = o.resolverVendedor?.(l.vendedor) ?? null;
      if (r) vendedor = r; else naoReconhecidos.add(l.vendedor);
    }
    const st = l.status ? STATUS_TEXTO.find(([re]) => re.test(normaliza(l.status!)))?.[1] : undefined;
    const tier = (['A', 'B', 'C'] as const).find((t) => t === l.tier?.trim().toUpperCase()) ?? o.tierPadrao;
    const seg = SEG_TEXTO.find((s) => s === l.segmento?.trim().toLowerCase().replace(' ', '_')) ?? inferirSegmento(nome, null);

    itens.push({
      chave_externa: ch, nome, lat: null, lng: null,
      endereco: l.endereco ?? null, bairro: l.bairro ?? null, cidade: l.cidade ?? null, uf: l.uf ?? null, cep: l.cep ?? null,
      telefone: telefoneValido(l.telefone) ?? null, celular: telefoneValido(l.celular) ?? null, contato: l.contato ?? null,
      codigo_erp: codigo, razao_social: l.razaoSocial ?? null, cnpj, observacoes: l.observacoes ?? null,
      categoria: 'Planilha de clientes', grupo_origem: 'Planilha de clientes', regiao: null, segmento: seg,
      atributos: { fonte_planilha: true },
      status: st ?? o.statusPadrao, tier, vendedor_chave: vendedor,
    });
  }
  return { itens, semNome, duplicadosNoArquivo: duplicados, cpfDescartados: cpf, vendedoresNaoReconhecidos: [...naoReconhecidos] };
}
