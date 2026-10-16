import L from 'leaflet';
import { Crosshair, Locate, Navigation } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { pontosMapa, type PontoMapa, type Semaforo } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { useLocalizacao } from '../hooks/useLocalizacao';
import { ROTULO_SEGMENTO, ROTULO_SEMAFORO, ROTULO_STATUS, textoPrazo } from '../lib/formatar';
import { linkRota } from '../lib/links';
import { useSessao } from '../state/sessao';
import { SemaforoBadge, Vazio } from '../ui/componentes';

const COR: Record<Semaforo | 'livre', string> = {
  verde: '#2f9e57', amarelo: '#e8b100', vermelho: '#d03020', preto: '#1d1410', livre: '#3b82c4',
};
type Camada = Semaforo | 'livre';
const CAMADAS: Camada[] = ['preto', 'vermelho', 'amarelo', 'verde', 'livre'];
const ROTULO_CAMADA: Record<Camada, string> = { ...ROTULO_SEMAFORO, livre: 'Sem cadência' };

const tiles = (escuro: boolean) =>
  escuro
    ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
    : 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';

const camadaDe = (p: PontoMapa): Camada => p.semaforo ?? 'livre';
const mediana = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };

export default function Mapa() {
  const { usuario } = useSessao();
  const uid = usuario!.id;
  const dados = useAsync(() => pontosMapa(uid), [uid]);
  const { pos, status, pedir } = useLocalizacao();
  const el = useRef<HTMLDivElement>(null);
  const mapa = useRef<L.Map | null>(null);
  const grupo = useRef<L.LayerGroup | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const eu = useRef<L.CircleMarker | null>(null);
  const [ativas, setAtivas] = useState<Set<Camada>>(new Set(CAMADAS));
  const [sel, setSel] = useState<PontoMapa | null>(null);

  const visiveis = useMemo(() => (dados.dados ?? []).filter((p) => ativas.has(camadaDe(p))), [dados.dados, ativas]);
  const contagem = useMemo(() => {
    const c: Record<Camada, number> = { preto: 0, vermelho: 0, amarelo: 0, verde: 0, livre: 0 };
    for (const p of dados.dados ?? []) c[camadaDe(p)]++;
    return c;
  }, [dados.dados]);

  // cria o mapa uma vez
  useEffect(() => {
    if (!el.current || mapa.current) return;
    const m = L.map(el.current, { zoomControl: false, preferCanvas: true, attributionControl: true }).setView([-2.91, -41.76], 11);
    L.control.zoom({ position: 'bottomright' }).addTo(m);
    const escuro = document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
    tileRef.current = L.tileLayer(tiles(escuro), {
      maxZoom: 19, subdomains: 'abcd',
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · © <a href="https://carto.com/attributions">CARTO</a>',
    }).addTo(m);
    grupo.current = L.layerGroup().addTo(m);
    mapa.current = m;
    return () => { m.remove(); mapa.current = null; };
  }, []);

  // desenha os pontos
  useEffect(() => {
    const g = grupo.current;
    const m = mapa.current;
    if (!g || !m) return;
    g.clearLayers();
    for (const p of visiveis) {
      const c = camadaDe(p);
      L.circleMarker([p.lat, p.lng], {
        radius: c === 'preto' ? 8 : 7, weight: 2, color: c === 'preto' ? '#fcb400' : '#ffffff',
        fillColor: COR[c], fillOpacity: c === 'livre' ? 0.55 : 0.95,
      }).on('click', () => setSel(p)).addTo(g);
    }
  }, [visiveis]);

  // enquadra no centro da maioria dos pontos (ignora os distantes do interior no primeiro olhar)
  const enquadrar = (tudo = false) => {
    const m = mapa.current;
    const pts = dados.dados ?? [];
    if (!m || pts.length === 0) return;
    const lat = mediana(pts.map((p) => p.lat)); const lng = mediana(pts.map((p) => p.lng));
    const alvo = tudo ? pts : pts.filter((p) => Math.abs(p.lat - lat) < 0.35 && Math.abs(p.lng - lng) < 0.35);
    m.fitBounds(L.latLngBounds(alvo.map((p) => [p.lat, p.lng] as [number, number])), { padding: [40, 40], maxZoom: 15 });
  };
  useEffect(() => { enquadrar(); }, [dados.dados]); // eslint-disable-line react-hooks/exhaustive-deps

  // posição do usuário
  useEffect(() => {
    const m = mapa.current;
    if (!m || !pos) return;
    eu.current?.remove();
    eu.current = L.circleMarker([pos.lat, pos.lng], { radius: 9, weight: 3, color: '#fff', fillColor: '#2563eb', fillOpacity: 1 }).addTo(m);
    m.setView([pos.lat, pos.lng], Math.max(m.getZoom(), 14));
  }, [pos]);

  const alternar = (c: Camada) => setAtivas((s) => { const n = new Set(s); if (n.has(c)) n.delete(c); else n.add(c); return n; });

  if (dados.dados && dados.dados.length === 0) {
    return <Vazio titulo="Nenhum ponto com localização" texto="Importe o mapa do Google Earth (Gestão › Importar) para ver os pontos aqui." />;
  }

  return (
    <div className="stack">
      <div className="row between">
        <h1 className="h1">Mapa</h1>
        <div className="row" style={{ gap: 'var(--space-2)' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => enquadrar(true)}><Crosshair size={16} aria-hidden /> Ver tudo</button>
          <button className="btn btn-dark btn-sm" onClick={() => void pedir()}>
            <Locate size={16} aria-hidden /> {status === 'buscando' ? 'Localizando…' : 'Minha posição'}
          </button>
        </div>
      </div>
      <div className="mapa-wrap">
        <div ref={el} className="mapa" role="application" aria-label="Mapa dos pontos de venda" />
        <div className="mapa-ui" role="group" aria-label="Filtrar por situação">
          {CAMADAS.map((c) => (
            <button key={c} className="chip" aria-pressed={ativas.has(c)} onClick={() => alternar(c)}>
              <span className="dot" style={{ ['--dot' as string]: COR[c] }} /> {ROTULO_CAMADA[c]} <strong>{contagem[c]}</strong>
            </button>
          ))}
        </div>
        {sel && (
          <div className="card mapa-card stack" style={{ gap: 'var(--space-2)' }}>
            <div className="row between">
              <strong>{sel.nome}</strong>
              <button className="btn btn-ghost btn-sm" onClick={() => setSel(null)} aria-label="Fechar">✕</button>
            </div>
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              <SemaforoBadge s={sel.semaforo} />
              <span className="small muted">{sel.diasAtraso != null ? textoPrazo(sel.diasAtraso) : ROTULO_STATUS[sel.status]} · {ROTULO_SEGMENTO[sel.segmento]} · Classe {sel.tier}</span>
            </div>
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <Link className="btn btn-primary btn-sm grow" to={`/ponto/${sel.id}`}>Abrir ficha</Link>
              <a className="btn btn-ghost btn-sm" href={linkRota(sel.lat, sel.lng)} target="_blank" rel="noreferrer"><Navigation size={16} aria-hidden /> Rota</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
