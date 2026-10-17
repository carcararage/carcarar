import type { PGlite, Transaction } from '@electric-sql/pglite';

/** O que `sync_baixar` devolve (ver supabase/migrations/0007). */
export interface Snapshot {
  agora: string;
  completo: boolean;
  eu: string;
  perfis: { id: string; nome: string; papel: string; ativo: boolean; criado_em: string; chave_import: string | null }[];
  configuracoes: unknown[];
  regras: unknown[];
  regioes: unknown[] | null;
  estabelecimentos: unknown[];
  visitas: unknown[];
}

const LOTE = 400;

async function colunas(tx: Transaction, tabela: string): Promise<string[]> {
  const r = await tx.query<{ attname: string }>(
    `select attname from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`,
    [`public.${tabela}`],
  );
  return r.rows.map((x) => x.attname);
}

/** Insere/atualiza as linhas do servidor na cópia local, tabela a tabela, em lotes. */
async function upsert(tx: Transaction, tabela: string, chave: string[], linhas: unknown[]) {
  if (!linhas.length) return;
  const cols = await colunas(tx, tabela);
  const sets = cols.filter((c) => !chave.includes(c)).map((c) => `"${c}" = excluded."${c}"`).join(', ');
  const sql = `insert into public.${tabela} select * from jsonb_populate_recordset(null::public.${tabela}, $1::jsonb)
               on conflict (${chave.map((c) => `"${c}"`).join(', ')}) do update set ${sets}`;
  for (let i = 0; i < linhas.length; i += LOTE) await tx.query(sql, [JSON.stringify(linhas.slice(i, i + LOTE))]);
}

/**
 * Grava o que veio do servidor. Roda como dono do banco local e com os gatilhos DESLIGADOS
 * (session_replication_role = replica): os gatilhos existem para validar ações do usuário
 * (recalcular distância, carimbar hora, travar colunas) e aqui não podem reescrever o que o
 * servidor já decidiu.
 */
export async function aplicarSnapshot(db: PGlite, s: Snapshot): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);

    if (s.perfis.length) {
      const json = JSON.stringify(s.perfis);
      await tx.query(
        `insert into auth.users (id) select x.id from jsonb_to_recordset($1::jsonb) as x(id uuid) on conflict (id) do nothing`,
        [json],
      );
      await tx.query(
        `insert into public.perfis (id, nome, papel, ativo, criado_em, chave_import)
         select x.id, x.nome, x.papel, x.ativo, x.criado_em, x.chave_import
           from jsonb_to_recordset($1::jsonb) as x(id uuid, nome text, papel papel_usuario, ativo boolean, criado_em timestamptz, chave_import text)
         on conflict (id) do update set nome = excluded.nome, papel = excluded.papel, ativo = excluded.ativo,
                                        criado_em = excluded.criado_em, chave_import = excluded.chave_import`,
        [json],
      );
    }
    await upsert(tx, 'configuracoes', ['chave'], s.configuracoes);
    await upsert(tx, 'regras_cadencia', ['status', 'tier'], s.regras);
    if (s.regioes) await upsert(tx, 'regioes', ['id'], s.regioes);
    await upsert(tx, 'estabelecimentos', ['id'], s.estabelecimentos);
    await upsert(tx, 'visitas', ['id'], s.visitas);
  });
}
