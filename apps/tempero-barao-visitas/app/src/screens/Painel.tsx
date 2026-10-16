import { CalendarCheck, CircleCheck, Ghost, MapPinOff, Store, UserX } from 'lucide-react';
import { Link } from 'react-router-dom';
import mascote from '../brand/mascote.png';
import { esquecidos, painelCobertura, totais, validarVisita, visitasParaValidar } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { dataExtensa, dataHora, distanciaTexto, inteiro, primeiroNome, quando, ROTULO_STATUS, ROTULO_VALIDACAO, saudacao } from '../lib/formatar';
import { useSessao } from '../state/sessao';
import { Carregando, Kpi, Ring, SemaforoBadge, StackBar, Vazio } from '../ui/componentes';
import { useToast } from '../ui/toast';

export default function Painel() {
  const { usuario, pontos } = useSessao();
  const uid = usuario!.id;
  const toast = useToast();
  const cob = useAsync(() => painelCobertura(uid), [uid, pontos]);
  const tot = useAsync(() => totais(uid), [uid, pontos]);
  const esq = useAsync(() => esquecidos(uid, 'preto', 6), [uid, pontos]);
  const val = useAsync(() => visitasParaValidar(uid), [uid, pontos]);

  if (pontos === 0) {
    return (
      <Vazio titulo="Vamos começar pelo mapa" texto="Importe o arquivo KML/KMZ exportado do Google Earth. O sistema reconhece pastas, vendedores, bairros e o cadastro do ERP."
        acao={<Link className="btn btn-primary btn-lg" to="/importar">Importar mapa do Google Earth</Link>} />
    );
  }

  const linhas = cob.dados ?? [];
  const soma = linhas.reduce((a, l) => ({ p: a.p + l.pontos, v: a.v + l.emDia, a: a.a + l.atrasados, r: a.r + l.criticos, e: a.e + l.esquecidos, n: a.n + l.nuncaVisitados }), { p: 0, v: 0, a: 0, r: 0, e: 0, n: 0 });
  const pct = !cob.dados ? null : soma.p ? (100 * soma.v) / soma.p : 0;
  const t = tot.dados;

  return (
    <div className="stack-lg">
      <section className="hero" aria-label="Cobertura geral">
        <img className="mascote" src={mascote} alt="" />
        <div className="hero-conteudo">
          <div className="hero-titulo">
            <span className="eyebrow">{dataExtensa()}</span>
            <h1 className="hero-title">{saudacao()}, {primeiroNome(usuario!.nome)}.</h1>
          </div>
          <div className="row">
            <Ring pct={pct} tamanho={104} />
            <div>
              <div className="strong">Cobertura da carteira</div>
              <div className="small" style={{ opacity: 0.8 }}>{cob.dados ? `${inteiro(soma.v)} de ${inteiro(soma.p)} pontos visitados dentro do prazo` : 'Calculando…'}</div>
            </div>
          </div>
        </div>
      </section>

      <section className="bento" aria-label="Indicadores">
        <Kpi icone={Store} valor={t ? inteiro(t.pontos) : '–'} rotulo="Pontos na base" />
        <Kpi icone={Ghost} valor={inteiro(soma.e)} rotulo="Esquecidos" tom="escuro" />
        <Kpi icone={CalendarCheck} valor={t?.visitasHoje ?? '–'} rotulo="Visitas hoje" />
        <Kpi icone={CircleCheck} valor={t?.visitas30d ?? '–'} rotulo="Visitas em 30 dias" />
      </section>

      {t && (t.semCoordenada > 0 || t.semDono > 0) && (
        <section className="stack" aria-label="Pendências da base">
          {t.semDono > 0 && (
            <Link className="banner perigo" to="/pontos" style={{ textDecoration: 'none' }}>
              <UserX size={20} aria-hidden />
              <span><strong>{inteiro(t.semDono)} ponto(s) na cobrança sem vendedor.</strong> Ninguém está visitando — atribua uma carteira.</span>
            </Link>
          )}
          {t.semCoordenada > 0 && (
            <Link className="banner" to="/pontos" style={{ textDecoration: 'none' }}>
              <MapPinOff size={20} aria-hidden />
              <span><strong>{inteiro(t.semCoordenada)} ponto(s) sem localização.</strong> Não aparecem no mapa nem confirmam check-in; corrija no Google Earth e reimporte.</span>
            </Link>
          )}
        </section>
      )}

      <div className="two-col">
        <section className="stack" aria-labelledby="porv">
          <h2 id="porv" className="h2">Cobertura por vendedor</h2>
          {cob.carregando && !cob.dados ? <Carregando linhas={2} /> : linhas.length === 0 ? (
            <p className="muted small">Nenhum ponto em cobrança ainda.</p>
          ) : (
            <div className="list">
              {linhas.map((l) => (
                <div key={l.vendedorId ?? 'sem'} className="item stack">
                  <div className="row between">
                    <span className="titulo">{l.vendedor}</span>
                    <span className="num" style={{ fontSize: 'var(--text-xl)' }}>{Math.round(l.coberturaPct)}%</span>
                  </div>
                  <StackBar v={l.emDia} a={l.atrasados} r={l.criticos} p={l.esquecidos} />
                  <div className="row wrap small muted" style={{ gap: 'var(--space-3)' }}>
                    <span>{inteiro(l.pontos)} pontos</span>
                    <span>{inteiro(l.emDia)} em dia</span>
                    <span>{inteiro(l.atrasados + l.criticos)} atrasados</span>
                    <span>{inteiro(l.esquecidos)} esquecidos</span>
                    <span>{inteiro(l.nuncaVisitados)} nunca visitados</span>
                  </div>
                  <Link className="btn btn-soft btn-sm" style={{ alignSelf: 'flex-start' }} to={l.vendedorId ? `/esquecidos?v=${l.vendedorId}` : '/esquecidos'}>Ver atrasados</Link>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="stack" aria-labelledby="atencao">
          <div className="row between">
            <h2 id="atencao" className="h2">Esquecidos agora</h2>
            <Link to="/esquecidos" className="small strong">Ver todos</Link>
          </div>
          {esq.dados?.length === 0 ? (
            <div className="banner ok"><CircleCheck size={20} aria-hidden /> Nenhum cliente esquecido. Boa!</div>
          ) : (
            <div className="list">
              {(esq.dados ?? []).map((e) => (
                <Link key={e.id} to={`/ponto/${e.id}`} className="item" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="row between"><span className="titulo">{e.nome}</span><span className="chip chip-tier">{e.tier}</span></div>
                  <p className="meta">{e.vendedor ?? 'Sem vendedor'} · {ROTULO_STATUS[e.status]}</p>
                  <div className="row" style={{ marginTop: 6, gap: 'var(--space-2)' }}>
                    <SemaforoBadge s={e.semaforo} />
                    <span className="small muted">{e.nuncaVisitado ? 'nunca visitado' : `última visita ${quando(e.ultimaVisitaEm)}`} · {e.diasAtraso} dias de atraso</span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>

      {val.dados && val.dados.length > 0 && (
        <section className="stack" aria-labelledby="validar">
          <h2 id="validar" className="h2">Visitas a validar <span className="badge">{val.dados.length}</span></h2>
          <p className="small muted">Check-ins fora do raio ou sem GPS não zeram a cadência até você validar.</p>
          <div className="list">
            {val.dados.slice(0, 8).map((v) => (
              <div key={v.id} className="item row">
                <div className="grow">
                  <Link to={`/ponto/${v.pontoId}`} className="titulo" style={{ color: 'inherit', textDecoration: 'none' }}>{v.ponto}</Link>
                  <p className="meta">{v.vendedor} · {dataHora(v.checkinEm)} · {ROTULO_VALIDACAO[v.validacao]}{v.distanciaM != null ? ` (${distanciaTexto(v.distanciaM)})` : ''}</p>
                </div>
                <button className="btn btn-dark btn-sm" onClick={async () => {
                  await validarVisita(uid, v.id); toast('ok', 'Visita validada.'); val.recarregar(); cob.recarregar();
                }}>Validar</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {t && (
        <section className="stack" aria-labelledby="base">
          <h2 id="base" className="h2">A base por status</h2>
          <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
            {(Object.keys(t.porStatus) as (keyof typeof t.porStatus)[]).map((s) => (
              <span key={s} className="chip">{ROTULO_STATUS[s]}: <strong>{inteiro(t.porStatus[s])}</strong></span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
