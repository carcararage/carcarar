import { useSyncExternalStore } from 'react';
import { abrirBanco } from '../db/banco';
import { aplicarSnapshot, type Snapshot } from './aplicar';
import { aoEnfileirar } from './fila';
import { modoReal } from './modo';
import { ErroAuth, ErroRede, transporteAtual } from './transporte';

/**
 * Motor de sincronização.
 *  1) ENVIA a fila de ações feitas no aparelho (na ordem; cada uma é idempotente);
 *  2) BAIXA o que mudou no servidor desde a última vez;
 * Nunca nesta ordem invertida: baixar antes de enviar reverteria, na tela, o que o usuário acabou de fazer.
 */

export interface EstadoSync {
  online: boolean;
  ocupado: boolean;
  pendentes: number;
  rejeitadas: number;
  ultimaSync: Date | null;
  erro: string | null;
  precisaEntrar: boolean;
}

let estado: EstadoSync = {
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  ocupado: false,
  pendentes: 0,
  rejeitadas: 0,
  ultimaSync: null,
  erro: null,
  precisaEntrar: false,
};
const ouvintes = new Set<() => void>();
const mudar = (p: Partial<EstadoSync>) => {
  estado = { ...estado, ...p };
  ouvintes.forEach((f) => f());
};
const assinar = (f: () => void) => {
  ouvintes.add(f);
  return () => void ouvintes.delete(f);
};

export const estadoSync = () => estado;
export const useEstadoSync = () => useSyncExternalStore(assinar, estadoSync, estadoSync);

/** Avisos para a interface (ex.: "uma ação foi recusada pelo servidor"). */
type AvisoRecusa = { tipo: string; erro: string };
const avisos = new Set<(a: AvisoRecusa[]) => void>();
export const aoRecusar = (f: (a: AvisoRecusa[]) => void) => {
  avisos.add(f);
  return () => void avisos.delete(f);
};

// ---------------------------------------------------------------------------------------------
// Estado persistido (_sync)
// ---------------------------------------------------------------------------------------------

export async function lerEstado(chave: string): Promise<string | null> {
  const db = await abrirBanco();
  const r = await db.query<{ valor: string }>(`select valor from public._sync where chave = $1`, [chave]);
  return r.rows[0]?.valor ?? null;
}
async function gravarEstado(chave: string, valor: string) {
  const db = await abrirBanco();
  await db.query(
    `insert into public._sync (chave, valor) values ($1, $2) on conflict (chave) do update set valor = excluded.valor`,
    [chave, valor],
  );
}

export async function contarFila(): Promise<{ pendentes: number; rejeitadas: number }> {
  const db = await abrirBanco();
  const r = await db.query<{ estado: string; n: number }>(`select estado, count(*)::int as n from public._outbox group by estado`);
  const n = (e: string) => r.rows.find((x) => x.estado === e)?.n ?? 0;
  return { pendentes: n('pendente'), rejeitadas: n('rejeitada') };
}

export interface ItemFilaEnvio {
  id: string;
  tipo: string;
  estado: 'pendente' | 'rejeitada';
  erro: string | null;
  criadoEm: Date;
  dados: Record<string, unknown>;
}
export async function listarFila(): Promise<ItemFilaEnvio[]> {
  const db = await abrirBanco();
  const r = await db.query<{ id: string; tipo: string; estado: 'pendente' | 'rejeitada'; erro: string | null; criado_em: Date; dados: Record<string, unknown> }>(
    `select id, tipo, estado, erro, criado_em, dados from public._outbox order by seq`,
  );
  return r.rows.map((x) => ({ id: x.id, tipo: x.tipo, estado: x.estado, erro: x.erro, criadoEm: new Date(x.criado_em), dados: x.dados }));
}

export async function descartarRejeitadas(ids?: string[]) {
  const db = await abrirBanco();
  if (ids?.length) await db.query(`delete from public._outbox where estado = 'rejeitada' and id = any($1::uuid[])`, [ids]);
  else await db.query(`delete from public._outbox where estado = 'rejeitada'`);
  await atualizarContadores();
}

async function atualizarContadores() {
  const c = await contarFila();
  mudar(c);
}

// ---------------------------------------------------------------------------------------------
// Enviar
// ---------------------------------------------------------------------------------------------

interface RespostaOp {
  id: string;
  ok: boolean;
  erro?: string;
  codigo?: string;
  tentar_de_novo?: boolean;
}

interface OpLocal {
  id: string;
  tipo: string;
  dados: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  ponto_id: string | null;
}

/** Desfaz no aparelho o efeito de uma ação que o servidor recusou (a cópia local não pode mentir). */
async function compensar(op: OpLocal): Promise<{ reler: string[]; tudo: boolean }> {
  const db = await abrirBanco();
  const reler: string[] = [];
  let tudo = false;
  await db.transaction(async (tx) => {
    await tx.exec(`set local session_replication_role = replica`);
    if (op.tipo === 'visita') {
      await tx.query(`delete from visitas where id = $1`, [op.dados.chave]);
    } else if (op.tipo === 'cadastro') {
      await tx.query(`delete from visitas where estabelecimento_id = $1`, [op.dados.id]);
      await tx.query(`delete from estabelecimentos where id = $1`, [op.dados.id]);
    } else if (op.tipo === 'atualizar_pontos') {
      reler.push(...((op.dados.ids as string[]) ?? []));
    } else if (['assumir', 'contato', 'localizacao'].includes(op.tipo)) {
      reler.push(op.dados.id);
    } else {
      tudo = true; // regra, raio, validar_visita
    }
  });
  return { reler, tudo };
}

