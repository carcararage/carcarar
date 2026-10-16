import {
  ChevronLeft, Download, Locate, Lock, MapPin, MapPinOff, MessageCircle, Navigation, Pencil, Phone, Printer, TriangleAlert, UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { assumirPonto, atualizarPontos, definirLocalizacao, editarContato, ficha, resumoPonto, type Ficha, type StatusComercial } from '../db/api';
import { useLocalizacao } from '../hooks/useLocalizacao';
import { baixar, nomeSeguro, paraCsv } from '../lib/csv';
import { useAsync } from '../hooks/useAsync';
import {
  dataHoraCompleta, distanciaTexto, quando, soData, soHora, ROTULO_RESULTADO, ROTULO_SEGMENTO, ROTULO_STATUS, ROTULO_VALIDACAO, textoPrazo, brl,
} from '../lib/formatar';
import { ehCelular, linkRota, linkTel, linkWhats, linkWaze } from '../lib/links';
import { ehGestao, useSessao } from '../state/sessao';
import { Sheet } from '../ui/Sheet';
import { Campo, Carregando, SemaforoBadge, Vazio } from '../ui/componentes';
import { useToast } from '../ui/toast';
import { VisitaSheet } from './VisitaSheet';

export default function Ponto() {
  const { id } = useParams();
  const { usuario, usuarios, recarregar } = useSessao();
  const uid = usuario!.id;
  const gestao = ehGestao(usuario);
  const toast = useToast();
  const f = useAsync(() => ficha(uid, id!), [uid, id]);
  const [visitando, setVisitando] = useState(false);
  const [editando, setEditando] = useState(false);
  const [classificando, setClassificando] = useState(false);

  if (f.carregando && !f.dados) return <Carregando linhas={3} />;
  const p = f.dados;
  if (!p) return <PontoIndisponivel uid={uid} id={id!} />;

  const meu = p.vendedorId === uid;
  const semLocal = p.lat == null || p.lng == null;
  const livre = p.vendedorId == null && p.status !== 'perdido';
  const fone = p.celular ?? p.telefone;
  const c = p.cadencia;

  return (
    <div className="stack-lg">
      <div>
        <Link to={gestao ? '/pontos' : '/'} className="back"><ChevronLeft size={18} aria-hidden /> Voltar</Link>
        <h1 className="h1" style={{ marginTop: 'var(--space-1)' }}>{p.nome}</h1>
        <p className="muted small">{[p.bairro, p.cidade].filter(Boolean).join(' · ') || 'Endereço não informado'}</p>
        <div className="row wrap" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
          <span className="chip">{ROTULO_STATUS[p.status]}</span>
          <span className="chip chip-tier" style={{ minHeight: 32 }}>Classe {p.tier}</span>
          <span className="chip">{ROTULO_SEGMENTO[p.segmento]}</span>
          {p.vendedor && <span className="chip">{p.vendedor}</span>}
        </div>
      </div>

      {c ? (
        <div className={`banner ${c.semaforo === 'verde' ? 'ok' : c.semaforo === 'amarelo' ? '' : 'perigo'}`} style={c.semaforo === 'preto' ? { background: 'var(--sem-preto-bg)', color: 'var(--sem-preto-fg)' } : undefined}>
          <SemaforoBadge s={c.semaforo} />
          <span>
            <strong>{textoPrazo(c.diasAtraso)}.</strong>{' '}
            {c.nuncaVisitado ? 'Ainda sem nenhuma visita registrada.' : `Última visita ${quando(c.ultimaVisitaEm)}.`}{' '}
            Intervalo-alvo: {c.intervaloDias} dias.
          </span>
        </div>
      ) : (
        <div className="banner">
          <MapPin size={20} aria-hidden />
          <span>Este ponto está fora da cobrança de visitas ({ROTULO_STATUS[p.status].toLowerCase()}).{livre && ' Assuma-o para iniciar a prospecção.'}</span>
        </div>
      )}

      {semLocal && (meu || gestao) && <DefinirLocal uid={uid} id={p.id} onFeito={f.recarregar} />}

      {p.coordenadaSuspeita && (
        <div className="banner perigo">
          <TriangleAlert size={20} aria-hidden />
          <span>Localização removida na importação: {p.coordenadaSuspeita}. Corrija no mapa de origem e reimporte.</span>
        </div>
      )}

      <div>
        {livre && !gestao ? (
          <button className="btn btn-primary btn-lg btn-block" onClick={async () => {
            try { await assumirPonto(uid, p.id); toast('ok', `${p.nome} entrou na sua carteira.`); f.recarregar(); await recarregar(); }
            catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
          }}><UserPlus size={20} aria-hidden /> Assumir este ponto</button>
        ) : (meu || gestao) && p.status !== 'perdido' ? (
          <button className="btn btn-primary btn-lg btn-block" onClick={() => setVisitando(true)}><Locate size={20} aria-hidden /> Registrar visita</button>
        ) : null}
      </div>

      <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
        {p.lat != null && p.lng != null && (
          <>
            <a className="btn btn-ghost" href={linkRota(p.lat, p.lng)} target="_blank" rel="noreferrer"><Navigation size={18} aria-hidden /> Rota</a>
            <a className="btn btn-ghost" href={linkWaze(p.lat, p.lng)} target="_blank" rel="noreferrer">Waze</a>
          </>
        )}
        {fone && <a className="btn btn-ghost" href={linkTel(fone)}><Phone size={18} aria-hidden /> Ligar</a>}
        {ehCelular(fone) && <a className="btn btn-ghost" href={linkWhats(fone!)} target="_blank" rel="noreferrer"><MessageCircle size={18} aria-hidden /> WhatsApp</a>}
      </div>

      <div className="two-col">
        <section className="card stack" aria-labelledby="contato">
          <div className="row between">
            <h2 id="contato" className="card-title">Contato e endereço</h2>
            {(meu || gestao) && <button className="btn btn-ghost btn-sm" onClick={() => setEditando(true)}><Pencil size={14} aria-hidden /> Editar</button>}
          </div>
          <dl className="kv">
            <dt>Endereço</dt><dd>{p.endereco ?? '—'}</dd>
            <dt>Bairro / cidade</dt><dd>{[p.bairro, p.cidade, p.uf].filter(Boolean).join(' · ') || '—'}</dd>
            <dt>CEP</dt><dd>{p.cep ?? '—'}</dd>
            <dt>Telefone</dt><dd>{p.telefone ?? '—'}</dd>
            <dt>Celular</dt><dd>{p.celular ?? '—'}</dd>
            <dt>Contato</dt><dd>{p.contato ?? '—'}</dd>
            <dt>Região</dt><dd>{p.regiao ?? '—'}</dd>
          </dl>
          <hr className="divider" style={{ margin: 'var(--space-2) 0' }} />
          <h3 className="h3">Cadastro (ERP)</h3>
          <dl className="kv">
            <dt>Código</dt><dd>{p.codigoErp ?? '—'}</dd>
            <dt>Razão social</dt><dd>{p.razaoSocial ?? '—'}</dd>
            <dt>CNPJ</dt><dd>{p.cnpj ?? '—'}</dd>
          </dl>
          {p.observacoes && (<><hr className="divider" style={{ margin: 'var(--space-2) 0' }} /><h3 className="h3">Observações</h3><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{p.observacoes}</p></>)}
          {gestao && (
            <button className="btn btn-soft" onClick={() => setClassificando(true)}>Classificar (status, classe, segmento, vendedor)</button>
          )}
        </section>

        <section className="card stack" aria-labelledby="hist">
          <div className="row between wrap" style={{ gap: 'var(--space-2)' }}>
            <h2 id="hist" className="card-title">Relatório de visitas</h2>
            {p.visitas.length > 0 && (
              <div className="row no-print" style={{ gap: 'var(--space-2)' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => window.print()} aria-label="Imprimir relatório"><Printer size={14} aria-hidden /></button>
                <button className="btn btn-ghost btn-sm" onClick={() => exportar(p)}><Download size={14} aria-hidden /> CSV</button>
              </div>
            )}
          </div>
          {p.visitas.length === 0 ? (
            <p className="muted small">Nenhuma visita registrada ainda.</p>
          ) : (
            <ol className="timeline">
              {p.visitas.map((v) => (
                <li key={v.id}>
                  <div className="row between">
                    <strong className="small">{dataHoraCompleta(v.checkinEm)}</strong>
                    <span className={`sem ${v.validacao === 'confirmada' || v.validacao === 'validada_gestor' ? 'sem-verde' : 'sem-amarelo'}`}>{ROTULO_VALIDACAO[v.validacao]}</span>
                  </div>
                  <div className="small">{v.vendedor}{v.resultado ? ` · ${ROTULO_RESULTADO[v.resultado]}` : ''}{v.valorPedido ? ` · ${brl(v.valorPedido)}` : ''}</div>
                  {v.proximoPasso && <div className="small muted">Próximo passo: {v.proximoPasso}</div>}
                  {v.retornoEm && <div className="small muted">Retorno combinado: {new Date(v.retornoEm + 'T12:00').toLocaleDateString('pt-BR')}</div>}
                  {v.observacao && <div className="small muted">“{v.observacao}”</div>}
                  {v.distanciaM != null && <div className="xs subtle">Check-in a {distanciaTexto(v.distanciaM)} do ponto</div>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>

      {visitando && <VisitaSheet usuarioId={uid} ponto={{ id: p.id, nome: p.nome, lat: p.lat, lng: p.lng }} onFechar={() => setVisitando(false)} onSalvo={f.recarregar} />}
      {editando && <EditarContato p={p} onFechar={() => setEditando(false)} onSalvo={() => { setEditando(false); f.recarregar(); }} uid={uid} />}
      {classificando && (
        <Classificar p={p} onFechar={() => setClassificando(false)} uid={uid}
          vendedores={usuarios.filter((u) => u.papel === 'vendedor')}
          onSalvo={() => { setClassificando(false); f.recarregar(); }} />
      )}
    </div>
  );
}

function exportar(p: Ficha) {
  baixar(`visitas-${nomeSeguro(p.nome)}.csv`, paraCsv([
    ['Cliente', 'Código ERP', 'Data', 'Hora', 'Vendedor', 'Tipo', 'Resultado', 'Valor (R$)', 'Próximo passo', 'Retorno combinado', 'Observação', 'Validação', 'Distância do ponto (m)'],
    ...p.visitas.map((v) => [p.nome, p.codigoErp, soData(v.checkinEm), soHora(v.checkinEm), v.vendedor, v.tipo,
      v.resultado ? ROTULO_RESULTADO[v.resultado] : '', v.valorPedido?.toFixed(2).replace('.', ','), v.proximoPasso, v.retornoEm, v.observacao,
      ROTULO_VALIDACAO[v.validacao], v.distanciaM != null ? Math.round(v.distanciaM) : '']),
  ]));
}

/** Cliente que veio sem coordenada (ou com coordenada suspeita): o dono marca o ponto com o GPS, uma vez. */
function DefinirLocal({ uid, id, onFeito }: { uid: string; id: string; onFeito: () => void }) {
  const toast = useToast();
  const { status, pedir } = useLocalizacao();
  return (
    <div className="banner">
      <MapPinOff size={20} aria-hidden />
      <span className="grow">Este cliente está <strong>sem localização</strong>, então não aparece no mapa nem confirma check-in. Se você está no local, marque o ponto agora.</span>
      <button className="btn btn-dark btn-sm" disabled={status === 'buscando'} onClick={async () => {
        const pos = await pedir();
        if (!pos) { toast('erro', 'Não consegui sua localização. Permita o acesso à localização no navegador.'); return; }
        try { await definirLocalizacao(uid, id, pos.lat, pos.lng); toast('ok', 'Localização do cliente definida.'); onFeito(); }
        catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
      }}><Locate size={16} aria-hidden /> {status === 'buscando' ? 'Localizando…' : 'Definir aqui'}</button>
    </div>
  );
}

/** Ponto que existe mas não é do usuário: só o mínimo, "vinculado a outro vendedor". */
function PontoIndisponivel({ uid, id }: { uid: string; id: string }) {
  const r = useAsync(() => resumoPonto(uid, id), [uid, id]);
  if (r.carregando) return <Carregando linhas={1} />;
  const p = r.dados;
  if (!p) return <Vazio titulo="Ponto não encontrado" texto="Ele pode ter sido removido." acao={<Link className="btn btn-primary" to="/pontos">Ver pontos</Link>} />;
  return (
    <div className="stack-lg">
      <div>
        <Link to="/pontos" className="back"><ChevronLeft size={18} aria-hidden /> Voltar</Link>
        <h1 className="h1" style={{ marginTop: 'var(--space-1)' }}>{p.nome}</h1>
        <p className="muted small">{[p.bairro, p.cidade].filter(Boolean).join(' · ')}</p>
      </div>
      <div className="banner">
        <Lock size={20} aria-hidden />
        <span><strong>Vinculado a {p.vendedorNome ?? 'outro vendedor'}.</strong> Este cliente está na carteira de outro vendedor: você vê só o nome e o local, para não cadastrar nem visitar em duplicidade. Para qualquer mudança, fale com a gestão.</span>
      </div>
    </div>
  );
}

function EditarContato({ p, uid, onFechar, onSalvo }: { p: Ficha; uid: string; onFechar: () => void; onSalvo: () => void }) {
  const toast = useToast();
  const [d, setD] = useState({ telefone: p.telefone ?? '', celular: p.celular ?? '', contato: p.contato ?? '', observacoes: p.observacoes ?? '' });
  const set = (k: keyof typeof d) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  return (
    <Sheet aberto onFechar={onFechar} titulo="Editar contato"
      rodape={<button className="btn btn-primary btn-lg btn-block" onClick={async () => {
        try {
          await editarContato(uid, p.id, { telefone: d.telefone || null, celular: d.celular || null, contato: d.contato || null, observacoes: d.observacoes || null });
          toast('ok', 'Contato atualizado.'); onSalvo();
        } catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
      }}>Salvar</button>}>
      <div className="stack">
        <Campo rotulo="Telefone"><input className="input" inputMode="tel" value={d.telefone} onChange={set('telefone')} /></Campo>
        <Campo rotulo="Celular / WhatsApp"><input className="input" inputMode="tel" value={d.celular} onChange={set('celular')} /></Campo>
        <Campo rotulo="Pessoa de contato"><input className="input" value={d.contato} onChange={set('contato')} /></Campo>
        <Campo rotulo="Observações"><textarea className="textarea" value={d.observacoes} onChange={set('observacoes')} /></Campo>
      </div>
    </Sheet>
  );
}

function Classificar({ p, uid, vendedores, onFechar, onSalvo }: {
  p: Ficha; uid: string; vendedores: { id: string; nome: string }[]; onFechar: () => void; onSalvo: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState<StatusComercial>(p.status);
  const [tier, setTier] = useState(p.tier);
  const [segmento, setSegmento] = useState(p.segmento);
  const [vend, setVend] = useState(p.vendedorId ?? '');
  return (
    <Sheet aberto onFechar={onFechar} titulo="Classificar ponto"
      rodape={<button className="btn btn-primary btn-lg btn-block" onClick={async () => {
        try {
          await atualizarPontos(uid, [p.id], { status, tier, segmento, vendedorId: vend || null });
          toast('ok', 'Classificação salva.'); onSalvo();
        } catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
      }}>Salvar</button>}>
      <div className="stack">
        <Campo rotulo="Status" dica="Prospecto e perdido ficam fora da cobrança de visitas.">
          <select className="select" value={status} onChange={(e) => setStatus(e.target.value as StatusComercial)}>
            {Object.entries(ROTULO_STATUS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Classe" dica="A visita-se com mais frequência que C (ver Ajustes › Regras).">
          <select className="select" value={tier} onChange={(e) => setTier(e.target.value as 'A' | 'B' | 'C')}>
            <option value="A">A — estratégico</option><option value="B">B — regular</option><option value="C">C — básico</option>
          </select>
        </Campo>
        <Campo rotulo="Segmento">
          <select className="select" value={segmento} onChange={(e) => setSegmento(e.target.value)}>
            {Object.entries(ROTULO_SEGMENTO).map(([k, r]) => <option key={k} value={k}>{r}</option>)}
          </select>
        </Campo>
        <Campo rotulo="Vendedor responsável">
          <select className="select" value={vend} onChange={(e) => setVend(e.target.value)}>
            <option value="">Sem vendedor</option>
            {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
          </select>
        </Campo>
      </div>
    </Sheet>
  );
}
