// Teste de ponta a ponta no navegador (Chromium headless) contra o build servido em BASE.
//   npm run build && npx vite preview --port 4173 &
//   KML=/caminho/arquivo.kml SHOTS=/pasta/screenshots node e2e/smoke.mjs
// Sem KML, usa o arquivo fictício de teste.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173/';
const KML = process.env.KML ?? fileURLToPath(new URL('../src/kml/__fixtures__/exemplo.kml', import.meta.url));
const SHOTS = process.env.SHOTS ?? '/tmp/shots';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'pt-BR', timezoneId: 'America/Fortaleza',
  geolocation: { latitude: -2.9055, longitude: -41.7765 }, permissions: ['geolocation'],
});
// mapa: sem internet no CI → tiles falham em silêncio
await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
const page = await ctx.newPage();
const erros = [];
page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && !/tile|cartocdn|ERR_FAILED/i.test(m.text()) && erros.push('console: ' + m.text()));

const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const ok = (c, msg) => { if (!c) { console.error('✘', msg); process.exitCode = 1; } else console.log('✔', msg); };

await page.goto(BASE + '#/entrar');
await page.getByRole('heading', { name: 'Quem está usando?' }).waitFor({ timeout: 90_000 });
await shot('01-entrar');

// gestão entra e vê o convite para importar
await page.getByRole('button', { name: /Gestão Barão/ }).click();
await page.getByRole('heading', { name: /Vamos começar pelo mapa/ }).waitFor();
await shot('02-painel-vazio');

// importa o KML
await page.goto(BASE + '#/importar');
await page.setInputFiles('input[type=file]', KML);
await page.getByRole('heading', { name: 'O que significa cada pasta?' }).waitFor({ timeout: 60_000 });
await shot('03-importar-revisao');
await page.getByRole('button', { name: /^Importar \d/ }).click();
await page.getByRole('heading', { name: 'Mapa importado!' }).waitFor({ timeout: 120_000 });
await shot('04-importado');
ok(true, 'importação concluída');

// painel da gestão
await page.goto(BASE + '#/');
await page.getByRole('heading', { name: 'Cobertura por vendedor' }).waitFor();
await shot('05-painel');
ok(await page.getByText('Cobertura da carteira').first().isVisible(), 'painel mostra cobertura');

await page.goto(BASE + '#/pontos');
await page.getByRole('heading', { name: 'Pontos' }).waitFor();
await page.waitForTimeout(600);
await shot('06-pontos');

await page.goto(BASE + '#/mapa');
await page.locator('.leaflet-container').waitFor();
await page.waitForTimeout(1200);
await shot('07-mapa');

// vira o vendedor João
await page.goto(BASE + '#/ajustes');
await page.getByRole('button', { name: /Trocar usuário/ }).click();
await page.getByRole('button', { name: /João Oliveira/ }).click();
await page.getByText('Fila de visitas').waitFor();
await page.waitForTimeout(800);
await shot('08-hoje-vendedor');

// registra uma visita no primeiro cartão
await page.getByRole('button', { name: 'Toda a carteira' }).click();
await page.waitForTimeout(600);
const primeiro = page.locator('article.item').first();
const nome = await primeiro.locator('a.titulo').innerText();
await primeiro.getByRole('button', { name: 'Registrar visita' }).click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(500);
await page.getByRole('button', { name: /Pedido fechado/ }).click();
await page.getByRole('dialog').getByRole('button', { name: '7 dias', exact: true }).click();
await shot('09-registrar-visita');
await page.getByRole('button', { name: 'Salvar visita' }).click();
await page.locator('.toast').first().waitFor();
const aviso = await page.locator('.toast').first().innerText();
console.log('   toast:', aviso.replace(/\n/g, ' '));
await shot('10-visita-salva');
ok(/Visita registrada|aguarda/i.test(aviso), 'visita salva com retorno do servidor');

// ficha do ponto
await page.locator('article.item').first().locator('a.titulo').click().catch(() => {});
await page.goto(BASE + '#/pontos');
await page.getByRole('link', { name: new RegExp(nome.slice(0, 12)) }).first().click();
await page.getByRole('heading', { name: 'Relatório de visitas' }).waitFor();
await page.waitForTimeout(400);
await shot('11-ficha');

// desktop + tema escuro + design system
await page.setViewportSize({ width: 1280, height: 860 });
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto(BASE + '#/');
await page.waitForTimeout(900);
await shot('12-desktop-escuro');
await page.emulateMedia({ colorScheme: 'light' });
await page.goto(BASE + '#/design-system');
await page.getByRole('heading', { name: 'Tipografia' }).waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: `${SHOTS}/13-design-system.png`, fullPage: true });

ok(erros.length === 0, 'sem erros de console/página' + (erros.length ? ': ' + erros.slice(0, 5).join(' | ') : ''));
await browser.close();
