import { clienteSupabase } from './supabase';
import { ErroRede } from './transporte';

/** Chama a Edge Function "gerir-usuarios" (só a administração consegue; quem confere é o servidor). */
export async function gerirUsuarios<T = Record<string, unknown>>(corpo: Record<string, unknown>): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ErroRede('Gerenciar a equipe exige internet.');
  const { data, error } = await clienteSupabase().functions.invoke('gerir-usuarios', { body: corpo });
  if (!error) return data as T;
  const ctx = (error as { context?: Response }).context;
  if (ctx && typeof ctx.json === 'function') {
    if (ctx.status === 404) throw new Error('A função de usuários ainda não foi publicada no Supabase (veja supabase/README.md, passo "Equipe").');
    const j = (await ctx.json().catch(() => null)) as { erro?: string; message?: string } | null;
    throw new Error(j?.erro ?? j?.message ?? error.message);
  }
  throw new ErroRede(error.message);
}

export interface UsuarioConta {
  id: string;
  email: string;
  ultimoAcesso: string | null;
}

export const listarContas = async () => (await gerirUsuarios<{ usuarios: UsuarioConta[] }>({ acao: 'listar' })).usuarios;

/** A própria pessoa troca a própria senha (precisa de internet). */
export async function trocarMinhaSenha(senha: string): Promise<void> {
  const { error } = await clienteSupabase().auth.updateUser({ password: senha });
  if (error) throw new Error(/same|different/i.test(error.message) ? 'Escolha uma senha diferente da atual.' : error.message);
}
