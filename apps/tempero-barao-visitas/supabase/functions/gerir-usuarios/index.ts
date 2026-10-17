/**
 * Edge Function "gerir-usuarios" — criar vendedores, trocar senha, ativar/desativar, SEM abrir o painel do Supabase.
 *
 * Por que existe: só o servidor (com a chave de serviço) pode criar logins. O app comum nunca recebe essa
 * chave. Esta função confere QUEM está chamando (precisa ser administrador ativo) antes de fazer qualquer coisa.
 *
 * Como publicar (sem instalar nada): Supabase → Edge Functions → Deploy a new function → Via Editor →
 * nome: gerir-usuarios → cole ESTE arquivo inteiro → Deploy. Desligue "Verify JWT" (a própria função
 * confere o login, e a verificação do gateway não conhece as chaves novas "publishable").
 * A chave de serviço já vem configurada no ambiente da função; não cole chave nenhuma aqui.
 */

// ----------------------------------------------------------------------------------------------------
// Regras (puras: testadas fora do Supabase)
// ----------------------------------------------------------------------------------------------------

export interface Deps {
  /** id do usuário dono do token (já verificado) ou null */
  chamador(authorization: string | null): Promise<string | null>;
  perfil(id: string): Promise<{ papel: string; ativo: boolean } | null>;
  listar(): Promise<{ id: string; email: string; ultimoAcesso: string | null }[]>;
  /** lança Error com .code = 'email_exists' se o e-mail já tem conta */
  criar(email: string, senha: string, nome: string): Promise<{ id: string }>;
  definirPerfil(id: string, d: { nome: string; papel: string; chaveImport: string | null; ativo: boolean }): Promise<void>;
  chaveLivre(base: string): Promise<string>;
  trocarSenha(id: string, senha: string): Promise<void>;
  bloquear(id: string, sim: boolean): Promise<void>;
  marcarAtivo(id: string, ativo: boolean): Promise<void>;
}

export interface Resposta {
  status: number;
  corpo: Record<string, unknown>;
}

