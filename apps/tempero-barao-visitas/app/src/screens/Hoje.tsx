import { CalendarCheck, Ghost, Locate, Plus, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useEffect, useMemo, useState } from 'react';
import mascote from '../brand/mascote.png';
import { fila, painelCobertura, totais, type ItemFila } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { useLocalizacao } from '../hooks/useLocalizacao';
import { dataExtensa, inteiro, primeiroNome, saudacao } from '../lib/formatar';
import { useSessao } from '../state/sessao';
import { Carregando, Kpi, Ring, Vazio } from '../ui/componentes';
import { CartaoFila } from './CartaoFila';
import { VisitaSheet } from './VisitaSheet';

type Janela = 'vencidos' | 'semana' | 'tudo';
const HORIZONTE: Record<Janela, number> = { vencidos: 0, semana: 7, tudo: 365 };

export default function Hoje() {
  const { usuario } = useSessao();
  const uid = usuario!.id;
  const { pos, status, pedir } = useLocalizacao();
  const [janela, setJanela] = useState<Janela>('vencidos');
  const [perto, setPerto] = useState(false);
  const [visita, setVisita] = useState<ItemFila | null>(null);

  const lista = useAsync(() => fila(uid, pos, HORIZONTE[janela], 120), [uid, janela, pos?.lat, pos?.lng]);
  const painel = useAsync(() => painelCobertura(uid), [uid]);
  const tot = useAsync(() => totais(uid), [uid]);

  // se não há nada vencido, mostra logo o que vem a seguir (a tela nunca nasce vazia sem motivo)
  const [auto, setAuto] = useState(true);
  useEffect(() => {
    if (auto && janela === 'vencidos' && lista.dados && lista.dados.length === 0) {
      setJanela('semana');
      setAuto(false);
    }
  }, [auto, janela, lista.dados]);

  const minha = painel.dados?.[0];
  const itens = useMemo(() => {
    const l = lista.dados ?? [];
    return perto && pos ? [...l].sort((a, b) => (a.distanciaM ?? 1e12) - (b.distanciaM ?? 1e12)) : l;
  }, [lista.dados, perto, pos]);

  function atualizar() {
    lista.recarregar();
    painel.recarregar();
    tot.recarregar();
  }

  return (
    <div className="stack-lg">
      <section className="hero" aria-label="Resumo do dia">
        <img className="mascote" src={mascote} alt="" />
        <div className="hero-conteudo">
          <div className="hero-titulo">
            <span className="eyebrow">{dataExtensa()}</span>
            <h1 className="hero-title">{saudacao()}, {primeiroNome(usuario!.nome)}!</h1>
          </div>
          <div className="row">
            <Ring pct={painel.dados ? (minha?.coberturaPct ?? 0) : null} />
            <div>
              <div className="strong">Cobertura da carteira</div>
              <div className="small" style={{ opacity: 0.8 }}>
                {minha ? `${inteiro(minha.emDia)} de ${inteiro(minha.pontos)} pontos em dia` : 'Sem pontos na carteira'}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bento" aria-label="Indicadores">
        <Kpi icone={TriangleAlert} valor={minha ? minha.atrasados + minha.criticos : '–'} rotulo="Atrasados" tom="alerta" />
        <Kpi icone={Ghost} valor={minha ? minha.esquecidos : '–'} rotulo="Esquecidos" tom="escuro" />
        <Kpi icone={CalendarCheck} valor={tot.dados?.visitasHoje ?? '–'} rotulo="Visitas hoje" />
        <Kpi icone={Locate} valor={tot.dados?.visitas30d ?? '–'} rotulo="Visitas em 30 dias" />
      </section>

      <section className="stack" aria-labelledby="fila-titulo">
        <div className="row between">
          <h2 id="fila-titulo" className="h2">Fila de visitas</h2>
          <Link to="/cadastrar" className="btn btn-soft btn-sm"><Plus size={16} aria-hidden /> Cliente</Link>
          <button
            className="chip"
            aria-pressed={perto}
            onClick={async () => {
              if (!pos) await pedir();
              setPerto((v) => !v);
            }}
          >
            <Locate size={16} aria-hidden /> {status === 'buscando' ? 'Localizando…' : 'Perto de mim'}
          </button>
        </div>
        <div className="chips" role="group" aria-label="Período">
          {([['vencidos', 'Vencidos'], ['semana', 'Próximos 7 dias'], ['tudo', 'Toda a carteira']] as const).map(([k, r]) => (
            <button key={k} className="chip" aria-pressed={janela === k} onClick={() => { setAuto(false); setJanela(k); }}>{r}</button>
          ))}
        </div>

        {lista.carregando && !lista.dados ? (
          <Carregando />
        ) : itens.length === 0 ? (
          <Vazio
            titulo={janela === 'vencidos' ? 'Tudo em dia por aqui!' : 'Nada por aqui'}
            texto={janela === 'vencidos' ? 'Nenhum cliente com visita vencida. Veja os próximos 7 dias ou explore o mapa para prospectar.' : 'Sua carteira está vazia neste período.'}
          />
        ) : (
          <div className="list">
            {itens.map((p) => (
              <CartaoFila key={p.id} p={p} onVisitar={setVisita} />
            ))}
          </div>
        )}
      </section>

      <VisitaSheet usuarioId={uid} ponto={visita} onFechar={() => setVisita(null)} onSalvo={atualizar} />
    </div>
  );
}
