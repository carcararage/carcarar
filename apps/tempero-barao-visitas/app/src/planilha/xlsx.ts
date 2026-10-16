import { unzipSync } from 'fflate';

/**
 * Leitor mínimo de XLSX: lê só o texto das células (zip + sharedStrings + folha), ignorando estilos.
 * Exportações de ERP costumam ter estilos fora do padrão que derrubam bibliotecas completas
 * (aconteceu com a "Listagem de Clientes" da Barão no openpyxl) — e aqui estilo não importa.
 */

const LIMITE = 150 * 1024 * 1024;

const ENTIDADES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodificar = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : '';
    }
    return ENTIDADES[e.toLowerCase()] ?? '';
  });

const textoDosT = (xml: string) => {
  let out = '';
  for (const m of xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += decodificar(m[1]);
  return out;
};

/** "AB12" -> índice 27 (0-based) */
const colunaDe = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/[^A-Z]/gi, '').toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

export interface Aba {
  nome: string;
  linhas: string[][];
}

export function lerXlsx(bytes: Uint8Array): Aba[] {
  if (bytes.length > LIMITE) throw new Error('Planilha grande demais');
  const dec = new TextDecoder('utf-8');
  const z = unzipSync(bytes, {
    filter: (f) =>
      f.originalSize <= LIMITE &&
      (f.name === 'xl/workbook.xml' || f.name === 'xl/sharedStrings.xml' || f.name === 'xl/_rels/workbook.xml.rels' || /^xl\/worksheets\/[^/]+\.xml$/.test(f.name)),
  });
  if (!z['xl/workbook.xml']) throw new Error('Arquivo não parece uma planilha .xlsx');

  const compartilhadas: string[] = [];
  if (z['xl/sharedStrings.xml']) {
    for (const m of dec.decode(z['xl/sharedStrings.xml']).matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>|<si\s*\/>/g)) {
      compartilhadas.push(m[1] ? textoDosT(m[1]) : '');
    }
  }

  // nome da aba -> arquivo (via relações); se algo faltar, cai na ordem dos arquivos
  const wb = dec.decode(z['xl/workbook.xml']);
  const rels = z['xl/_rels/workbook.xml.rels'] ? dec.decode(z['xl/_rels/workbook.xml.rels']) : '';
  const alvoPorId = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]*)"/.exec(m[1])?.[1];
    const alvo = /\bTarget="([^"]*)"/.exec(m[1])?.[1];
    if (id && alvo) alvoPorId.set(id, alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`);
  }
  const arquivos = Object.keys(z).filter((n) => n.startsWith('xl/worksheets/')).sort();
  const abas: Aba[] = [];
  let i = 0;
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const nome = decodificar(/\bname="([^"]*)"/.exec(m[1])?.[1] ?? `Aba ${i + 1}`);
    const rid = /\br:id="([^"]*)"/.exec(m[1])?.[1];
    const arq = (rid && alvoPorId.get(rid)) || arquivos[i];
    i++;
    if (!arq || !z[arq]) continue;
    abas.push({ nome, linhas: lerFolha(dec.decode(z[arq]), compartilhadas) });
  }
  return abas;
}

function lerFolha(xml: string, compartilhadas: string[]): string[][] {
  const linhas: string[][] = [];
  for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const numero = Number(/\br="(\d+)"/.exec(r[1])?.[1] ?? linhas.length + 1);
    const celulas: string[] = [];
    if (r[2]) {
      for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+)\d+"/i.exec(c[1])?.[1];
        const tipo = /\bt="([^"]*)"/.exec(c[1])?.[1];
        const corpo = c[2] ?? '';
        let valor = '';
        if (tipo === 'inlineStr') valor = textoDosT(corpo);
        else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
          if (v != null) valor = tipo === 's' ? (compartilhadas[Number(v)] ?? '') : decodificar(v);
        }
        const col = ref ? colunaDe(ref) : celulas.length;
        while (celulas.length < col) celulas.push('');
        celulas[col] = valor;
      }
    }
    while (linhas.length < numero - 1) linhas.push([]); // linhas vazias preservam a posição
    linhas[numero - 1] = celulas;
  }
  return linhas;
}
