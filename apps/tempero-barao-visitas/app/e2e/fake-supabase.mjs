// "Supabase de bolso" para testar o app em modo real SEM conta: um servidor HTTP que fala o mesmo
// protocolo que o supabase-js usa (Auth por senha + RPC do PostgREST) em cima de um Postgres de
// verdade com as migrações do projeto. O RLS, os gatilhos e as funções são os reais; só o
// "porteiro" (GoTrue/PostgREST) é simulado.
//   node e2e/fake-supabase.mjs            (porta 54321)
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const PORTA = Number(process.env.PORTA ?? 54321);
const BANCO = `barao_fake_${process.pid}`;
const SOCKET = process.env.PGHOST ?? '/var/run/postgresql';
const raiz = fileURLToPath(new URL('../../supabase/', import.meta.url));

execSync(`createdb ${BANCO}`);
const srv = new pg.Client({ host: SOCKET, database: BANCO, user: process.env.PGUSER ?? userInfo().username });
await srv.connect();
await srv.query(readFileSync(join(raiz, 'local/stub_supabase.sql'), 'utf8'));
for (const f of readdirSync(join(raiz, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) await srv.query(readFileSync(join(raiz, 'migrations', f), 'utf8'));

const USUARIOS = {
  'gestor@barao.test': { senha: 'gestor123', id: '00000000-0000-0000-0000-00000000000a', nome: 'Gestão Barão' },
  'joao@barao.test': { senha: 'joao12345', id: '00000000-0000-0000-0000-000000000001', nome: 'João Oliveira' },
  'gislandio@barao.test': { senha: 'gis123456', id: '00000000-0000-0000-0000-000000000002', nome: 'Gislandio Silveira' },
};
for (const [email, u] of Object.entries(USUARIOS)) {
  await srv.query(`insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`, [u.id, email, JSON.stringify({ nome: u.nome })]);
}
await srv.query(`update perfis set papel = 'gestor' where id = '${USUARIOS['gestor@barao.test'].id}';
  update perfis set chave_import = 'joao-oliveira' where id = '${USUARIOS['joao@barao.test'].id}';
  update perfis set chave_import = 'gislandio-silveira' where id = '${USUARIOS['gislandio@barao.test'].id}';`);
const itens = [];
const ruas = ['Centro', 'Carmo', 'Pindorama', 'Nova Parnaíba', 'São José'];
for (let i = 0; i < 40; i++) {
  itens.push({
    chave_externa: `k${i}`, nome: `${['Mercadinho', 'Restaurante', 'Lanchonete', 'Padaria'][i % 4]} Teste ${i}`,
    lat: -2.905 - (i % 8) / 400, lng: -41.776 + Math.floor(i / 8) / 400, cidade: 'Parnaíba', bairro: ruas[i % 5],
    telefone: `(86) 3000-${String(1000 + i)}`, status: i < 36 ? 'ativo' : 'prospecto', tier: ['A', 'B', 'C'][i % 3],
    vendedor_chave: i < 36 ? (i % 2 ? 'gislandio-silveira' : 'joao-oliveira') : null,
  });
}
await srv.query(`select importar_estabelecimentos($1::jsonb, '[]'::jsonb, 'escalonado')`, [JSON.stringify(itens)]);

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt = (u) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: u.id, role: 'authenticated', aud: 'authenticated', email: u.email, exp: Math.floor(Date.now() / 1000) + 3600 })}.assinatura`;
const usuarioDoToken = (h) => {
  try { return JSON.parse(Buffer.from(String(h ?? '').replace(/^Bearer /, '').split('.')[1], 'base64url').toString()).sub; } catch { return null; }
};

const cors = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
  res.setHeader('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] ?? '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
};
const json = (res, status, corpo) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo));
};
const lerCorpo = (req) => new Promise((ok) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => ok(d ? JSON.parse(d) : {})); });
const STATUS_POR_SQLSTATE = { '42501': 403, '23505': 409, '22023': 400, '22P02': 400 };

let fila = Promise.resolve(); // uma conexão: serializa
const servidor = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.writeHead(204).end();
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const { email, password } = await lerCorpo(req);
      const u = USUARIOS[String(email).toLowerCase()];
      if (!u || u.senha !== password) return json(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
      const usuario = { id: u.id, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: { nome: u.nome }, created_at: new Date().toISOString() };
      return json(res, 200, { access_token: jwt({ ...u, email }), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `r-${u.id}`, user: usuario });
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') {
      const { refresh_token: rt } = await lerCorpo(req);
      const email = Object.keys(USUARIOS).find((e) => `r-${USUARIOS[e].id}` === rt);
      if (!email) return json(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
      const u = USUARIOS[email];
      return json(res, 200, { access_token: jwt({ ...u, email }), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: rt, user: { id: u.id, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } });
    }
    if (url.pathname === '/auth/v1/logout') return res.writeHead(204).end();
    if (url.pathname === '/__sql' && req.method === 'POST') { // só para o teste conferir o servidor
      const { sql, params } = await lerCorpo(req);
      return json(res, 200, (await srv.query(sql, params ?? [])).rows);
    }
    const m = url.pathname.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (m && req.method === 'POST') {
      const uid = usuarioDoToken(req.headers.authorization);
      if (!uid) return json(res, 401, { code: 'PGRST301', message: 'JWT expired', details: null, hint: null });
      const args = await lerCorpo(req);
      const chaves = Object.keys(args);
      const params = chaves.map((k) => (typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k])));
      const lista = chaves.map((k, i) => `${k} => $${i + 1}::${typeof args[k] === 'string' ? 'text' : 'jsonb'}`).join(', ');
      const r = await (fila = fila.then(async () => {
        await srv.query('begin');
        try {
          await srv.query('set local role authenticated');
          await srv.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
          const x = await srv.query(`select ${m[1]}(${lista}) as r`, params);
          await srv.query('commit');
          return { ok: x.rows[0].r };
        } catch (e) {
          await srv.query('rollback').catch(() => {});
          return { erro: e };
        }
      }));
      if (r.erro) return json(res, STATUS_POR_SQLSTATE[r.erro.code] ?? 400, { code: r.erro.code, message: r.erro.message, details: r.erro.detail ?? null, hint: null });
      return json(res, 200, r.ok);
    }
    json(res, 404, { message: 'não encontrado' });
  } catch (e) {
    json(res, 500, { message: String(e) });
  }
});
servidor.listen(PORTA, '127.0.0.1', () => console.log(`fake supabase em http://127.0.0.1:${PORTA} (banco ${BANCO})`));
const sair = () => { servidor.close(); srv.end().finally(() => { try { execSync(`dropdb --if-exists ${BANCO}`, { stdio: 'ignore' }); } catch {} process.exit(0); }); };
process.on('SIGINT', sair);
process.on('SIGTERM', sair);
