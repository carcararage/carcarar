// Modo REAL no Chromium: login (supabase-js de verdade), primeira carga, trabalho SEM INTERNET, volta do sinal.
// Use um fake-supabase recém-iniciado a cada execução (ele guarda o que foi enviado).
// Precisa de: node e2e/fake-supabase.mjs (porta 54321) e o build real em preview (porta 4174):
//   VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x npx vite build --outDir dist-real
//   npx vite preview --outDir dist-real --port 4174 &
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

const BASE = process.env.BASE ?? 'http://127.0.0.1:4174/';
const API = process.env.API ?? 'http://127.0.0.1:54321';
const SHOTS = process.env.SHOTS ?? '/tmp/shots-real';
mkdirSync(SHOTS, { recursive: true });
const ok = (c, msg) => { if (!c) { console.error('✘', msg); process.exitCode = 1; } else console.log('✔', msg); };
const sql = async (q, params = []) => (await fetch(`${API}/__sql`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: q, params }) })).json();

async function acessibilidade(page, nome) {
  for (const esquema of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: esquema });
    await page.waitForTimeout(300);
    await page.addScriptTag({ path: axePath });
    const r = await page.evaluate(async () => await window.axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice'] }));
    const graves = r.violations.filter((v) => ['serious', 'critical'].includes(v.impact));
    ok(graves.length === 0, `axe ${nome} [${esquema}]: ${graves.length} graves` + (graves.length ? ' → ' + graves.map((g) => `${g.id}(${g.nodes.map((n) => n.target.join(' ')).join(' ; ')})`).join(' | ') : ''));
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const novoContexto = () => browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'pt-BR', timezoneId: 'America/Fortaleza',
  geolocation: { latitude: -2.905, longitude: -41.776 }, permissions: ['geolocation'] });

async function aberto(ctx) {
  await ctx.route(/tile\.openstreetmap\.org/, (r) => r.abort());
  const page = await ctx.newPage();
  const erros = [];
  page.on('pageerror', (e) => erros.push('pageerror: ' + e.message));
  page.on('console', (m) => m.type() === 'error' && !/tile|ERR_FAILED|ERR_INTERNET_DISCONNECTED|Failed to load resource|net::/i.test(m.text()) && erros.push('console: ' + m.text()));
  return { page, erros };
}
const login = async (page, email, senha) => {
  await page.goto(BASE + '#/entrar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Senha').fill(senha);
  await page.getByRole('button', { name: 'Entrar', exact: true }).click();
};
const indicador = (page) => page.locator('button.chip[aria-label^="Sincronização"]:visible').first();
const textoSync = async (page) => ((await indicador(page).innerText()).replace(/\s+/g, ' ').trim());
const esperaTexto = async (page, re, ms = 20_000) => {
  const t0 = Date.now();
  for (;;) { const t = await textoSync(page); if (re.test(t)) return t; if (Date.now() - t0 > ms) throw new Error(`indicador não chegou a ${re}: "${t}"`); await page.waitForTimeout(250); }
};

// ---------------- João ----------------
const ctxJ = await novoContexto();
const { page, erros } = await aberto(ctxJ);

await page.goto(BASE + '#/entrar');
await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor({ timeout: 90_000 });
await acessibilidade(page, 'login');
await login(page, 'joao@barao.test', 'senha-errada');
await page.getByText('E-mail ou senha incorretos.').waitFor();
ok(true, 'senha errada: mensagem clara, sem entrar');

await login(page, 'joao@barao.test', 'joao12345');
await page.getByText('Fila de visitas').waitFor({ timeout: 90_000 });
ok(true, 'login e primeira carga: abriu a tela Hoje do vendedor');
ok(/Tudo enviado/.test(await esperaTexto(page, /Tudo enviado/)), 'indicador: tudo enviado');
await page.screenshot({ path: `${SHOTS}/01-hoje-online.png` });

// carteira do João: só os pontos dele em detalhe
await page.goto(BASE + '#/pontos');
await page.getByRole('heading', { name: 'Pontos' }).waitFor();
ok(await page.getByText(/Vinculado a Gislandio/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), 'lista mostra clientes do Gislandio como "vinculado"');