async function enviarFila(): Promise<AvisoRecusa[]> {
  const t = transporteAtual();
  if (!t) return [];
  const db = await abrirBanco();
  const recusadas: AvisoRecusa[] = [];
  const reler = new Set<string>();
  const cadastrosRecusados = new Map<string, string>();
  let tudo = false;

  for (;;) {
    const lote = (
      await db.query<OpLocal>(`select id, tipo, dados, ponto_id from public._outbox where estado = 'pendente' order by seq limit 50`)
    ).rows;
    if (!lote.length) break;

    const resp = await t.rpc<RespostaOp[]>('sync_enviar', {
      p_ops: lote.map((o) => ({ id: o.id, tipo: o.tipo, dados: o.dados })),
    });
    const porId = new Map(resp.map((r) => [r.id, r]));
    let travou = false;

    for (const op of lote) {
      const r = porId.get(op.id);
      if (!r) { travou = true; continue; }
      if (r.ok) {
        await db.query(`delete from public._outbox where id = $1`, [op.id]);
      } else if (r.tentar_de_novo) {
        await db.query(`update public._outbox set tentativas = tentativas + 1, erro = $2 where id = $1`, [op.id, r.erro ?? null]);
        travou = true;
      } else {
        const c = await compensar(op);
        c.reler.forEach((x) => reler.add(x));
        tudo ||= c.tudo;
        const motivoCadastro = op.ponto_id ? cadastrosRecusados.get(op.ponto_id) : undefined;
        const erro = op.tipo !== 'cadastro' && motivoCadastro ? `Cliente não foi cadastrado: ${motivoCadastro}` : (r.erro ?? 'Recusado pelo servidor');
        await db.query(`update public._outbox set estado = 'rejeitada', erro = $2, codigo = $3 where id = $1`, [op.id, erro, r.codigo ?? null]);
        recusadas.push({ tipo: op.tipo, erro });
        if (op.tipo === 'cadastro') {
          // o que dependia deste cliente (visitas, localização...) não tem mais onde ser registrado
          cadastrosRecusados.set(op.dados.id, r.erro ?? 'recusado');
          await db.query(
            `update public._outbox set estado = 'rejeitada', erro = $2 where ponto_id = $1 and id <> $3 and estado = 'pendente'`,
            [op.dados.id, `Cliente não foi cadastrado: ${r.erro ?? 'recusado'}`, op.id],
          );
        }
      }
    }
    if (travou) break;
  }

  if (reler.size) await baixar({ ids: [...reler] });
  else if (tudo) await baixar({ completo: true });
  return recusadas;
}

// ---------------------------------------------------------------------------------------------
// Baixar
// ---------------------------------------------------------------------------------------------

const FOLGA_MS = 2 * 60_000; // transações longas no servidor podem confirmar "no passado": relê uma margem

export async function baixar(op: { completo?: boolean; ids?: string[] } = {}): Promise<void> {
  const t = transporteAtual();
  if (!t) return;
  const db = await abrirBanco();
  const cursor = op.completo || op.ids ? null : await lerEstado('cursor');
  const p: Record<string, unknown> = {};
  if (op.ids) {
    p.desde = '2999-01-01T00:00:00Z'; // só os ids pedidos
    p.ids = op.ids;
  } else {
    p.desde = cursor ? new Date(Date.parse(cursor) - FOLGA_MS).toISOString() : null;
  }
  const snap = await t.rpc<Snapshot>('sync_baixar', { p });
  await aplicarSnapshot(db, snap);
  if (!op.ids) {
    await gravarEstado('cursor', snap.agora);
    await gravarEstado('usuario', snap.eu);
  }
}

// ---------------------------------------------------------------------------------------------
// Orquestração
// ---------------------------------------------------------------------------------------------

let emVoo: Promise<void> | null = null;
let repetir = false;

export function sincronizar(opcoes: { completo?: boolean } = {}): Promise<void> {
  if (!modoReal() || !transporteAtual()) return Promise.resolve();
  if (emVoo) {
    repetir = true;
    return emVoo;
  }
  emVoo = (async () => {
    mudar({ ocupado: true });
    try {
      do {
        repetir = false;
        const recusadas = await enviarFila();
        await baixar({ completo: opcoes.completo });
        opcoes = {};
        mudar({ online: true, erro: null, precisaEntrar: false, ultimaSync: new Date() });
        if (recusadas.length) avisos.forEach((f) => f(recusadas));
      } while (repetir);
    } catch (e) {
      if (e instanceof ErroRede) mudar({ online: false });
      else if (e instanceof ErroAuth) mudar({ precisaEntrar: true });
      else mudar({ erro: e instanceof Error ? e.message : String(e) });
    } finally {
      await atualizarContadores();
      mudar({ ocupado: false });
      emVoo = null;
    }
  })();
  return emVoo;
}

let iniciado = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** Liga os gatilhos: voltou o sinal, app voltou ao primeiro plano, algo entrou na fila, a cada poucos minutos. */
export function iniciarMotor() {
  if (iniciado || typeof window === 'undefined') return;
  iniciado = true;
  const tentar = () => void sincronizar();
  window.addEventListener('online', () => { mudar({ online: true }); tentar(); });
  window.addEventListener('offline', () => mudar({ online: false }));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tentar());
  aoEnfileirar(tentar);
  timer = setInterval(() => document.visibilityState === 'visible' && tentar(), 3 * 60_000);
  void atualizarContadores().then(tentar);
}

export function pararMotor() {
  if (timer) clearInterval(timer);
  timer = null;
}
