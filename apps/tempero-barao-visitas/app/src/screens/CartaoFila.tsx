import { MessageCircle, Navigation, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { ItemFila } from '../db/api';
import { distanciaTexto, ROTULO_SEGMENTO, textoPrazo } from '../lib/formatar';
import { ehCelular, linkRota, linkTel, linkWhats } from '../lib/links';
import { Rail, SemaforoBadge } from '../ui/componentes';

export function CartaoFila({ p, onVisitar }: { p: ItemFila; onVisitar: (p: ItemFila) => void }) {
  const fone = p.celular ?? p.telefone;
  const dist = distanciaTexto(p.distanciaM);
  return (
    <article className="item" style={{ display: 'flex', gap: 'var(--space-3)' }}>
      <Rail s={p.semaforo} />
      <div className="grow">
        <div className="row between" style={{ alignItems: 'flex-start' }}>
          <Link to={`/ponto/${p.id}`} className="titulo" style={{ color: 'inherit', textDecoration: 'none' }}>
            {p.nome}
          </Link>
          <span className="chip chip-tier" title={`Classe ${p.tier}`}>{p.tier}</span>
        </div>
        <p className="meta ellipsis">
          {[p.bairro, p.cidade, ROTULO_SEGMENTO[p.segmento]].filter(Boolean).join(' · ')}
        </p>
        <div className="row wrap" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
          <SemaforoBadge s={p.semaforo} texto={p.nuncaVisitado && p.diasAtraso <= 0 ? 'Nunca visitado' : undefined} />
          <span className="small muted">{textoPrazo(p.diasAtraso)}</span>
          {dist && <span className="small strong">· {dist}</span>}
        </div>
        <div className="item-actions">
          {p.lat != null && p.lng != null && (
            <a className="btn btn-ghost btn-icon btn-sm" style={{ width: 40 }} href={linkRota(p.lat, p.lng)} target="_blank" rel="noreferrer" aria-label={`Rota até ${p.nome}`}>
              <Navigation size={18} />
            </a>
          )}
          {fone && (
            <a className="btn btn-ghost btn-icon btn-sm" style={{ width: 40 }} href={linkTel(fone)} aria-label={`Ligar para ${p.nome}`}>
              <Phone size={18} />
            </a>
          )}
          {ehCelular(fone) && (
            <a className="btn btn-ghost btn-icon btn-sm" style={{ width: 40 }} href={linkWhats(fone!)} target="_blank" rel="noreferrer" aria-label={`WhatsApp de ${p.nome}`}>
              <MessageCircle size={18} />
            </a>
          )}
          <span className="spacer" />
          <button className="btn btn-primary btn-sm" onClick={() => onVisitar(p)}>Registrar visita</button>
        </div>
      </div>
    </article>
  );
}
