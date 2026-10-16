/**
 * Diagnóstico de uma planilha de clientes (e, opcionalmente, o cruzamento com o KML do Google Earth).
 *   npx tsx scripts/planilha-relatorio.ts clientes.xlsx [mapa.kml]
 * Imprime só contagens (nenhum dado pessoal).
 */
import { readFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { lerKmlDeBytes } from '../src/kml/arquivo';
import { parseKml } from '../src/kml/parseKml';
import { aplicarMapa, detectarLayout, lerRelatorioErp, lerTabela, paraItens, type LinhaCliente } from '../src/planilha/clientes';
import { lerCsv } from '../src/planilha/csvLeitor';
import { lerXlsx } from '../src/planilha/xlsx';

const [arq, kml] = process.argv.slice(2);
const bytes = readFileSync(arq);
const t0 = Date.now();
const linhas = /\.(csv|txt)$/i.test(arq) ? lerCsv(new TextDecoder().decode(bytes)) : lerXlsx(new Uint8Array(bytes)).sort((a, b) => b.linhas.length - a.linhas.length)[0].linhas;
console.log(`lido em ${Date.now() - t0} ms · ${linhas.length} linhas`);
const layout = detectarLayout(linhas);
console.log('layout:', layout);

let clientes: LinhaCliente[];
if (layout === 'relatorio-erp') {
  const r = lerRelatorioErp(linhas);
  console.log(`blocos de cliente: ${r.blocos} · sem nome/código: ${r.semNome} (${Math.round((100 * r.semNome) / r.blocos)}%)`);
  clientes = r.linhas;
} else {
  const t = lerTabela(linhas);
  console.log('colunas reconhecidas:', Object.keys(t.mapa).join(', '), '· linhas de dados:', t.dados.length);
  clientes = aplicarMapa(t.dados, t.mapa);
}
const com = (f: (c: (typeof clientes)[number]) => unknown) => clientes.filter(f).length;
console.log(`com CNPJ(14): ${com((c) => (c.cnpj ?? '').replace(/\D/g, '').length === 14)} · com CPF(11, será descartado): ${com((c) => (c.cnpj ?? '').replace(/\D/g, '').length === 11)}`);
console.log(`com telefone: ${com((c) => c.telefone)} · com celular: ${com((c) => c.celular)} · com endereço: ${com((c) => c.endereco)} · com bairro: ${com((c) => c.bairro)}`);
const cidades = new Map<string, number>();
for (const c of clientes) cidades.set(c.cidade ?? '(vazia)', (cidades.get(c.cidade ?? '(vazia)') ?? 0) + 1);
console.log('cidades (top 6):', [...cidades].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(' | '));

const r = paraItens(clientes, { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null });
console.log(`importáveis com nome: ${r.itens.length} · sem nome (pulados): ${r.semNome} · duplicados: ${r.duplicadosNoArquivo} · CPF descartados: ${r.cpfDescartados}`);
const prov = paraItens(clientes, { statusPadrao: 'prospecto', tierPadrao: 'C', vendedorPadrao: null, incluirSemNome: true });
console.log(`se incluir sem nome (nome provisório = endereço): ${prov.itens.length}`);

if (kml) {
  const mapa = parseKml(lerKmlDeBytes(new Uint8Array(readFileSync(kml))), new DOMParser() as never);
  const cnpjsEarth = new Set(mapa.itens.map((i) => (i.cnpj ?? '').replace(/\D/g, '')).filter((x) => x.length === 14));
  const nosDois = clientes.filter((c) => cnpjsEarth.has((c.cnpj ?? '').replace(/\D/g, '')));
  console.log(`cruzamento por CNPJ com o Google Earth: ${cnpjsEarth.size} CNPJs no mapa · ${nosDois.length} blocos da planilha casam · ${clientes.length - nosDois.length} só na planilha`);
}