const PAPEIS_CRIAVEIS = ['vendedor', 'gestor', 'promotor'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const slug = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const erro = (status: number, mensagem: string): Resposta => ({ status, corpo: { erro: mensagem } });

export async function tratar(corpo: Record<string, unknown> | null, authorization: string | null, d: Deps): Promise<Resposta> {
  const uid = await d.chamador(authorization);
  if (!uid) return erro(401, 'Entre de novo para continuar.');
  const eu = await d.perfil(uid);
  if (!eu || !eu.ativo || eu.papel !== 'admin') return erro(403, 'Só a administração pode gerenciar usuários.');

  const acao = String(corpo?.acao ?? '');
  const str = (k: string) => String(corpo?.[k] ?? '').trim();

  if (acao === 'listar') return { status: 200, corpo: { usuarios: await d.listar() } };

  if (acao === 'criar') {
    const nome = str('nome');
    const email = str('email').toLowerCase();
    const senha = String(corpo?.senha ?? '');
    const papel = str('papel') || 'vendedor';
    if (nome.length < 2) return erro(400, 'Informe o nome.');
    if (!EMAIL.test(email)) return erro(400, 'E-mail inválido.');
    if (senha.length < 8) return erro(400, 'A senha precisa ter pelo menos 8 caracteres.');
    if (!PAPEIS_CRIAVEIS.includes(papel)) return erro(400, 'Papel inválido.');
    let novo: { id: string };
    try {
      novo = await d.criar(email, senha, nome);
    } catch (e) {
      if ((e as { code?: string }).code === 'email_exists') return erro(409, 'Este e-mail já tem cadastro.');
      return erro(400, (e as Error).message || 'Não foi possível criar o usuário.');
    }
    const chave = papel === 'vendedor' ? await d.chaveLivre(slug(nome) || 'vendedor') : null;
    await d.definirPerfil(novo.id, { nome, papel, chaveImport: chave, ativo: true });
    return { status: 200, corpo: { id: novo.id, chaveImport: chave } };
  }

  const id = str('id');
  if (!id) return erro(400, 'Informe o usuário.');
  const alvo = await d.perfil(id);
  if (!alvo) return erro(404, 'Usuário não encontrado.');

  if (acao === 'senha') {
    const senha = String(corpo?.senha ?? '');
    if (senha.length < 8) return erro(400, 'A senha precisa ter pelo menos 8 caracteres.');
    if (alvo.papel === 'admin' && id !== uid) return erro(403, 'A senha de outro administrador não pode ser trocada por aqui.');
    await d.trocarSenha(id, senha);
    return { status: 200, corpo: { ok: true } };
  }

  if (acao === 'desativar' || acao === 'ativar') {
    if (id === uid) return erro(400, 'Você não pode desativar o próprio acesso.');
    if (alvo.papel === 'admin') return erro(403, 'Administradores não podem ser desativados por aqui.');
    const ativar = acao === 'ativar';
    await d.marcarAtivo(id, ativar); // o acesso aos dados cai na hora (meu_papel() exige perfil ativo)
    await d.bloquear(id, !ativar); // e o login também
    return { status: 200, corpo: { ok: true } };
  }

  return erro(400, 'Ação desconhecida.');
}

// ----------------------------------------------------------------------------------------------------
// Ligação com o Supabase (só roda dentro da Edge Function)
// ----------------------------------------------------------------------------------------------------

declare const Deno: { env: { get(k: string): string | undefined }; serve(h: (r: Request) => Promise<Response> | Response): void } | undefined;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

async function iniciar() {
  const spec = 'npm:@supabase/supabase-js@2';
  const { createClient } = await import(/* @vite-ignore */ spec);
  const url = Deno!.env.get('SUPABASE_URL')!;
  const anon = Deno!.env.get('SUPABASE_ANON_KEY')!;
  const servico = Deno!.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const svc = createClient(url, servico, { auth: { persistSession: false, autoRefreshToken: false } });

  const deps: Deps = {
    async chamador(authorization) {
      if (!authorization) return null;
      const c = createClient(url, anon, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
      const { data, error } = await c.auth.getUser();
      return error || !data.user ? null : data.user.id;
    },
    async perfil(id) {
      const { data } = await svc.from('perfis').select('papel, ativo').eq('id', id).maybeSingle();
      return data ?? null;
    },
    async listar() {
      const { data, error } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (error) throw error;
      return data.users.map((u: { id: string; email?: string; last_sign_in_at?: string | null }) => ({
        id: u.id, email: u.email ?? '', ultimoAcesso: u.last_sign_in_at ?? null,
      }));
    },
    async criar(email, senha, nome) {
      const { data, error } = await svc.auth.admin.createUser({ email, password: senha, email_confirm: true, user_metadata: { nome } });
      if (error) {
        const e = new Error(error.message) as Error & { code?: string };
        e.code = /already|registered|exists/i.test(error.message) || error.code === 'email_exists' ? 'email_exists' : error.code;
        throw e;
      }
      return { id: data.user.id };
    },
    async definirPerfil(id, p) {
      const { error } = await svc.from('perfis').upsert({ id, nome: p.nome, papel: p.papel, chave_import: p.chaveImport, ativo: p.ativo });
      if (error) throw error;
    },
    async chaveLivre(base) {
      const { data } = await svc.from('perfis').select('chave_import').like('chave_import', `${base}%`);
      const usadas = new Set((data ?? []).map((x: { chave_import: string }) => x.chave_import));
      if (!usadas.has(base)) return base;
      for (let n = 2; ; n++) if (!usadas.has(`${base}-${n}`)) return `${base}-${n}`;
    },
    async trocarSenha(id, senha) {
      const { error } = await svc.auth.admin.updateUserById(id, { password: senha });
      if (error) throw error;
    },
    async bloquear(id, sim) {
      const { error } = await svc.auth.admin.updateUserById(id, { ban_duration: sim ? '876000h' : 'none' });
      if (error) throw error;
    },
    async marcarAtivo(id, ativo) {
      const { error } = await svc.from('perfis').update({ ativo }).eq('id', id);
      if (error) throw error;
    },
  };

  Deno!.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    try {
      const corpo = req.method === 'POST' ? await req.json().catch(() => null) : null;
      const r = await tratar(corpo, req.headers.get('Authorization'), deps);
      return new Response(JSON.stringify(r.corpo), { status: r.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
    } catch (e) {
      return new Response(JSON.stringify({ erro: `Falha interna: ${(e as Error).message}` }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } });
    }
  });
}

if (typeof Deno !== 'undefined') void iniciar();
