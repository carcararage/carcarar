import { PGlite, type Transaction } from '@electric-sql/pglite';
import { DDL_LOCAL } from '../sync/local';
import { MIGRACOES, STUB_SUPABASE } from './schema';

/**
 * Modo demonstração / offline: um Postgres de verdade (PGlite, WebAssembly) dentro do navegador,
 * persistido em IndexedDB, rodando as mesmas migrações do Supabase. Toda regra de negócio
 * (cadência, validação de GPS, permissões por RLS) é SQL — o app só chama.
 */

let aberto: Promise<PGlite> | null = null;

export interface OpcoesBanco {
  /** 'idb://nome' persiste no navegador; vazio = memória (testes) */
  persistencia?: string;
}

export function abrirBanco(opcoes: OpcoesBanco = {}): Promise<PGlite> {
  aberto ??= (async () => {
    const db = new PGlite(opcoes.persistencia);
    await db.waitReady;
    await migrar(db);
    return db;
  })();
  return aberto;
}

/** Só para testes: descarta a instância em cache. */
export function esquecerBanco() {
  aberto = null;
}

/** Só para testes: troca o "aparelho" (outra cópia local) sem reabrir. */
export function usarBanco(db: PGlite) {
  aberto = Promise.resolve(db);
}

async function migrar(db: PGlite) {
  const existe = await db.query<{ t: string | null }>(`select to_regclass('public._migracoes')::text as t`);
  if (!existe.rows[0].t) {
    await db.exec(STUB_SUPABASE);
    await db.exec(`create table public._migracoes (nome text primary key, aplicada_em timestamptz default now())`);
  }
  const feitas = new Set(
    (await db.query<{ nome: string }>(`select nome from public._migracoes`)).rows.map((r) => r.nome),
  );
  for (const m of MIGRACOES) {
    if (feitas.has(m.nome)) continue;
    await db.exec(m.sql);
    await db.query(`insert into public._migracoes (nome) values ($1)`, [m.nome]);
  }
  await db.exec(DDL_LOCAL); // fila e estado de sincronização (só existem no aparelho)
}

export type Tx = Transaction;

/**
 * Executa `fn` como o usuário `uid` (papel `authenticated` + auth.uid()) — as políticas de RLS
 * valem exatamente como no Supabase. `uid = null` roda como administrador do banco
 * (só para preparar dados: criar usuários, limpar tudo).
 */
export async function comoUsuario<T>(uid: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = await abrirBanco();
  return db.transaction(async (tx) => {
    if (uid) {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      await tx.exec('set local role authenticated');
    }
    return fn(tx);
  });
}