// Service Worker pronto (para abrir offline depois)
await page.evaluate(() => navigator.serviceWorker?.ready).catch(() => null);
await page.waitForTimeout(1500);

// ---- SEM SINAL: registra visita ----
await page.goto(BASE + '#/');
await page.getByText('Fila de visitas').waitFor();
await page.getByRole('button', { name: 'Toda a carteira' }).click();
await page.waitForTimeout(500);
const card = page.locator('article.item').first();
const nome = await card.locator('a.titulo').innerText();
await ctxJ.setOffline(true);
await page.waitForTimeout(500);
await card.getByRole('button', { name: 'Registrar visita' }).click();
await page.getByRole('dialog').waitFor();
await page.waitForTimeout(500);
await page.getByRole('button', { name: /Pedido fechado/ }).click();
await page.getByRole('dialog').getByRole('button', { name: '7 dias', exact: true }).click();
await page.getByRole('button', { name: 'Salvar visita' }).click();
await page.locator('.toast').first().waitFor();
ok(true, `visita em "${nome}" salva SEM internet`);
const semSinal = await esperaTexto(page, /Sem sinal · 1 a enviar/);
ok(true, `indicador offline: "${semSinal}"`);
await page.screenshot({ path: `${SHOTS}/02-offline-pendente.png` });
ok((await sql(`select count(*)::int n from visitas`))[0].n === 0, 'servidor ainda não recebeu nada');

