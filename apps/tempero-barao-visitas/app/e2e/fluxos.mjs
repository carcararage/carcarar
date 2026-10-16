// Fluxos novos no navegador: planilha, cadastro, "vinculado a outro vendedor", mapa, relatório.
//   KML=/caminho/mapa.kml XLSX=/caminho/listagem.xlsx SHOTS=/pasta node e2e/fluxos.mjs
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4173/';
const KML = process.env.KML ?? fileURLToPath(new URL('../src/kml/__fixtures__/exemplo.kml', import.meta.url));
const XLSX = process.env.XLSX; // opcional: planilha real
const SHOTS = process.env.SHOTS ?? '/tmp/shots-fluxos';
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'pt-BR', timezoneId: 'America/Fortaleza',
  geolocation: { latitude: -2.9055, longitude: -41.7765 }, permissions: ['geolocation'] });
await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
const page = await ctx.newPage();
const erros = [];
page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && !/tile|ERR_FAILED/i.test(m.text()) && erros.push('console: ' + m.text()));
const shot = (n) => page.screenshot({ path: `${SHOTS}/${n}.png` });
const ok = (c, msg) => { if (!c) { console.error('✘', msg); process.exitCode = 1; } else console.log('✔', msg); };
const trocarPara = async (nome) => {
  await page.goto(BASE + '#/ajustes');
  await page.getByRole('button', { name: /Trocar usuário/ }).click();
  await page.getByRole('button', { name: new RegExp(nome) }).click();
};

await page.goto(BASE + '#/entrar');
await page.getByRole('heading', { name: 'Quem está usando?' }).waitFor({ timeout: 90_000 });
await page.getByRole('button', { name: /Gestão Barão/ }).click();

// 1) mapa do Earth
await page.goto(BASE + '#/importar');
await page.setInputFiles('input[type=file]', KML);
await page.getByRole('heading', { name: 'O que significa cada pasta?' }).waitFor({ timeout: 60_000 });
await page.getByRole('button', { name: /^Importar \d/ }).click();
await page.getByRole('heading', { name: 'Mapa importado!' }).waitFor({ timeout: 120_000 });
ok(true, 'mapa importado');

// 2) planilha (CSV simples, com 1 cliente já existente pelo código do ERP)
await page.goto(BASE + '#/importar');
await page.getByRole('button', { name: 'Planilha de clientes' }).click();
const csv = 'Código;Nome Fantasia;CNPJ;Endereço;Bairro;Cidade;UF;Celular\n100001;JULIA NO ERP;11.222.333/0001-81;Av Nova, 99;Carmo;Parnaíba;PI;(86) 99999-0001\n300001;Cliente So Planilha;55.666.777/0001-88;Rua Z, 3;Centro;Parnaíba;PI;(86) 98888-0002\n';
await page.setInputFiles('input[type=file]', { name: 'clientes.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
await page.getByRole('heading', { name: 'Quais colunas são quais?' }).waitFor();
await shot('01-planilha-colunas');
await page.getByRole('button', { name: /^Importar 2 clientes$/ }).click();
await page.getByRole('heading', { name: 'Planilha importada!' }).waitFor({ timeout: 60_000 });
await shot('02-planilha-importada');
ok(true, 'planilha CSV importada');

// 2b) planilha real do ERP (se fornecida): deve avisar que vieram sem nome
if (XLSX) {
  await page.getByRole('button', { name: 'Importar outra planilha' }).click();
  await page.setInputFiles('input[type=file]', XLSX);
  await page.getByText(/vieram sem nome e sem código do ERP/).waitFor({ timeout: 90_000 });
  await shot('03-planilha-erp-sem-nome');
  ok(true, 'planilha real do ERP: alerta de nomes ausentes exibido');
}

// 3) João cadastra um cliente na plataforma
await trocarPara('João Oliveira');
await page.goto(BASE + '#/cadastrar');
await page.getByLabel('Nome do estabelecimento *').fill('Mercadinho Teste E2E');
await page.getByLabel('CNPJ').fill('12.345.678/0001-90');
await page.getByRole('button', { name: /Usar minha localização/ }).click();
await page.getByText(/Localização capturada/).waitFor();
await page.getByRole('button', { name: /Sim, já compra/ }).click();
await shot('04-cadastrar');
await page.getByRole('button', { name: 'Cadastrar cliente' }).click();
await page.getByRole('heading', { name: 'Mercadinho Teste E2E' }).waitFor();
ok(await page.getByText('Ativo', { exact: true }).first().isVisible(), 'cliente cadastrado entra na carteira do João como ativo');
await shot('05-ficha-cadastrada');

// 4) Gislandio tenta cadastrar o mesmo CNPJ → bloqueado, vinculado ao João
await trocarPara('Gislandio Silveira');
await page.goto(BASE + '#/cadastrar');
await page.getByLabel('Nome do estabelecimento *').fill('Qualquer Nome');
await page.getByLabel('CNPJ').fill('12345678000190');
await page.getByText(/parece já existir/).waitFor();
ok(await page.getByText(/vinculado a João Oliveira/).first().isVisible(), 'duplicado barrado: "vinculado a João Oliveira"');
ok(await page.getByRole('button', { name: 'Cadastrar cliente' }).isDisabled(), 'botão de cadastrar fica bloqueado para vendedor');
await shot('06-duplicado');

// 5) Pontos do Gislandio: clientes do João aparecem "vinculados"
await page.goto(BASE + '#/pontos');
await page.getByRole('button', { name: 'De outros vendedores' }).click();
await page.waitForTimeout(500);
ok(await page.getByText(/Vinculado a João Oliveira/).first().isVisible(), 'lista mostra clientes de outro vendedor como vinculados');
await shot('07-pontos-de-outros');
const alheio = await page.getByRole('link', { name: /Mercadinho Teste E2E/ }).count();
ok(alheio === 0, 'cliente de outro vendedor não é clicável (sem ficha)');

// 6) mapa com a camada "De outros vendedores"
await page.goto(BASE + '#/mapa');
await page.locator('.leaflet-container').waitFor();
await page.waitForTimeout(1000);
ok(await page.getByRole('button', { name: /De outros vendedores/ }).isVisible(), 'mapa tem a camada "De outros vendedores"');
await shot('08-mapa');

// 7) João registra visita e vê o relatório
await trocarPara('João Oliveira');
await page.goto(BASE + '#/pontos');
await page.getByRole('button', { name: 'Meus clientes' }).click();
await page.getByLabel('Buscar pontos').fill('Mercadinho Teste E2E');
await page.getByRole('link', { name: /Mercadinho Teste E2E/ }).first().click();
await page.getByRole('button', { name: /Registrar visita/ }).first().click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(500);
await page.getByRole('button', { name: /Pedido fechado/ }).click();
await page.getByRole('button', { name: 'Salvar visita' }).click();
await page.locator('.toast').first().waitFor();
await page.goto(BASE + '#/relatorio');
await page.getByRole('heading', { name: 'Relatório de visitas' }).waitFor();
await page.waitForTimeout(500);
ok(await page.getByRole('link', { name: 'Mercadinho Teste E2E' }).first().isVisible(), 'relatório lista a visita com o cliente');
await shot('09-relatorio');
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Exportar CSV/ }).click()]);
ok(/relatorio-visitas-\d{4}-\d{2}-\d{2}\.csv/.test(download.suggestedFilename()), 'exporta CSV do relatório: ' + download.suggestedFilename());

ok(erros.length === 0, 'sem erros de console/página' + (erros.length ? ': ' + erros.slice(0, 4).join(' | ') : ''));
await browser.close();
