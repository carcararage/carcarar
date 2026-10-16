import {
  BadgeCheck, CircleAlert, Ellipsis, FileText, Locate, LoaderCircle, MapPinOff, Package, Store, TriangleAlert,
  UserX, type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { registrarVisita, type ResultadoVisita } from '../db/api';
import { useLocalizacao } from '../hooks/useLocalizacao';
import { distanciaTexto, maisDias, ROTULO_RESULTADO } from '../lib/formatar';
import { Sheet } from '../ui/Sheet';
import { Campo } from '../ui/componentes';
import { useToast } from '../ui/toast';

const ICONE: Record<ResultadoVisita, LucideIcon> = {
  pedido: BadgeCheck,
  orcamento: FileText,
  sem_demanda: Package,
  decisor_ausente: UserX,
  reclamacao: TriangleAlert,
  fechado: Store,
  outro: Ellipsis,
};
const ORDEM: ResultadoVisita[] = ['pedido', 'orcamento', 'sem_demanda', 'decisor_ausente', 'reclamacao', 'fechado'];

export interface PontoVisita {
  id: string;
  nome: string;
  lat: number | null;
  lng: number | null;
}

function haversineM(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371000;
  const rad = (g: number) => (g * Math.PI) / 180;
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

interface Props {
  usuarioId: string;
  ponto: PontoVisita | null;
  onFechar: () => void;
  onSalvo: () => void;
}

export function VisitaSheet({ usuarioId, ponto, onFechar, onSalvo }: Props) {
  const toast = useToast();
  const { pos, status, pedir } = useLocalizacao();
  const [resultado, setResultado] = useState<ResultadoVisita | null>(null);
  const [valor, setValor] = useState('');
  const [proximo, setProximo] = useState('');
  const [retorno, setRetorno] = useState<string | null>(null);
  const [obs, setObs] = useState('');
  const [salvando, setSalvando] = useState(false);
  const checkin = useRef(new Date());
  const chave = useRef(crypto.randomUUID()); // reenvio não duplica

  useEffect(() => {
    if (!ponto) return;
    checkin.current = new Date(); // o check-in é quando a gaveta abre
    chave.current = crypto.randomUUID();
    setResultado(null); setValor(''); setProximo(''); setRetorno(null); setObs('');
    void pedir();
  }, [ponto?.id, pedir]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ponto) return null;
  const dist = pos && ponto.lat != null && ponto.lng != null ? haversineM(pos, { lat: ponto.lat, lng: ponto.lng }) : null;

  async function salvar() {
    if (!resultado || !ponto) return;
    setSalvando(true);
    try {
      const r = await registrarVisita(usuarioId, {
        chave: chave.current,
        estabelecimentoId: ponto.id,
        tipo: 'venda',
        checkinEm: checkin.current,
        checkoutEm: new Date(),
        gps: pos ? { lat: pos.lat, lng: pos.lng } : null,
        resultado,
        valorPedido: valor ? Number(valor.replace(/\./g, '').replace(',', '.')) : null,
        proximoPasso: proximo.trim() || null,
        retornoEm: retorno,
        observacao: obs.trim() || null,
      });
      if (r.validacao === 'confirmada') toast('ok', `Visita registrada em ${ponto.nome}. Cadência zerada.`);
      else toast('aviso', `Visita salva, mas ${r.validacao === 'fora_do_raio' ? `você estava a ${distanciaTexto(r.distanciaM)} do ponto` : r.validacao === 'sem_gps' ? 'sem localização' : 'ponto sem coordenadas'}. Aguarda validação da gestão.`);
      onSalvo();
      onFechar();
    } catch (e) {
      toast('erro', `Não foi possível salvar: ${e instanceof Error ? e.message : e}`);
    } finally {
      setSalvando(false);
    }
  }

  return (
    <Sheet
      aberto
      onFechar={onFechar}
      titulo={<>Registrar visita<span className="muted small" style={{ display: 'block', fontFamily: 'var(--font-ui)', fontWeight: 500 }}>{ponto.nome}</span></>}
      rodape={
        <button className="btn btn-primary btn-lg btn-block" disabled={!resultado || salvando} onClick={salvar}>
          {salvando ? <span className="spinner" /> : null} Salvar visita
        </button>
      }
    >
      <div className="stack-lg">
        <div className={`banner ${status === 'ok' && dist != null && dist <= 150 ? 'ok' : status === 'ok' ? '' : status === 'buscando' || status === 'idle' ? '' : 'perigo'}`}>
          {status === 'buscando' || status === 'idle' ? <LoaderCircle className="spinner-icon" size={20} /> : status === 'ok' ? <Locate size={20} /> : <MapPinOff size={20} />}
          <span>
            {status === 'buscando' || status === 'idle'
              ? 'Obtendo sua localização para confirmar o check-in…'
              : status === 'ok'
                ? dist != null
                  ? `Localização capturada. Você está a ~${distanciaTexto(dist)} do ponto${dist <= 150 ? ' — check-in confirmado.' : ' — fora do raio de check-in; a gestão precisará validar.'}`
                  : 'Localização capturada, mas este ponto não tem coordenadas cadastradas.'
                : 'Sem localização. A visita será salva, mas ficará aguardando validação da gestão.'}
            {(status === 'negado' || status === 'indisponivel') && (
              <> <button className="btn btn-sm btn-ghost" onClick={() => void pedir()}>Tentar de novo</button></>
            )}
          </span>
        </div>

        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ fontWeight: 650, fontSize: 'var(--text-sm)', marginBottom: 6 }}>Como foi a visita? *</legend>
          <div className="options">
            {ORDEM.map((r) => {
              const I = ICONE[r];
              return (
                <button key={r} type="button" className="option" aria-pressed={resultado === r} onClick={() => setResultado(r)}>
                  <I size={20} aria-hidden /> {ROTULO_RESULTADO[r]}
                </button>
              );
            })}
          </div>
        </fieldset>

        {(resultado === 'pedido' || resultado === 'orcamento') && (
          <Campo rotulo="Valor (R$)" dica="Opcional. Ajuda a medir a conversão das visitas.">
            <input className="input" inputMode="decimal" placeholder="0,00" value={valor} onChange={(e) => setValor(e.target.value)} />
          </Campo>
        )}

        <Campo rotulo="Próximo passo">
          <input className="input" placeholder="Ex.: levar amostra do alho em pasta" value={proximo} onChange={(e) => setProximo(e.target.value)} />
        </Campo>

        <Campo grupo rotulo="Voltar em" dica="O retorno combinado antecipa a próxima visita, nunca adia além do intervalo da cadência.">
          <div className="chips" style={{ margin: 0, padding: 0 }}>
            {[{ r: 'Amanhã', d: 1 }, { r: '7 dias', d: 7 }, { r: '15 dias', d: 15 }, { r: '30 dias', d: 30 }].map((o) => (
              <button key={o.d} type="button" className="chip" aria-pressed={retorno === maisDias(o.d)} onClick={() => setRetorno(retorno === maisDias(o.d) ? null : maisDias(o.d))}>
                {o.r}
              </button>
            ))}
          </div>
        </Campo>

        <Campo rotulo="Observação">
          <textarea className="textarea" placeholder="O que combinaram, objeções, concorrência…" value={obs} onChange={(e) => setObs(e.target.value)} />
        </Campo>

        <p className="hint" style={{ display: 'flex', gap: 6 }}>
          <CircleAlert size={14} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
          Sua localização é lida uma única vez, agora, só para confirmar o check-in. Não há rastreamento.
        </p>
      </div>
    </Sheet>
  );
}
