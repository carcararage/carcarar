import { normaliza } from './geo';
import type { ItemImportado, PastaResumo, Status, Tier } from './parseKml';

/**
 * O mapa da Barão é organizado por pastas: uma "VENDAS ATIVAS <vendedor>" e uma pasta com a
 * rota/carteira de cada vendedor. Este módulo SUGERE o que cada pasta significa; a gestão
 * confirma na tela de importação antes de gravar.
 */

export interface Vendedor {
  chave: string; // ex.: 'joao-oliveira' (ligada a perfis.chave_import)
  nome: string; // ex.: 'João Oliveira'
}

export interface RegraPasta {
  pasta: string; // grupo_origem completo
  importar: boolean;
  statusComCodigoErp: Status; // tem cadastro no ERP (já foi/é cliente)
  statusSemCodigoErp: Status; // só pino no mapa
  tier: Tier;
  vendedorChave: string | null;
}

const SEGMENTOS_IGNORADOS = new Set(['lugares temporarios', 'vendas', 'bairro', 'bairros']);
const RE_ATIVAS = /^vendas ativas\s*(.*)$/;

const semKml = (s: string) => s.replace(/\.kml$/i, '').trim();
const titulo = (s: string) =>
  s
    .toLowerCase()
    .split(' ')
    .map((p) => (['de', 'da', 'do', 'dos', 'das'].includes(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ');

export const slug = (s: string) =>
  normaliza(s)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const tokens = (s: string) => normaliza(s).split(' ').filter(Boolean);

/** a lista menor é prefixo da maior? ("gislandio" ⊂ "gislandio silveira") */
function mesmaPessoa(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  const [c, l] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return c.length > 0 && c.every((t, i) => l[i] === t);
}

/** Nomes de pessoa que aparecem como nome de pasta (X.kml / X) ou "VENDAS ATIVAS X". */
export function detectarVendedores(pastas: PastaResumo[]): Vendedor[] {
  const candidatos: string[] = [];
  for (const p of pastas) {
    const segs = p.chave.split(' / ');
    segs.forEach((seg, i) => {
      const base = normaliza(semKml(seg));
      const ativas = base.match(RE_ATIVAS);
      const nome = ativas ? ativas[1] : base;
      if (!nome || SEGMENTOS_IGNORADOS.has(nome)) return;
      const repetido = i > 0 && normaliza(semKml(segs[i - 1])) === base; // "X.kml / X"
      const ehKml = /\.kml$/i.test(seg);
      if (ativas || repetido || ehKml) {
        const original = semKml(seg).replace(/^vendas ativas\s*/i, '');
        if (original && !SEGMENTOS_IGNORADOS.has(normaliza(original))) candidatos.push(original);
      }
    });
  }
  // une variações da mesma pessoa, preferindo o nome mais completo
  const grupos: string[] = [];
  for (const c of candidatos) {
    const i = grupos.findIndex((g) => mesmaPessoa(g, c));
    if (i === -1) grupos.push(c);
    else if (tokens(c).length > tokens(grupos[i]).length) grupos[i] = c;
  }
  return grupos.map((g) => ({ chave: slug(g), nome: titulo(g) }));
}

export function sugerirRegras(pastas: PastaResumo[], vendedores: Vendedor[]): RegraPasta[] {
  return pastas.map((p) => {
    const segs = p.chave.split(' / ');
    const ativa = segs.some((s) => RE_ATIVAS.test(normaliza(semKml(s))));
    const dono =
      vendedores.find((v) =>
        segs.some((s) => {
          const n = normaliza(semKml(s)).replace(/^vendas ativas\s*/, '');
          return n && mesmaPessoa(n, v.nome);
        }),
      ) ?? null;
    return {
      pasta: p.chave,
      importar: true,
      // "VENDAS ATIVAS" = clientes que compram. As demais pastas de rota: com cadastro no ERP e
      // sem venda ativa = cliente parado (resgate); sem cadastro = ponto em prospecção.
      statusComCodigoErp: ativa ? 'ativo' : 'inativo',
      statusSemCodigoErp: ativa ? 'ativo' : dono ? 'em_prospeccao' : 'prospecto',
      tier: ativa ? 'B' : 'C',
      vendedorChave: dono?.chave ?? null,
    };
  });
}

export function aplicarRegras(itens: ItemImportado[], regras: RegraPasta[]): ItemImportado[] {
  const porPasta = new Map(regras.map((r) => [r.pasta, r]));
  const out: ItemImportado[] = [];
  for (const it of itens) {
    const r = porPasta.get(it.grupo_origem ?? '(sem pasta)');
    if (!r || !r.importar) continue;
    out.push({
      ...it,
      status: it.codigo_erp ? r.statusComCodigoErp : r.statusSemCodigoErp,
      tier: r.tier,
      vendedor_chave: r.vendedorChave,
    });
  }
  return out;
}
