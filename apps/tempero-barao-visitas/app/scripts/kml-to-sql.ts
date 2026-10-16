/**
 * Linha de comando: lê um KML/KMZ do Google Earth e imprime o relatório (stderr)
 * e, opcionalmente, um `select importar_estabelecimentos(...)` pronto para o Supabase.
 *
 *   npx tsx scripts/kml-to-sql.ts mapa.kml                 # só relatório
 *   npx tsx scripts/kml-to-sql.ts mapa.kml --sql saida.sql # gera o SQL com o mapeamento sugerido
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { DOMParser } from '@xmldom/xmldom';
import { lerKmlDeBytes } from '../src/kml/arquivo';
import { aplicarRegras, detectarVendedores, sugerirRegras } from '../src/kml/mapeamento';
import { parseKml } from '../src/kml/parseKml';

const [arquivo, flag, saida] = process.argv.slice(2);
if (!arquivo) {
  console.error('uso: kml-to-sql.ts <arquivo.kml|kmz> [--sql saida.sql]');
  process.exit(1);
}

const res = parseKml(lerKmlDeBytes(readFileSync(arquivo)), new DOMParser() as never);
const vendedores = detectarVendedores(res.pastas);
const regras = sugerirRegras(res.pastas, vendedores);
const itens = aplicarRegras(res.itens, regras);

console.error('RESUMO', JSON.stringify(res.resumo));
console.error('VENDEDORES DETECTADOS', JSON.stringify(vendedores));
for (const r of regras) {
  const p = res.pastas.find((x) => x.chave === r.pasta)!;
  console.error(
    `PASTA ${String(p.total).padStart(4)} (${String(p.comCodigoErp).padStart(3)} c/ERP) ${p.rotulo} -> ` +
      `${r.statusComCodigoErp}/${r.statusSemCodigoErp} tier ${r.tier} dono ${r.vendedorChave ?? '-'}`,
  );
}
for (const s of res.suspeitos) console.error(`SUSPEITO ${s.nome} [${s.pasta.split(' / ').slice(-1)}] ${s.lat},${s.lng}: ${s.motivo}`);

if (flag === '--sql' && saida) {
  const j = (x: unknown) => JSON.stringify(x);
  const tag = '$kml$';
  writeFileSync(
    saida,
    `select importar_estabelecimentos(${tag}${j(itens)}${tag}::jsonb, ${tag}${j(res.regioes)}${tag}::jsonb);\n`,
  );
  console.error(`SQL gravado em ${saida} (${itens.length} pontos)`);
}
