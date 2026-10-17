import type { Tx } from '../db/banco';
import { modoReal } from './modo';

export type TipoOp =
  | 'visita'
  | 'cadastro'
  | 'localizacao'
  | 'assumir'
  | 'contato'
  | 'atualizar_pontos'
  | 'regra'
  | 'raio'
  | 'validar_visita';

type Ouvinte = () => void;
const ouvintes = new Set<Ouvinte>();

/** O motor se inscreve aqui para enviar assim que algo entra na fila. */
export const aoEnfileirar = (f: Ouvinte) => {
  ouvintes.add(f);
  return () => void ouvintes.delete(f);
};

/**
 * Registra a ação na fila DENTRO da mesma transação que aplicou o efeito local: ou os dois acontecem
 * ou nenhum (fechar o app no meio não deixa visita sem fila nem fila sem visita).
 * Em modo demonstração não há servidor, então não há fila.
 */
export async function enfileirarTx(tx: Tx, tipo: TipoOp, dados: Record<string, unknown>, pontoId: string | null = null) {
  if (!modoReal()) return;
  await tx.query(`insert into public._outbox (id, tipo, dados, ponto_id) values ($1, $2, $3::jsonb, $4)`, [
    crypto.randomUUID(),
    tipo,
    JSON.stringify(dados),
    pontoId,
  ]);
}

/** Chamar depois do commit. */
export function avisarFila() {
  if (modoReal()) ouvintes.forEach((f) => f());
}