// abre a lista de pendências
await indicador(page).click();
await page.getByRole('dialog').getByText('Visita', { exact: true }).waitFor();
await page.getByRole('dialog').getByText('Aguardando').waitFor();
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/03-pendencias.png` });
await acessibilidade(page, 'sincronização (aberta)');
await page.keyboard.press('Escape');

// recarrega a página offline: o app abre do cache, com os dados e a fila preservados
await page.reload();
await page.getByText('Fila de visitas').waitFor({ timeout: 60_000 });
ok(/Sem sinal · 1 a enviar/.test(await esperaTexto(page, /Sem sinal · 1 a enviar/)), 'recarregou offline: app abriu e a fila continua (1 a enviar)');

// ---- VOLTA O SINAL ----
await ctxJ.setOffline(false);
await esperaTexto(page, /Tudo enviado/, 30_000);
ok(true, 'sinal voltou: fila enviada sozinha');
const sv = await sql(`select v.usuario_id, v.validacao, e.nome from visitas v join estabelecimentos e on e.id = v.estabelecimento_id`);
ok(sv.length === 1 && sv[0].usuario_id === '00000000-0000-0000-0000-000000000001' && sv[0].nome === nome, `servidor recebeu a visita de ${sv[0]?.nome} (${sv[0]?.validacao})`);
await page.screenshot({ path: `${SHOTS}/04-enviado.png` });

// sair e entrar de novo funciona; sair com pendência é barrado
await page.goto(BASE + '#/ajustes');
await page.getByRole('button', { name: 'Sair', exact: true }).click();
await page.getByRole('button', { name: 'Entrar', exact: true }).waitFor();
ok(true, 'sair volta ao login');
ok(erros.length === 0, 'João: sem erros de console/página' + (erros.length ? ' → ' + erros.join(' | ') : ''));

// ---------------- Gislandio (outro aparelho) ----------------
const ctxG = await novoContexto();
const g = await aberto(ctxG);
await login(g.page, 'gislandio@barao.test', 'gis123456');
await g.page.getByText('Fila de visitas').waitFor({ timeout: 90_000 });
await g.page.goto(BASE + '#/relatorio');
await g.page.getByRole('heading', { name: 'Relatório de visitas' }).waitFor();
await g.page.waitForTimeout(800);
ok(!(await g.page.locator('main').innerText()).includes(nome), 'Gislandio não vê a visita do João no relatório');
await g.page.goto(BASE + '#/pontos');
await g.page.getByRole('heading', { name: 'Pontos' }).waitFor();
ok(await g.page.getByText(/Vinculado a João/).first().waitFor({ timeout: 10_000 }).then(() => true, () => false), 'Gislandio vê clientes do João como "vinculado"');
ok(g.erros.length === 0, 'Gislandio: sem erros' + (g.erros.length ? ' → ' + g.erros.join(' | ') : ''));

// ---------------- Gestão ----------------
const ctxM = await novoContexto();
const m = await aberto(ctxM);
await login(m.page, 'gestor@barao.test', 'gestor123');
await m.page.getByRole('heading', { name: 'Cobertura por vendedor' }).waitFor({ timeout: 90_000 });
await m.page.waitForTimeout(800);
await m.page.screenshot({ path: `${SHOTS}/05-gestao.png` });
ok(true, 'gestão entra no Painel');
await m.page.goto(BASE + '#/relatorio');
await m.page.getByRole('heading', { name: 'Relatório de visitas' }).waitFor();
await m.page.waitForTimeout(800);
ok((await m.page.locator('main').innerText()).includes(nome), 'gestão vê a visita do João no relatório');
ok(m.erros.length === 0, 'Gestão: sem erros' + (m.erros.length ? ' → ' + m.erros.join(' | ') : ''));

// ---------------- Equipe: a administração cria um vendedor dentro do sistema ----------------
await m.page.goto(BASE + '#/equipe');
await m.page.getByRole('heading', { name: 'Equipe' }).waitFor();
await m.page.getByRole('button', { name: 'Novo usuário' }).click();
await m.page.getByLabel('Nome completo').fill('Maria Teste');
await m.page.getByLabel('E-mail (será o login)').fill('maria@barao.test');
const senhaGerada = await m.page.getByLabel('Senha inicial').inputValue();
ok(senhaGerada.length >= 8, `senha inicial gerada (${senhaGerada.length} caracteres)`);
await m.page.getByRole('button', { name: 'Criar usuário' }).click();
await m.page.getByText('Passe estes dados para a pessoa').waitFor();
await m.page.screenshot({ path: `${SHOTS}/06-equipe-criado.png` });
ok((await m.page.getByRole('dialog').innerText()).includes(senhaGerada), 'a senha aparece UMA vez para repassar');
await m.page.keyboard.press('Escape');
await m.page.getByText('Maria Teste').first().waitFor();
ok(true, 'Maria aparece na lista da Equipe');
const perfilMaria = await sql(`select papel::text, chave_import, ativo from perfis where nome = 'Maria Teste'`);
ok(perfilMaria[0]?.papel === 'vendedor' && perfilMaria[0]?.chave_import === 'maria-teste', 'perfil criado como vendedor com chave de importação');

// a vendedora nova entra sozinha, vê a carteira vazia e NÃO vê a tela Equipe
const ctxMa = await novoContexto();
const ma = await aberto(ctxMa);
await login(ma.page, 'maria@barao.test', senhaGerada);
await ma.page.getByText('Fila de visitas').waitFor({ timeout: 90_000 });
ok(true, 'vendedora criada no sistema consegue entrar');
await ma.page.goto(BASE + '#/equipe');
await ma.page.getByText('Fila de visitas').waitFor();
ok(true, 'vendedor não acessa a tela Equipe (volta para Hoje)');
// ela troca a própria senha
await ma.page.goto(BASE + '#/ajustes');
await ma.page.getByLabel('Nova senha').fill('senha-nova-123');
await ma.page.getByRole('button', { name: 'Trocar senha' }).click();
await ma.page.getByText('Senha alterada.').waitFor();
ok(true, 'vendedora troca a própria senha');

// a administração desativa: não consegue mais entrar
await m.page.locator('.item', { hasText: 'Maria Teste' }).getByRole('button', { name: 'Desativar' }).click();
await m.page.getByText(/desativado: não consegue mais entrar/).waitFor();
const ctxMb = await novoContexto();
const mb = await aberto(ctxMb);
await login(mb.page, 'maria@barao.test', 'senha-nova-123');
await mb.page.getByText('E-mail ou senha incorretos.').waitFor();
ok(true, 'usuário desativado não consegue entrar');
ok([m.erros, ma.erros, mb.erros].every((e) => e.length === 0), 'Equipe: sem erros de console/página' + [m.erros, ma.erros, mb.erros].flat().join(' | '));

await browser.close();
