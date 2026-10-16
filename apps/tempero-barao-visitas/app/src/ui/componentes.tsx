import { CircleCheck, Clock, Ghost, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useId, type CSSProperties, type ReactNode } from 'react';
import mascote from '../brand/mascote.png';
import type { Semaforo } from '../db/api';
import { iniciais, ROTULO_SEMAFORO } from '../lib/formatar';

const ICONE_SEM: Record<Semaforo, LucideIcon> = {
  verde: CircleCheck,
  amarelo: Clock,
  vermelho: TriangleAlert,
  preto: Ghost,
};

/** Semáforo: cor + ícone + texto (nunca só cor). */
export function SemaforoBadge({ s, texto }: { s: Semaforo | null; texto?: string }) {
  if (!s) return <span className="sem sem-none">Sem cadência</span>;
  const I = ICONE_SEM[s];
  return (
    <span className={`sem sem-${s}`}>
      <I aria-hidden />
      {texto ?? ROTULO_SEMAFORO[s]}
    </span>
  );
}

export const COR_SEMAFORO: Record<Semaforo, string> = {
  verde: 'var(--sem-verde)',
  amarelo: 'var(--sem-amarelo)',
  vermelho: 'var(--sem-vermelho)',
  preto: 'var(--sem-preto)',
};

export function Rail({ s }: { s: Semaforo | null }) {
  return <span className="rail" style={{ '--rail': s ? COR_SEMAFORO[s] : undefined } as CSSProperties} aria-hidden />;
}

export function Avatar({ nome, grande }: { nome: string; grande?: boolean }) {
  return <span className={`avatar${grande ? ' lg' : ''}`} aria-hidden>{iniciais(nome)}</span>;
}

export function Ring({ pct, tamanho = 92, buraco }: { pct: number | null; tamanho?: number; buraco?: string }) {
  return (
    <div
      className="ring"
      role="img"
      aria-label={pct == null ? 'Carregando' : `${Math.round(pct)}%`}
      style={{ '--p': Math.max(0, Math.min(100, pct ?? 0)), '--size': `${tamanho}px`, ...(buraco ? { '--ring-hole': buraco } : {}) } as CSSProperties}
    >
      <span>{pct == null ? '…' : `${Math.round(pct)}%`}</span>
    </div>
  );
}

export function StackBar({ v, a, r, p }: { v: number; a: number; r: number; p: number }) {
  const t = v + a + r + p || 1;
  const w = (n: number) => ({ flexGrow: n / t, flexBasis: 0 }) as CSSProperties;
  return (
    <div className="stackbar" role="img" aria-label={`Em dia ${v}, atrasando ${a}, crítico ${r}, esquecido ${p}`}>
      {v > 0 && <i className="v" style={w(v)} />}
      {a > 0 && <i className="a" style={w(a)} />}
      {r > 0 && <i className="r" style={w(r)} />}
      {p > 0 && <i className="p" style={w(p)} />}
    </div>
  );
}

export function Vazio({ titulo, texto, acao }: { titulo: string; texto?: string; acao?: ReactNode }) {
  return (
    <div className="empty">
      <img src={mascote} alt="" />
      <h2 className="h3" style={{ color: 'var(--text)' }}>{titulo}</h2>
      {texto && <p className="small" style={{ maxWidth: 360 }}>{texto}</p>}
      {acao}
    </div>
  );
}

export function Carregando({ linhas = 4 }: { linhas?: number }) {
  return (
    <div className="list" role="status" aria-busy="true" aria-label="Carregando">
      {Array.from({ length: linhas }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 96, borderRadius: 20 }} />
      ))}
    </div>
  );
}

/** Campo rotulado. `grupo` para conjuntos de botões (chips); senão usa <label> real (nome acessível). */
export function Campo({ rotulo, dica, grupo, children }: { rotulo: string; dica?: string; grupo?: boolean; children: ReactNode }) {
  const id = useId();
  if (grupo) {
    return (
      <div className="field" role="group" aria-labelledby={id}>
        <span id={id} className="label">{rotulo}</span>
        {children}
        {dica && <span className="hint">{dica}</span>}
      </div>
    );
  }
  return (
    <label className="field">
      <span className="label">{rotulo}</span>
      {children}
      {dica && <span className="hint">{dica}</span>}
    </label>
  );
}

export function Kpi({
  icone: I, valor, rotulo, tom,
}: { icone: LucideIcon; valor: ReactNode; rotulo: string; tom?: 'alerta' | 'escuro' }) {
  return (
    <div className={`kpi${tom ? ` ${tom}` : ''}`}>
      <span className="icone"><I size={20} aria-hidden /></span>
      <span className="valor">{valor}</span>
      <span className="rotulo">{rotulo}</span>
    </div>
  );
}
