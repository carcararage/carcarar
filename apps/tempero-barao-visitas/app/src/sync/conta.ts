import { abrirBanco } from '../db/banco';
import { clienteSupabase } from './supabase';
import { contarFila, lerEstado } from './motor';

/** Login no Supabase Auth. A sessão fica no aparelho (abre offline); o token renova sozinho quando há sinal. */

export interface SessaoConta {
  uid: string;
  email: string;
}

export async function sessaoSalva(): Promise<SessaoConta | null> {
  const { data } = await clienteSupabase().auth.getSession();
  return data.session ? { uid: data.session.user.id, email: data.session.user.email ?? '' } : null;
}

export async function entrarComSenha(email: string, senha: string): Promise<SessaoConta> {
  const { data, error } = await clienteSupabase().auth.signInWithPassword({ email: email.trim(), password: senha });
  if (error) {
    if (error.name === 'AuthRetryableFetchError' || /fetch|network/i.test(error.message))
      throw new Error('Sem conexão. O primeiro acesso neste aparelho precisa de internet.');
    if (error.status === 400 || /invalid login/i.test(error.message)) throw new Error('E-mail ou senha incorretos.');
    if (error.status === 429) throw new Error('Muitas tentativas. Espere um minuto e tente de novo.');
    throw new Error(error.message);
  }
  return { uid: data.user.id, email: data.user.email ?? email };
}

export async function sairDaConta(): Promise<void> {
  const a = clienteSupabase().auth;
  const { error } = await a.signOut();
  if (error) await a.signOut({ scope: 'local' }); // sem sinal: ao menos esquece a sessão neste aparelho
}

export function aoMudarSessao(f: (saiu: boolean) => void): () => void {
  const { data } = clienteSupabase().auth.onAuthStateChange((evento) => {
    if (evento === 'SIGNED_OUT') f(true);
  });
  return () => data.subscription.unsubscribe();
}

/** Apaga a cópia local (dados e fila). Só use depois de conferir que não há nada pendente. */
export async function apagarCopiaLocal(): Promise<void> {
  const db = await abrirBanco();
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    await tx.exec(`
      delete from visitas; delete from estabelecimentos; delete from regioes; delete from perfis; delete from auth.users;
      delete from _outbox; delete from _sync;`);
  });
}

/**
 * Antes de entrar: se este aparelho guardava os dados de OUTRA pessoa, a cópia dela é apagada (cada
 * pessoa só pode ter no aparelho o que o servidor liberou para ela) — a menos que ainda haja ações
 * dela sem enviar: nesse caso, nada é apagado e a pessoa certa precisa entrar primeiro para enviá-las.
 */
export async function prepararAparelho(uid: string): Promise<void> {
  const dono = await lerEstado('usuario');
  if (!dono || dono === uid) return;
  const { pendentes, rejeitadas } = await contarFila();
  if (pendentes + rejeitadas > 0) {
    throw new Error(
      `Este aparelho ainda tem ${pendentes + rejeitadas} ação(ões) de outra pessoa sem enviar. Peça para quem usava entrar de novo e sincronizar antes.`,
    );
  }
  await apagarCopiaLocal();
}
