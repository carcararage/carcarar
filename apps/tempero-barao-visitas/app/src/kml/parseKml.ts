import {
  areaAnel,
  type Coord,
  coordValida,
  distanciaKm,
  hash53,
  mediana,
  normaliza,
  parseCoords,
  pontoNoAnel,
} from './geo';
import { parseDescricaoErp, redigir, textoLimpo } from './erp';
import { inferirSegmento, type Segmento } from './segmento';

export type Status = 'prospecto' | 'em_prospeccao' | 'ativo' | 'inativo' | 'perdido';
export type Tier = 'A' | 'B' | 'C';

export interface ItemImportado {
  chave_externa: string;
  nome: string;
  lat: number | null;
  lng: number | null;
  endereco: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  cep: string | null;
  telefone: string | null;
  celular: string | null;
  contato: string | null;
  codigo_erp: string | null;
  razao_social: string | null;
  cnpj: string | null;
  observacoes: string | null;
  categoria: string | null;
  grupo_origem: string | null;
  regiao: string | null;
  segmento: Segmento;
  atributos: Record<string, unknown>;
  // definidos pelo mapeamento de pastas (ver mapeamento.ts)
  status?: Status;
  tier?: Tier;
  vendedor_chave?: string | null;
}

export interface RegiaoImportada {
  nome: string;
  poligono: Coord[];
  atributos: Record<string, unknown>;
}

export interface Suspeito {
  nome: string;
  pasta: string;
  lat: number;
  lng: number;
  motivo: string;
}

export interface PastaResumo {
  chave: string; // grupo_origem completo
  rotulo: string; // últimos níveis, para exibir
  total: number;
  comCodigoErp: number;
}

export interface Resumo {
  placemarks: number;
  pontos: number;
  comCodigoErp: number;
  comRegiao: number;
  duplicadosNoArquivo: number;
  rotulosRegiao: number;
  linhasIgnoradas: number;
  semGeometria: number;
  coordenadasSuspeitas: number;
  regioes: number;
  porSegmento: Record<Segmento, number>;
}

export interface ResultadoKml {
  itens: ItemImportado[];
  regioes: RegiaoImportada[];
  suspeitos: Suspeito[];
  pastas: PastaResumo[];
  resumo: Resumo;
}

export interface ParserDom {
  parseFromString(xml: string, tipo: string): Document;
}

// ---------------------------------------------------------------------------------------------

const filhos = (el: Element): Element[] =>
  Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1);
const tag = (el: Element) => el.localName ?? el.nodeName.split(':').pop()!;
const filho = (el: Element, nome: string) => filhos(el).find((c) => tag(c) === nome);
const txt = (el: Element | undefined | null) => (el?.textContent ?? '').trim();

function descendentes(el: Element, nomes: Set<string>, acc: Element[] = []): Element[] {
  for (const c of filhos(el)) {
    if (nomes.has(tag(c))) acc.push(c);
    descendentes(c, nomes, acc);
  }
  return acc;
}

interface Pm {
  pasta: string[];
  el: Element;
}

function coletarPlacemarks(no: Element, pasta: string[], acc: Pm[]) {
  for (const c of filhos(no)) {
    const t = tag(c);
    if (t === 'Document' || t === 'Folder') {
      const nome = txt(filho(c, 'name'));
      coletarPlacemarks(c, t === 'Folder' && nome ? [...pasta, nome] : pasta, acc);
    } else if (t === 'Placemark') {
      acc.push({ pasta, el: c });
    }
  }
}

function dadosEstendidos(pm: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of descendentes(pm, new Set(['Data', 'SimpleData']))) {
    const nome = d.getAttribute('name');
    const valor = tag(d) === 'Data' ? txt(filho(d, 'value')) : txt(d);
    if (nome && valor) out[nome.trim()] = valor;
  }
  return out;
}

const CAMPOS_ESTENDIDOS: Record<string, string[]> = {
  telefone: ['telefone', 'fone', 'phone', 'tel'],
  celular: ['celular', 'whatsapp'],
  endereco: ['endereco', 'address', 'logradouro', 'rua'],
  bairro: ['bairro', 'neighborhood'],
  cidade: ['cidade', 'city', 'municipio'],
  uf: ['uf', 'estado', 'state'],
};

/** Rótulos de bairro com valores (ex.: "RESTAURANTE - 256,21", "COMERCIO R$ 931,30"): não são estabelecimentos. */
const RE_ROTULO_AGREGADO = /R\$\s*[\d.,]+|\b\d+[.,]\d{2}\s*$|\b\d{1,3}(?:\.\d{3})*,\d{2}\b/;

