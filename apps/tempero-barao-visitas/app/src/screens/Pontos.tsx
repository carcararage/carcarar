import { Lock, Plus, Search, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  assumirPonto, atualizarPontos, listarPontos, listarPontosVisiveis, type Escopo, type FiltroCarteira, type StatusComercial,
} from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { inteiro, ROTULO_SEGMENTO, ROTULO_STATUS } from '../lib/formatar';
import { ehGestao, useSessao } from '../state/sessao';
import { Sheet } from '../ui/Sheet';
import { Campo, Carregando, SemaforoBadge, Vazio } from '../ui/componentes';
import { useToast } from '../ui/toast';

export default function Pontos() {
  const { usuario } = useSessao();
  return ehGestao(usuario) ? <PontosGestao /> : <PontosVendedor />;
}

function CabecalhoPontos({ sub }: { sub: string }) {
  return (
    <div className="row between">
      <div>
        <h1 className="h1">Pontos</h1>
        <p className="muted small">{sub}</p>
      </div>
      <Link to="/cadastrar" className="btn btn-primary btn-sm"><Plus size={16} aria-hidden /> Cadastrar cliente</Link>
    </div>
  );
}

/** Vendedor: vê os dele e os livres em detalhe; os dos colegas aparecem só como "vinculado a …". */
function PontosVendedor() {
  const { usuario, recarregar } = useSessao();
  const uid = usuario!.id;
  const toast = useToast();
  const [busca, setBusca] = useState('');
  const [escopo, setEscopo] = useState<Escopo>('todos');
  const [segmento, setSegmento] = useState('');
  const [limite, setLimite] = useState(150);
  const r = useAsync(() => listarPontosVisiveis(uid, { busca: busca.trim(), escopo, segmento, limite }), [uid, busca, escopo, segmento, limite]);
  const aplicar = (fn: () => void) => { setLimite(150); fn(); };

  return (
    <div className="stack-lg">
      <CabecalhoPontos sub="Sua carteira, os pontos livres para prospectar e os clientes dos colegas (só para você saber que já têm dono)." />
      <div className="stack">
        <div className="search">
          <Search size={18} aria-hidden />
          <input className="input" type="search" placeholder="Buscar nome ou bairro" aria-label="Buscar pontos" value={busca} onChange={(e) => aplicar(() => setBusca(e.target.value))} />
        </div>
        <div className="chips" role="group" aria-label="Quais pontos">
          {([['todos', 'Todos'], ['meus', 'Meus clientes'], ['livres', 'Livres'], ['outros', 'De outros vendedores']] as [Escopo, string][]).map(([k, l]) => (
            <button key={k} className="chip" aria-pressed={escopo === k} onClick={() => aplicar(() => setEscopo(k))}>{l}</button>
          ))}
        </div>
        <select className="select" aria-label="Segmento" value={segmento} onChange={(e) => aplicar(() => setSegmento(e.target.value))}>
          <option value="">Todos os segmentos</option>
          {Object.entries(ROTULO_SEGMENTO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </div>

      {r.carregando && !r.dados ? <Carregando /> : !r.dados || r.dados.itens.length === 0 ? (
        <Vazio titulo="Nenhum ponto encontrado" texto="Ajuste a busca ou cadastre o cliente." acao={<Link to="/cadastrar" className="btn btn-primary">Cadastrar cliente</Link>} />
      ) : (
        <>
          <p className="small muted">{inteiro(r.dados.total)} ponto(s){r.dados.total > r.dados.itens.length ? ` · mostrando ${r.dados.itens.length}` : ''}</p>
          <div className="list">
            {r.dados.itens.map((p) => {
              const outro = !p.meu && !p.livre;
              const meta = [p.bairro, p.cidade, ROTULO_SEGMENTO[p.segmento]].filter(Boolean).join(' · ');
              if (outro) {
                return (
                  <div key={p.id} className="item" style={{ opacity: 0.8 }} aria-label={`${p.nome}, vinculado a ${p.vendedorNome}`}>
                    <div className="titulo">{p.nome}</div>
                    <p className="meta ellipsis">{meta}</p>
                    <div className="row" style={{ marginTop: 6, gap: 'var(--space-2)' }}><span className="chip"><Lock size={14} aria-hidden /> Vinculado a {p.vendedorNome ?? 'outro vendedor'}</span></div>
                  </div>
                );
              }
              return (
                <div key={p.id} className="item row" style={{ alignItems: 'flex-start' }}>
                  <Link to={`/ponto/${p.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
                    <div className="row between" style={{ alignItems: 'flex-start' }}>
                      <span className="titulo">{p.nome}</span>
                      {p.tier && <span className="chip chip-tier">{p.tier}</span>}
                    </div>
                    <p className="meta ellipsis">{meta}</p>
                    <div className="row wrap" style={{ gap: 'var(--space-2)', marginTop: 6 }}>
                      {p.status && <span className="chip">{ROTULO_STATUS[p.status]}</span>}
                      {p.meu ? <SemaforoBadge s={p.semaforo} /> : <span className="chip">Livre</span>}
                      {!p.temCoordenada && <span className="sem sem-vermelho">Sem localização</span>}
                    </div>
                  </Link>
                  {p.livre && (
                    <button className="btn btn-primary btn-sm" onClick={async () => {
                      try { await assumirPonto(uid, p.id); toast('ok', `${p.nome} entrou na sua carteira.`); r.recarregar(); await recarregar(); }
                      catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
                    }}><UserPlus size={16} aria-hidden /> Assumir</button>
                  )}
                </div>
              );
            })}
          </div>
          {r.dados.total > r.dados.itens.length && (
            <button className="btn btn-ghost" style={{ alignSelf: 'center' }} onClick={() => setLimite((n) => n + 150)}>Mostrar mais ({inteiro(r.dados.total - r.dados.itens.length)} restantes)</button>
          )}
        </>
      )}
    </div>
  );
}

function PontosGestao() {
  const { usuario, usuarios, recarregar } = useSessao();
  const uid = usuario!.id;
  const gestao = ehGestao(usuario);
  const toast = useToast();
  const [busca, setBusca] = useState('');
  const [status, setStatus] = useState<StatusComercial | ''>('');
  const [vendedorId, setVendedorId] = useState('');
  const [segmento, setSegmento] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [lote, setLote] = useState(false);

  const filtro: FiltroCarteira = useMemo(() => ({ busca: busca.trim(), status, vendedorId, segmento }), [busca, status, vendedorId, segmento]);
  const [limite, setLimite] = useState(150);
  const r = useAsync(() => listarPontos(uid, { ...filtro, limite }), [uid, filtro, limite]);
  const vendedores = usuarios.filter((u) => u.papel === 'vendedor');

  const alternar = (id: string) => setSel((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  async function selecionarTodos() {
    const todos = await listarPontos(uid, { ...filtro, limite: 10000 });
    setSel(new Set(todos.itens.map((i) => i.id)));
  }

  return (
    <div className="stack-lg">
      <CabecalhoPontos sub="Toda a base: importada do Google Earth, de planilhas ou cadastrada no app." />

      <div className="stack">
        <div className="search">
          <Search size={18} aria-hidden />
          <input className="input" type="search" placeholder="Buscar nome, bairro ou código" aria-label="Buscar pontos" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
        <div className="chips" role="group" aria-label="Status">
          <button className="chip" aria-pressed={status === ''} onClick={() => setStatus('')}>Todos</button>
          {(['ativo', 'inativo', 'em_prospeccao', 'prospecto'] as const).map((s) => (
            <button key={s} className="chip" aria-pressed={status === s} onClick={() => setStatus(s)}>{ROTULO_STATUS[s]}</button>
          ))}
        </div>
        <div className="grid-fluid">
          {gestao && (
            <select className="select" aria-label="Vendedor" value={vendedorId} onChange={(e) => setVendedorId(e.target.value)}>
              <option value="">Todos os vendedores</option>
              <option value="sem">Sem vendedor</option>
              {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
            </select>
          )}
          <select className="select" aria-label="Segmento" value={segmento} onChange={(e) => setSegmento(e.target.value)}>
            <option value="">Todos os segmentos</option>
            {Object.entries(ROTULO_SEGMENTO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>

      {gestao && sel.size > 0 && (
        <div className="banner" style={{ position: 'sticky', top: 8, zIndex: 20 }}>
          <span className="grow"><strong>{inteiro(sel.size)}</strong> selecionado(s)</span>
          <button className="btn btn-sm btn-ghost" onClick={() => setSel(new Set())}>Limpar</button>
          <button className="btn btn-sm btn-dark" onClick={() => setLote(true)}>Editar em lote</button>
        </div>
      )}

      {r.carregando && !r.dados ? <Carregando /> : !r.dados || r.dados.itens.length === 0 ? (
        <Vazio titulo="Nenhum ponto encontrado" texto="Ajuste a busca ou os filtros." />
      ) : (
        <>
          <div className="row between small muted">
            <span>{inteiro(r.dados.total)} ponto(s){r.dados.total > r.dados.itens.length ? ` · mostrando ${r.dados.itens.length}` : ''}</span>
            {gestao && <button className="btn btn-sm btn-ghost" onClick={selecionarTodos}>Selecionar todos os {inteiro(r.dados.total)}</button>}
          </div>
          <div className="list">
            {r.dados.itens.map((p) => (
              <div key={p.id} className="item row" style={{ alignItems: 'flex-start' }}>
                {gestao && <input className="check" type="checkbox" aria-label={`Selecionar ${p.nome}`} checked={sel.has(p.id)} onChange={() => alternar(p.id)} style={{ marginTop: 2 }} />}
                <Link to={`/ponto/${p.id}`} className="grow" style={{ color: 'inherit', textDecoration: 'none' }}>
                  <div className="row between" style={{ alignItems: 'flex-start' }}>
                    <span className="titulo">{p.nome}</span>
                    <span className="chip chip-tier">{p.tier}</span>
                  </div>
                  <p className="meta ellipsis">{[p.bairro, p.cidade, ROTULO_SEGMENTO[p.segmento]].filter(Boolean).join(' · ')}</p>
                  <div className="row wrap" style={{ gap: 'var(--space-2)', marginTop: 6 }}>
                    <span className="chip">{ROTULO_STATUS[p.status]}</span>
                    <SemaforoBadge s={p.semaforo} />
                    {gestao && <span className="small muted">{p.vendedor ?? 'Sem vendedor'}</span>}
                    {!p.temCoordenada && <span className="sem sem-vermelho">Sem localização</span>}
                  </div>
                </Link>
                {!gestao && p.vendedorId == null && p.status !== 'perdido' && (
                  <button className="btn btn-primary btn-sm" onClick={async () => {
                    try { await assumirPonto(uid, p.id); toast('ok', `${p.nome} entrou na sua carteira.`); r.recarregar(); await recarregar(); }
                    catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
                  }}><UserPlus size={16} aria-hidden /> Assumir</button>
                )}
              </div>
            ))}
          </div>
          {r.dados.total > r.dados.itens.length && (
            <button className="btn btn-ghost" style={{ alignSelf: 'center' }} onClick={() => setLimite((n) => n + 150)}>Mostrar mais ({inteiro(r.dados.total - r.dados.itens.length)} restantes)</button>
          )}
        </>
      )}

      {lote && <EdicaoLote uid={uid} ids={[...sel]} vendedores={vendedores} onFechar={() => setLote(false)} onSalvo={() => { setLote(false); setSel(new Set()); r.recarregar(); }} />}
    </div>
  );
}

function EdicaoLote({ uid, ids, vendedores, onFechar, onSalvo }: {
  uid: string; ids: string[]; vendedores: { id: string; nome: string }[]; onFechar: () => void; onSalvo: () => void;
}) {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [tier, setTier] = useState('');
  const [segmento, setSegmento] = useState('');
  const [vend, setVend] = useState('__nao__');
  return (
    <Sheet aberto onFechar={onFechar} titulo={`Editar ${inteiro(ids.length)} pontos`}
      rodape={<button className="btn btn-primary btn-lg btn-block" onClick={async () => {
        try {
          const n = await atualizarPontos(uid, ids, {
            ...(status ? { status: status as StatusComercial } : {}), ...(tier ? { tier: tier as 'A' | 'B' | 'C' } : {}),
            ...(segmento ? { segmento } : {}), ...(vend !== '__nao__' ? { vendedorId: vend || null } : {}),
          });
          toast('ok', `${inteiro(n)} ponto(s) atualizado(s).`); onSalvo();
        } catch (e) { toast('erro', e instanceof Error ? e.message : String(e)); }
      }}>Aplicar</button>}>
      <div className="stack">
        <p className="small muted">Só os campos que você escolher serão alterados.</p>
        <Campo rotulo="Status"><select className="select" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Não alterar</option>{Object.entries(ROTULO_STATUS).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select></Campo>
        <Campo rotulo="Classe"><select className="select" value={tier} onChange={(e) => setTier(e.target.value)}><option value="">Não alterar</option><option value="A">A</option><option value="B">B</option><option value="C">C</option></select></Campo>
        <Campo rotulo="Segmento"><select className="select" value={segmento} onChange={(e) => setSegmento(e.target.value)}><option value="">Não alterar</option>{Object.entries(ROTULO_SEGMENTO).map(([k, r]) => <option key={k} value={k}>{r}</option>)}</select></Campo>
        <Campo rotulo="Vendedor"><select className="select" value={vend} onChange={(e) => setVend(e.target.value)}><option value="__nao__">Não alterar</option><option value="">Remover vendedor</option>{vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}</select></Campo>
      </div>
    </Sheet>
  );
}
