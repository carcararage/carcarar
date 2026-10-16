// Auditoria de acessibilidade (axe-core) das telas principais, nos temas claro e escuro.
//   npm run build && npx vite preview --port 4173 &   node e2e/a11y.mjs
import { chromium } from 'playwright-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173/';
const KML = process.env.KML ?? fileURLToPath(new URL('../src/kml/__fixtures__/exemplo.kml', import.meta.url));
const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'pt-BR', timezoneId: 'America/Fortaleza',
  geolocation: { latitude: -2.9055, longitude: -41.7765 }, permissions: ['geolocation'] });
await ctx.route(/basemaps\.cartocdn\.com/, (r) => r.abort());
const page = await ctx.newPage();

await page.goto(BASE + '#/entrar');
await page.getByRole('heading', { name: 'Quem está usando?' }).waitFor({ timeout: 90_000 });
await page.getByRole('button', { name: /Gestão Barão/ }).click();
await page.goto(BASE + '#/importar');
await page.setInputFiles('input[type=file]', KML);
await page.getByRole('heading', { name: 'O que significa cada pasta?' }).waitFor({ timeout: 60_000 });
const telaImportar = '#/importar';
const rotas = [['entrar-pos', '#/entrar'], ['importar-revisao', telaImportar]];
// revisão de importação auditada antes de gravar; depois grava para auditar o resto
const resultados = [];
async function auditar(nome) {
  await page.addScriptTag({ path: axePath });
  const r = await page.evaluate(async () => await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
  const graves = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
  resultados.push({ nome, graves, outros: r.violations.filter((v) => !['serious', 'critical'].includes(v.impact)) });
}
for (const esquema of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: esquema });
  await page.waitForTimeout(300);
  await auditar(`importar-revisao [${esquema}]`);
}
await page.emulateMedia({ colorScheme: 'light' });
await page.getByRole('button', { name: /^Importar \d/ }).click();
await page.getByRole('heading', { name: 'Mapa importado!' }).waitFor({ timeout: 120_000 });

const id = await page.evaluate(() => null);
const telas = [['painel', '#/'], ['esquecidos', '#/esquecidos'], ['pontos', '#/pontos'], ['mapa', '#/mapa'], ['ajustes', '#/ajustes'], ['design-system', '#/design-system']];
for (const esquema of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: esquema });
  for (const [nome, h] of telas) {
    await page.goto(BASE + h); await page.waitForTimeout(nome === 'mapa' ? 1200 : 700);
    await auditar(`${nome} [${esquema}]`);
  }
}
// vendedor: hoje + ficha
await page.goto(BASE + '#/ajustes');
await page.getByRole('button', { name: /Trocar usuário/ }).click();
await page.getByRole('button', { name: /João Oliveira/ }).click();
await page.getByText('Fila de visitas').waitFor();
for (const esquema of ['light', 'dark']) {
  await page.emulateMedia({ colorScheme: esquema });
  await page.goto(BASE + '#/'); await page.waitForTimeout(900);
  await auditar(`hoje [${esquema}]`);
  await page.locator('article.item a.titulo').first().click(); await page.getByRole('heading', { name: 'Histórico de visitas' }).waitFor();
  await auditar(`ficha [${esquema}]`);
  await page.getByRole('button', { name: /Registrar visita/ }).first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(400);
  await auditar(`gaveta-visita [${esquema}]`);
  await page.keyboard.press('Escape');
}

let total = 0;
for (const r of resultados) {
  total += r.graves.length;
  console.log(`${r.graves.length ? '✘' : '✔'} ${r.nome}  graves:${r.graves.length}  outros:${r.outros.length}${r.outros.length ? ' (' + r.outros.map((o) => o.id).join(', ') + ')' : ''}`);
  for (const v of r.graves) console.log(`    - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length}x) ex.: ${v.nodes[0].target.join(' ')} → ${(v.nodes[0].any[0]?.message ?? '').slice(0, 140)}`);
}
console.log(total ? `\n${total} violação(ões) grave(s)` : '\nNenhuma violação grave/crítica');
await browser.close();
process.exitCode = total ? 1 : 0;
