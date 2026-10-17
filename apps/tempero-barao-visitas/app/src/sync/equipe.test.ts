/**
 * Regras da função "gerir-usuarios" (criar vendedor, senha, desativar) contra um Postgres de verdade:
 * o "Auth" é o stub (auth.users + gatilho que cria o perfil), como no Supabase.
 * Pula sozinho se não houver Postgres local.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { slug, tratar, type Deps } from '../../../supabase/functions/gerir-usuarios/index';

const BANCO = `barao_equipe_${process.pid}`;
const raiz = join(import.meta.dirname, '../../../supabase');
const pgDisponivel = (() => {
  try {
    execSync('psql -X -qc "select 1" postgres', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const VEND = '00000000-0000-0000-0000-0000000000b1';
let pg: Client;
const senhas = new Map<string, string>();
const bloqueados = new Set<string>();

function deps(logadoComo: string | null): Deps {
  return {
    chamador: async (auth) => (auth === 'Bearer valido' ? logadoComo : null),
    perfil: async (id) => (await pg.query(`select papel::text, ativo from perfis where id = $1`, [id])).rows[0] ?? null,
    listar: async () => (await pg.query(`select id, email, null as "ultimoAcesso" from auth.users order by email`)).rows,
    criar: async (email, senha, nome) => {
      if ((await pg.query(`select 1 from auth.users where email = $1`, [email])).rowCount) {
        throw Object.assign(new Error('User already registered'), { code: 'email_exists' });
      }
      const r = await pg.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id`, [email, JSON.stringify({ nome })]);
      senhas.set(r.rows[0].id, senha);
      return { id: r.rows[0].id };
    },
    definirPerfil: async (id, p) => void (await pg.query(`update perfis set nome = $2, papel = $3::papel_usuario, chave_import = $4, ativo = $5 where id = $1`, [id, p.nome, p.papel, p.chaveImport, p.ativo])),
    chaveLivre: async (base) => {
      const usadas = new Set((await pg.query(`select chave_import c from perfis where chave_import like $1`, [`${base}%`])).rows.map((x) => x.c));
      if (!usadas.has(base)) return base;
      for (let n = 2; ; n++) if (!usadas.has(`${base}-${n}`)) return `${base}-${n}`;
    },
    trocarSenha: async (id, s) => void senhas.set(id, s),
    bloquear: async (id, sim) => void (sim ? bloqueados.add(id) : bloqueados.delete(id)),
    marcarAtivo: async (id, a) => void (await pg.query(`update perfis set ativo = $2 where id = $1`, [id, a])),
  };
}
const chamar = (corpo: Record<string, unknown>, como: string | null = ADMIN, auth = 'Bearer valido') => tratar(corpo, auth, deps(como));

describe.skipIf(!pgDisponivel)('função gerir-usuarios (regras)', () => {
  beforeAll(async () => {
    execSync(`createdb ${BANCO}`);
    pg = new Client({ host: process.env.PGHOST ?? '/var/run/postgresql', database: BANCO, user: process.env.PGUSER ?? userInfo().username });
    await pg.connect();
    await pg.query(readFileSync(join(raiz, 'local/stub_supabase.sql'), 'utf8'));
    for (const f of readdirSync(join(raiz, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) await pg.query(readFileSync(join(raiz, 'migrations', f), 'utf8'));
    await pg.query(`insert into auth.users (id, email, raw_user_meta_data) values ('${ADMIN}', 'admin@x.test', '{"nome":"Gestão"}'), ('${VEND}', 'v@x.test', '{"nome":"Vendedor Um"}')`);
    await pg.query(`update perfis set papel = 'admin' where id = '${ADMIN}'`);
  }, 120_000);
  afterAll(async () => {
    await pg?.end();
    try { execSync(`dropdb --if-exists ${BANCO}`, { stdio: 'ignore' }); } catch { /* ignore */ }
  });

  it('slug: igual ao do importador (João Oliveira → joao-oliveira)', () => {
    expect(slug('João Oliveira')).toBe('joao-oliveira');
    expect(slug('  Gislândio  Silveira ')).toBe('gislandio-silveira');
  });

  it('quem não está logado ou não é administrador não faz nada', async () => {
    expect((await chamar({ acao: 'listar' }, ADMIN, 'Bearer errado')).status).toBe(401);
    expect((await chamar({ acao: 'listar' }, null)).status).toBe(401);
    const r = await chamar({ acao: 'criar', nome: 'Hacker', email: 'h@x.test', senha: '12345678' }, VEND);
    expect(r.status).toBe(403);
    expect((await pg.query(`select 1 from auth.users where email = 'h@x.test'`)).rowCount).toBe(0);
  });

  it('cria vendedor: login confirmado, perfil com papel e chave de importação', async () => {
    const r = await chamar({ acao: 'criar', nome: 'Maria Souza', email: 'Maria@X.test', senha: 'senha-forte-1', papel: 'vendedor' });
    expect(r.status).toBe(200);
    const p = (await pg.query(`select nome, papel::text, chave_import, ativo from perfis where id = $1`, [r.corpo.id])).rows[0];
    expect(p).toEqual({ nome: 'Maria Souza', papel: 'vendedor', chave_import: 'maria-souza', ativo: true });
    expect(senhas.get(r.corpo.id as string)).toBe('senha-forte-1');
    expect((await pg.query(`select email from auth.users where id = $1`, [r.corpo.id])).rows[0].email).toBe('maria@x.test'); // e-mail em minúsculas
  });

  it('validações: nome, e-mail, senha curta, papel inválido (não cria administrador), e-mail repetido', async () => {
    expect((await chamar({ acao: 'criar', nome: 'A', email: 'a@x.test', senha: '12345678' })).status).toBe(400);
    expect((await chamar({ acao: 'criar', nome: 'Fulano', email: 'sem-arroba', senha: '12345678' })).status).toBe(400);
    expect((await chamar({ acao: 'criar', nome: 'Fulano', email: 'f@x.test', senha: '1234567' })).status).toBe(400);
    expect((await chamar({ acao: 'criar', nome: 'Fulano', email: 'f@x.test', senha: '12345678', papel: 'admin' })).status).toBe(400);
    const dup = await chamar({ acao: 'criar', nome: 'Maria Outra', email: 'maria@x.test', senha: '12345678' });
    expect(dup.status).toBe(409);
  });

  it('dois vendedores com o mesmo nome ganham chaves diferentes', async () => {
    const a = await chamar({ acao: 'criar', nome: 'Pedro Lima', email: 'p1@x.test', senha: '12345678' });
    const b = await chamar({ acao: 'criar', nome: 'Pedro Lima', email: 'p2@x.test', senha: '12345678' });
    expect([a.corpo.chaveImport, b.corpo.chaveImport]).toEqual(['pedro-lima', 'pedro-lima-2']);
  });

  it('gestor criado não ganha chave de importação (só vendedor recebe carteira)', async () => {
    const r = await chamar({ acao: 'criar', nome: 'Ana Gestora', email: 'ana@x.test', senha: '12345678', papel: 'gestor' });
    expect(r.corpo.chaveImport).toBeNull();
  });

  it('troca senha; não mexe na senha de outro administrador; exige 8 caracteres', async () => {
    expect((await chamar({ acao: 'senha', id: VEND, senha: 'nova-senha-9' })).status).toBe(200);
    expect(senhas.get(VEND)).toBe('nova-senha-9');
    expect((await chamar({ acao: 'senha', id: VEND, senha: 'curta' })).status).toBe(400);
    await pg.query(`insert into auth.users (id, email, raw_user_meta_data) values ('00000000-0000-0000-0000-0000000000a2', 'admin2@x.test', '{"nome":"Outro Admin"}')`);
    await pg.query(`update perfis set papel = 'admin' where id = '00000000-0000-0000-0000-0000000000a2'`);
    expect((await chamar({ acao: 'senha', id: '00000000-0000-0000-0000-0000000000a2', senha: 'qualquer-coisa' })).status).toBe(403);
    expect((await chamar({ acao: 'senha', id: ADMIN, senha: 'minha-nova-senha' })).status).toBe(200); // a própria, pode
  });

  it('desativa e reativa; o acesso aos dados cai junto com o perfil; não desativa a si nem administrador', async () => {
    expect((await chamar({ acao: 'desativar', id: VEND })).status).toBe(200);
    expect(bloqueados.has(VEND)).toBe(true);
    expect((await pg.query(`select ativo from perfis where id = $1`, [VEND])).rows[0].ativo).toBe(false);
    // com o perfil inativo o servidor já não reconhece o papel (RLS/meu_papel)
    await pg.query('begin');
    await pg.query(`set local role authenticated`);
    await pg.query(`select set_config('request.jwt.claim.sub', $1, true)`, [VEND]);
    await expect(pg.query(`select sync_baixar()`)).rejects.toThrow(/não autenticado ou inativo/);
    await pg.query('rollback');
    expect((await chamar({ acao: 'ativar', id: VEND })).status).toBe(200);
    expect(bloqueados.has(VEND)).toBe(false);
    expect((await chamar({ acao: 'desativar', id: ADMIN })).status).toBe(400);
    expect((await chamar({ acao: 'desativar', id: '00000000-0000-0000-0000-0000000000a2' })).status).toBe(403);
    expect((await chamar({ acao: 'desativar', id: '00000000-0000-0000-0000-00000000dead' })).status).toBe(404);
    expect((await chamar({ acao: 'explodir', id: VEND })).status).toBe(400);
  });

  it('lista os usuários com e-mail', async () => {
    const r = await chamar({ acao: 'listar' });
    expect((r.corpo.usuarios as { email: string }[]).map((u) => u.email)).toContain('maria@x.test');
  });
});