const ultimos = (pasta: string[], n = 2) => pasta.slice(-n).join(' / ');

export function parseKml(xml: string, parser: ParserDom): ResultadoKml {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml.slice(0, 4096))) {
    throw new Error('KML com DOCTYPE/ENTITY recusado por segurança');
  }
  const doc = parser.parseFromString(xml, 'text/xml');
  const raiz = doc.documentElement;
  if (!raiz || tag(raiz) !== 'kml') throw new Error('Arquivo não parece um KML válido');

  const pms: Pm[] = [];
  coletarPlacemarks(raiz, [], pms);

  const resumo: Resumo = {
    placemarks: pms.length,
    pontos: 0,
    comCodigoErp: 0,
    comRegiao: 0,
    duplicadosNoArquivo: 0,
    rotulosRegiao: 0,
    linhasIgnoradas: 0,
    semGeometria: 0,
    coordenadasSuspeitas: 0,
    regioes: 0,
    porSegmento: { food_service: 0, varejo: 0, rede: 0, outro: 0 },
  };

  const GEOMS = new Set(['Point', 'Polygon', 'LineString']);
  type Geom = { tipo: string; el: Element };
  const geomDe = (pm: Element): Geom | null => {
    const g = descendentes(pm, GEOMS)[0];
    return g ? { tipo: tag(g), el: g } : null;
  };

  // ---- 1) regiões (polígonos) ------------------------------------------------------------
  const regioes: RegiaoImportada[] = [];
  const nomesUsados = new Map<string, number>();
  const nomeUnico = (base: string) => {
    const n = (nomesUsados.get(base) ?? 0) + 1;
    nomesUsados.set(base, n);
    return n === 1 ? base : `${base} (${n})`;
  };

  for (const { pasta, el } of pms) {
    const g = geomDe(el);
    if (g?.tipo !== 'Polygon') continue;
    const coords = descendentes(g.el, new Set(['coordinates']))[0];
    const anel = parseCoords(coords?.textContent);
    if (anel.length < 3) continue;
    const base = txt(filho(el, 'name')) || pasta[pasta.length - 1] || 'Região';
    const reg: RegiaoImportada = { nome: nomeUnico(base), poligono: anel, atributos: {} };
    regioes.push(reg);
  }
  const regioesPorArea = [...regioes].sort((a, b) => areaAnel(a.poligono) - areaAnel(b.poligono));
  const regiaoQueContem = (lng: number, lat: number) =>
    regioesPorArea.find((r) => pontoNoAnel(lng, lat, r.poligono));

  // ---- 2) pontos --------------------------------------------------------------------------
  const itens: ItemImportado[] = [];
  const vistos = new Set<string>();
  const brutos: { item: ItemImportado; lat: number; lng: number; pasta: string }[] = [];

  for (const { pasta, el } of pms) {
    const g = geomDe(el);
    if (!g) {
      resumo.semGeometria++;
      continue;
    }
    if (g.tipo === 'LineString') {
      resumo.linhasIgnoradas++;
      continue;
    }
    if (g.tipo === 'Polygon') continue;

    const chavePasta = pasta.join(' / ');
    const nomePm = txt(filho(el, 'name'));

    const c = parseCoords(descendentes(g.el, new Set(['coordinates']))[0]?.textContent)[0];
    if (!c) {
      resumo.semGeometria++;
      continue;
    }
    const [lng, lat] = c;

    // Rótulo de valores dentro de um bairro (ex.: "RESTAURANTE - 256,21"): não é estabelecimento,
    // vira anotação da região que o contém.
    if (nomePm && RE_ROTULO_AGREGADO.test(nomePm) && coordValida(lng, lat)) {
      const reg = regiaoQueContem(lng, lat);
      if (reg) {
        const lista = (reg.atributos.rotulos_vendas as string[] | undefined) ?? [];
        lista.push(nomePm);
        reg.atributos.rotulos_vendas = lista;
        resumo.rotulosRegiao++;
        continue;
      }
    }

    const descricao = textoLimpo(txt(filho(el, 'description')));
    const erp = parseDescricaoErp(descricao);
    const est = dadosEstendidos(el);
    const doEstendido = (campo: string) => {
      const apelidos = CAMPOS_ESTENDIDOS[campo];
      const k = Object.keys(est).find((x) => apelidos.includes(normaliza(x)));
      return k ? est[k] : undefined;
    };

    const nome =
      nomePm || erp.fantasia || erp.razaoSocial || `Sem nome (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
    const chave = erp.codigo
      ? `erp:${erp.codigo}`
      : `kml:${hash53(`${normaliza(nome)}|${lat.toFixed(5)}|${lng.toFixed(5)}`)}`;
    if (vistos.has(chave)) {
      resumo.duplicadosNoArquivo++;
      continue;
    }
    vistos.add(chave);

    const atributos: Record<string, unknown> = {};
    const usados = new Set(
      Object.keys(est).filter((k) =>
        Object.values(CAMPOS_ESTENDIDOS).some((ap) => ap.includes(normaliza(k))),
      ),
    );
    for (const [k, v] of Object.entries(est)) if (!usados.has(k)) atributos[k] = v;

    let observacoes = erp.observacoes ?? null;
    if (!erp.estruturado && descricao) {
      // texto livre: guarda, mas sem CPF/RG
      observacoes = redigir(descricao);
    }

    const item: ItemImportado = {
      chave_externa: chave,
      nome,
      lat,
      lng,
      endereco: erp.endereco ?? doEstendido('endereco') ?? null,
      bairro: erp.bairro ?? doEstendido('bairro') ?? null,
      cidade: erp.cidade ?? doEstendido('cidade') ?? null,
      uf: erp.uf ?? doEstendido('uf') ?? null,
      cep: erp.cep ?? null,
      telefone: erp.telefone ?? doEstendido('telefone') ?? null,
      celular: erp.celular ?? doEstendido('celular') ?? null,
      contato: erp.contato ?? null,
      codigo_erp: erp.codigo ?? null,
      razao_social: erp.razaoSocial ?? null,
      cnpj: erp.cnpj ?? null,
      observacoes,
      categoria: pasta.length ? pasta[pasta.length - 1] : null,
      grupo_origem: pasta.length ? chavePasta : null,
      regiao: null,
      segmento: 'outro',
      atributos,
    };
    item.segmento = inferirSegmento(nome, item.categoria);
    brutos.push({ item, lat, lng, pasta: chavePasta });
    itens.push(item);
  }

  // ---- 3) coordenadas suspeitas ----------------------------------------------------------
  const suspeitos: Suspeito[] = [];
  const validos = brutos.filter((b) => coordValida(b.lng, b.lat));
  const medLat = validos.length ? mediana(validos.map((b) => b.lat)) : 0;
  const medLng = validos.length ? mediana(validos.map((b) => b.lng)) : 0;
  for (const b of brutos) {
    let motivo: string | null = null;
    if (!coordValida(b.lng, b.lat)) motivo = 'coordenada fora do intervalo válido';
    else if (validos.length >= 10) {
      const km = distanciaKm(medLat, medLng, b.lat, b.lng);
      if (km > 250) motivo = `a ${Math.round(km)} km do centro dos demais pontos`;
      else if (Math.abs(b.lat - b.lng) < 1e-9) motivo = 'latitude igual à longitude (provável digitação)';
    }
    if (motivo) {
      suspeitos.push({ nome: b.item.nome, pasta: b.pasta, lat: b.lat, lng: b.lng, motivo });
      b.item.atributos.coordenada_original = [b.lat, b.lng];
      b.item.atributos.coordenada_suspeita = motivo;
      b.item.lat = null;
      b.item.lng = null;
    }
  }
  resumo.coordenadasSuspeitas = suspeitos.length;

  // ---- 4) região de cada ponto: a MENOR que o contém ------------------------------------------
  for (const it of itens) {
    if (it.lat == null || it.lng == null) continue;
    const r = regiaoQueContem(it.lng, it.lat);
    if (r) {
      it.regiao = r.nome;
      resumo.comRegiao++;
    }
  }

  // ---- 5) resumos -------------------------------------------------------------------------
  const porPasta = new Map<string, PastaResumo>();
  for (const it of itens) {
    const k = it.grupo_origem ?? '(sem pasta)';
    const p =
      porPasta.get(k) ??
      { chave: k, rotulo: ultimos(k.split(' / ')), total: 0, comCodigoErp: 0 };
    p.total++;
    if (it.codigo_erp) p.comCodigoErp++;
    porPasta.set(k, p);
    resumo.porSegmento[it.segmento]++;
    if (it.codigo_erp) resumo.comCodigoErp++;
  }
  resumo.pontos = itens.length;
  resumo.regioes = regioes.length;

  return {
    itens,
    regioes,
    suspeitos,
    pastas: [...porPasta.values()].sort((a, b) => b.total - a.total),
    resumo,
  };
}
