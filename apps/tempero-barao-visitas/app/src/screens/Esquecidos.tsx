import { Link, useSearchParams } from 'react-router-dom';
import { esquecidos, type Semaforo } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { inteiro, quando, ROTULO_STATUS } from '../lib/formatar';
import { useSessao } from '../state/sessao';
import { Carregando, Rail, SemaforoBadge, Vazio } from '../ui/componentes';

export default function Esquecidos() {
  const { usuario, usuarios } = useSessao();
  const uid = usuario!.id;
  const [qs, setQs] = useSearchParams();
  const vendedor = qs.get('v') ?? '';
  const nivel = (qs.get('n') as Semaforo) || 'vermelho';
  const r = useAsync(() => esquecidos(uid, nivel, 500), [uid, nivel]);
  const lista = (r.dados ?? []).filter((e) => !vendedor || usuarios.find((u) => u.id === vendedor)?.nome === e.vendedor);
  const set = (k: string, v: string) => { const n = new URLSearchParams(qs); if (v) n.set(k, v); else n.delete(k); setQs(n, { replace: true }); };

  return (
    <div className="stack-lg">
      <div>
        <h1 className="h1">Atrasados e esquecidos</h1>
        <p className="muted small">Clientes que passaram do prazo da cadência. Ordenados por prioridade (peso da classe × atraso).</p>
      </div>
      <div className="stack">
        <div className="chips" role="group" aria-label="Gravidade">
          {([['amarelo', 'Atrasando ou pior'], ['vermelho', 'Crítico ou pior'], ['preto', 'Só esquecidos']] as const).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={nivel === k} onClick={() => set('n', k)}>{l}</button>
          ))}
        </div>
        {usuario!.papel !== 'vendedor' && (
          <select className="select" aria-label="Vendedor" value={vendedor} onChange={(e) => set('v', e.target.value)}>
            <option value="">Todos os vendedores</option>
            {usuarios.filter((u) => u.papel === 'vendedor').map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
          </select>
        )}
      </div>
      {r.carregando && !r.dados ? <Carregando /> : lista.length === 0 ? (
        <Vazio titulo="Nada atrasado neste filtro" texto="Quando algum cliente passar do prazo, ele aparece aqui." />
      ) : (
        <>
          <p className="small muted">{inteiro(lista.length)} ponto(s)</p>
          <div className="list">
            {lista.map((e) => (
              <Link key={e.id} to={`/ponto/${e.id}`} className="item row" style={{ textDecoration: 'none', color: 'inherit', alignItems: 'stretch' }}>
                <Rail s={e.semaforo} />
                <div className="grow">
                  <div className="row between"><span className="titulo">{e.nome}</span><span className="chip chip-tier">{e.tier}</span></div>
                  <p className="meta">{[e.vendedor ?? 'Sem vendedor', e.bairro, e.cidade].filter(Boolean).join(' · ')} · {ROTULO_STATUS[e.status]}</p>
                  <div className="row wrap" style={{ marginTop: 6, gap: 'var(--space-2)' }}>
                    <SemaforoBadge s={e.semaforo} />
                    <span className="small muted">{e.diasAtraso} dias de atraso · {e.nuncaVisitado ? 'nunca visitado' : `última visita ${quando(e.ultimaVisitaEm)}`}</span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
