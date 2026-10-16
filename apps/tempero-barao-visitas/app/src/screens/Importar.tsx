import { ChevronDown, CircleCheck, FileUp, Lock, MapPinOff, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { garantirVendedores, importarKml, type InicioCadencia, type ResultadoImportacao } from '../db/api';
import { lerKmlDeBytes } from '../kml/arquivo';
import { aplicarRegras, detectarVendedores, sugerirRegras, type RegraPasta, type Vendedor } from '../kml/mapeamento';
import { parseKml, type ResultadoKml } from '../kml/parseKml';
import { inteiro, ROTULO_SEGMENTO, ROTULO_STATUS } from '../lib/formatar';
import { useSessao } from '../state/sessao';
import { Campo } from '../ui/componentes';
import ImportarPlanilha from './ImportarPlanilha';
import { useToast } from '../ui/toast';

const STATUS_OPCOES = ['ativo', 'inativo', 'em_prospeccao', 'prospecto', 'perdido'] as const;

function ImportarKml() {
  const { usuario, recarregar } = useSessao();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [lendo, setLendo] = useState(false);
  const [arquivo, setArquivo] = useState('');
  const [res, setRes] = useState<ResultadoKml | null>(null);
  const [vendedores, setVendedores] = useState<Vendedor[]>([]);
  const [regras, setRegras] = useState<RegraPasta[]>([]);
  const [gravando, setGravando] = useState(false);
  const [feito, setFeito] = useState<ResultadoImportacao | null>(null);
  const [verSuspeitos, setVerSuspeitos] = useState(false);
  const [inicio, setInicio] = useState<InicioCadencia>('escalonado');

  async function ler(f: File) {
    setLendo(true);
    setFeito(null);
    try {
      // dá um respiro para o navegador pintar o "lendo…" antes do parse pesado
      await new Promise((r) => setTimeout(r, 30));
      const xml = lerKmlDeBytes(new Uint8Array(await f.arrayBuffer()));
      const r = parseKml(xml, new DOMParser());
      const v = detectarVendedores(r.pastas);
      setArquivo(f.name);
      setRes(r);
      setVendedores(v);
      setRegras(sugerirRegras(r.pastas, v));
    } catch (e) {
      setRes(null);
      toast('erro', `Não consegui ler o arquivo: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLendo(false);
    }
  }

  const itens = useMemo(() => (res ? aplicarRegras(res.itens, regras) : []), [res, regras]);
  const setRegra = (pasta: string, patch: Partial<RegraPasta>) =>
    setRegras((l) => l.map((r) => (r.pasta === pasta ? { ...r, ...patch } : r)));

  async function gravar() {
    if (!res) return;
    setGravando(true);
    try {
      const usados = new Set(regras.filter((r) => r.importar).map((r) => r.vendedorChave).filter(Boolean));
      await garantirVendedores(vendedores.filter((v) => usados.has(v.chave)));
      const r = await importarKml(usuario!.id, itens, res.regioes, inicio);
      setFeito(r);
      await recarregar();
      toast('ok', `Importação concluída: ${inteiro(r.inseridos)} novos, ${inteiro(r.atualizados)} atualizados.`);
    } catch (e) {
      toast('erro', `Falha na importação: ${e instanceof Error ? e.message : e}`);
    } finally {
      setGravando(false);
    }
  }

  if (feito) {
    return (
      <div className="stack-lg">
        <div className="hero">
          <h1 className="hero-title">Mapa importado!</h1>
          <p className="small" style={{ opacity: 0.85, marginTop: 8 }}>
            {inteiro(feito.inseridos)} pontos novos · {inteiro(feito.atualizados)} atualizados · {inteiro(feito.regioes)} bairros/regiões
            {feito.vendedorNaoEncontrado ? ` · ${feito.vendedorNaoEncontrado} sem vendedor encontrado` : ''}
          </p>
        </div>
        <div className="banner ok"><CircleCheck size={20} aria-hidden /> Reimportar o mesmo arquivo é seguro: atualiza cadastro e localização e preserva status, classe e carteira.</div>
        <div className="row wrap">
          <Link to="/" className="btn btn-primary btn-lg">Ir para o painel</Link>
          <Link to="/pontos" className="btn btn-ghost btn-lg">Revisar classe e segmento</Link>
          <button className="btn btn-soft btn-lg" onClick={() => { setFeito(null); setRes(null); setArquivo(''); }}>Importar outro arquivo</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack-lg">
      <div>
        <h1 className="h1">Importar mapa do Google Earth</h1>
        <p className="muted small">Exporte o projeto como KML (Google Earth › menu do projeto › Exportar como arquivo KML) e envie aqui. O arquivo é lido neste aparelho; nada sai da sua máquina.</p>
      </div>

      <div
        className="card stack"
        style={{ alignItems: 'center', textAlign: 'center', borderStyle: 'dashed', borderWidth: 2, padding: 'var(--space-8) var(--space-4)' }}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void ler(f); }}
      >
        <FileUp size={36} aria-hidden style={{ color: 'var(--text-muted)' }} />
        <div>
          <strong>{arquivo || 'Arraste o arquivo .kml ou .kmz aqui'}</strong>
          <p className="small muted">ou escolha no computador</p>
        </div>
        <input ref={input} type="file" accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void ler(f); e.target.value = ''; }} />
        <button className="btn btn-primary" disabled={lendo} onClick={() => input.current?.click()}>
          {lendo ? <><span className="spinner" /> Lendo arquivo…</> : arquivo ? 'Escolher outro arquivo' : 'Escolher arquivo'}
        </button>
      </div>

      <div className="banner">
        <Lock size={20} aria-hidden />
        <span><strong>Privacidade (LGPD):</strong> CPF, RG, e-mail e limite de crédito que vêm no cadastro do ERP <strong>não são importados</strong>. Só ficam código do cliente, razão social, CNPJ, endereço e telefones.</span>
      </div>

      {res && (
        <>
          <section className="bento" aria-label="Resumo da leitura">
            <div className="kpi"><span className="valor">{inteiro(itens.length)}</span><span className="rotulo">pontos a importar</span></div>
            <div className="kpi"><span className="valor">{inteiro(res.resumo.comCodigoErp)}</span><span className="rotulo">com cadastro do ERP</span></div>
            <div className="kpi"><span className="valor">{inteiro(res.resumo.regioes)}</span><span className="rotulo">bairros / regiões</span></div>
            <div className="kpi"><span className="valor">{inteiro(res.resumo.duplicadosNoArquivo)}</span><span className="rotulo">duplicados ignorados</span></div>
          </section>

          {res.resumo.rotulosRegiao > 0 && (
            <div className="banner"><CircleCheck size={20} aria-hidden /><span>{inteiro(res.resumo.rotulosRegiao)} rótulos de valores por bairro (ex.: “RESTAURANTE - 256,21”) foram guardados na região, <strong>não como estabelecimentos</strong>.</span></div>
          )}

          {res.suspeitos.length > 0 && (
            <div className="stack">
              <button className="banner perigo" style={{ textAlign: 'left', border: 0, cursor: 'pointer' }} onClick={() => setVerSuspeitos((v) => !v)} aria-expanded={verSuspeitos}>
                <MapPinOff size={20} aria-hidden />
                <span className="grow"><strong>{res.suspeitos.length} ponto(s) com coordenada suspeita.</strong> Entram <u>sem localização</u> para não poluir o mapa; corrija no Google Earth e reimporte.</span>
                <ChevronDown size={18} aria-hidden style={{ transform: verSuspeitos ? 'rotate(180deg)' : undefined }} />
              </button>
              {verSuspeitos && (
                <div className="card stack" style={{ gap: 'var(--space-2)' }}>
                  {res.suspeitos.map((s) => (
                    <div key={s.nome + s.lat} className="small"><strong>{s.nome}</strong> <span className="muted">({s.lat.toFixed(4)}, {s.lng.toFixed(4)}) — {s.motivo}</span></div>
                  ))}
                </div>
              )}
            </div>
          )}

          <section className="stack" aria-labelledby="pastas">
            <h2 id="pastas" className="h2">O que significa cada pasta?</h2>
            <p className="small muted">Sugerimos pelo nome das pastas (“VENDAS ATIVAS” = clientes que compram). Confira antes de importar: isso define quem é cobrado de visita.</p>
            {vendedores.length > 0 && (
              <p className="small"><strong>Vendedores detectados:</strong> {vendedores.map((v) => v.nome).join(', ')}</p>
            )}
            <div className="list">
              {regras.map((r) => {
                const p = res.pastas.find((x) => x.chave === r.pasta)!;
                return (
                  <div key={r.pasta} className="card stack" style={{ opacity: r.importar ? 1 : 0.55 }}>
                    <label className="row" style={{ alignItems: 'flex-start' }}>
                      <input className="check" type="checkbox" checked={r.importar} onChange={(e) => setRegra(r.pasta, { importar: e.target.checked })} />
                      <span className="grow">
                        <strong>{p.rotulo}</strong>
                        <span className="small muted" style={{ display: 'block' }}>{inteiro(p.total)} pontos · {inteiro(p.comCodigoErp)} com cadastro no ERP</span>
                      </span>
                    </label>
                    {r.importar && (
                      <div className="grid-2">
                        <Campo rotulo="Com cadastro no ERP">
                          <select className="select" value={r.statusComCodigoErp} onChange={(e) => setRegra(r.pasta, { statusComCodigoErp: e.target.value as RegraPasta['statusComCodigoErp'] })}>
                            {STATUS_OPCOES.map((s) => <option key={s} value={s}>{ROTULO_STATUS[s]}</option>)}
                          </select>
                        </Campo>
                        <Campo rotulo="Só o pino (sem ERP)">
                          <select className="select" value={r.statusSemCodigoErp} onChange={(e) => setRegra(r.pasta, { statusSemCodigoErp: e.target.value as RegraPasta['statusSemCodigoErp'] })}>
                            {STATUS_OPCOES.map((s) => <option key={s} value={s}>{ROTULO_STATUS[s]}</option>)}
                          </select>
                        </Campo>
                        <Campo rotulo="Classe inicial">
                          <select className="select" value={r.tier} onChange={(e) => setRegra(r.pasta, { tier: e.target.value as RegraPasta['tier'] })}>
                            <option value="A">A — estratégico</option><option value="B">B — regular</option><option value="C">C — básico</option>
                          </select>
                        </Campo>
                        <Campo rotulo="Vendedor">
                          <select className="select" value={r.vendedorChave ?? ''} onChange={(e) => setRegra(r.pasta, { vendedorChave: e.target.value || null })}>
                            <option value="">Sem vendedor</option>
                            {vendedores.map((v) => <option key={v.chave} value={v.chave}>{v.nome}</option>)}
                          </select>
                        </Campo>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="stack" aria-labelledby="inicio">
            <h2 id="inicio" className="h2">Como começar a cadência?</h2>
            <p className="small muted">O mapa não informa quando cada cliente foi visitado pela última vez. Escolha como tratar isso no primeiro dia (vale só para pontos novos com vendedor).</p>
            <div className="stack" role="radiogroup" aria-labelledby="inicio" style={{ gap: 'var(--space-2)' }}>
              {([
                ['escalonado', 'Escalonado (recomendado)', 'Os vencimentos se espalham ao longo do ciclo: a fila se enche aos poucos, sem uma muralha de visitas no mesmo dia.'],
                ['vencidos', 'Cobrar já', 'Todos vencem hoje. A fila nasce cheia, em ordem de prioridade: bom para um mutirão de reativação.'],
                ['zero', 'Do zero', 'Todos entram em dia hoje; a cobrança só aparece depois de um intervalo inteiro.'],
              ] as [InicioCadencia, string, string][]).map(([k, t, d]) => (
                <label key={k} className="option" style={{ alignItems: 'flex-start', minHeight: 0, padding: 'var(--space-3)' }}  data-on={inicio === k || undefined}>
                  <input type="radio" name="inicio" className="check" checked={inicio === k} onChange={() => setInicio(k)} style={{ marginTop: 2, accentColor: 'var(--text)' }} />
                  <span><strong>{t}</strong><span className="small muted" style={{ display: 'block', fontWeight: 400 }}>{d}</span></span>
                </label>
              ))}
            </div>
          </section>

          <section className="stack" aria-label="Segmentos sugeridos">
            <h3 className="h3">Segmento sugerido pelo nome</h3>
            <div className="row wrap" style={{ gap: 'var(--space-2)' }}>
              {(Object.entries(res.resumo.porSegmento) as [string, number][]).map(([k, n]) => <span key={k} className="chip">{ROTULO_SEGMENTO[k]}: <strong>{inteiro(n)}</strong></span>)}
            </div>
            <p className="hint">É uma sugestão por palavras-chave (restaurante, mercadinho, padaria…). Você ajusta depois em Pontos › edição em lote.</p>
          </section>

          <div className="actionbar">
            <button className="btn btn-primary btn-lg btn-block" disabled={gravando || itens.length === 0} onClick={gravar}>
              {gravando ? <><span className="spinner" /> Importando…</> : <>Importar {inteiro(itens.length)} pontos</>}
            </button>
          </div>
          {itens.length === 0 && <div className="banner perigo"><TriangleAlert size={20} aria-hidden /> Nenhuma pasta selecionada.</div>}
        </>
      )}
    </div>
  );
}

export default function Importar() {
  const [modo, setModo] = useState<'kml' | 'planilha'>('kml');
  return (
    <div className="stack-lg">
      <div className="segmented" role="group" aria-label="Origem dos dados" style={{ alignSelf: 'flex-start' }}>
        <button aria-pressed={modo === 'kml'} onClick={() => setModo('kml')}>Mapa do Google Earth</button>
        <button aria-pressed={modo === 'planilha'} onClick={() => setModo('planilha')}>Planilha de clientes</button>
      </div>
      {modo === 'kml' ? <ImportarKml /> : <ImportarPlanilha />}
    </div>
  );
}
