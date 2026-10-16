import { CircleCheck, FileSpreadsheet, Lock, TriangleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { garantirChaveImport, importarKml, type InicioCadencia, type ResultadoImportacao } from '../db/api';
import { normaliza } from '../kml/geo';
import { slug } from '../kml/mapeamento';
import type { Status } from '../kml/parseKml';
import { aplicarMapa, detectarLayout, lerRelatorioErp, lerTabela, paraItens, ROTULO_CAMPO, type Campo, type LeituraRelatorio, type LeituraTabela, type MapaColunas } from '../planilha/clientes';
import { lerCsv } from '../planilha/csvLeitor';
import { lerXlsx } from '../planilha/xlsx';
import { inteiro, ROTULO_STATUS } from '../lib/formatar';
import { useSessao } from '../state/sessao';
import { Campo as CampoForm } from '../ui/componentes';
import { useToast } from '../ui/toast';

const CAMPOS = Object.keys(ROTULO_CAMPO) as Campo[];

export default function ImportarPlanilha() {
  const { usuario, usuarios, recarregar } = useSessao();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [lendo, setLendo] = useState(false);
  const [arquivo, setArquivo] = useState('');
  const [layout, setLayout] = useState<'relatorio-erp' | 'tabela' | null>(null);
  const [rel, setRel] = useState<LeituraRelatorio | null>(null);
  const [tab, setTab] = useState<LeituraTabela | null>(null);
  const [mapa, setMapa] = useState<MapaColunas>({});
  const [statusPadrao, setStatusPadrao] = useState<Status>('prospecto');
  const [tierPadrao, setTierPadrao] = useState<'A' | 'B' | 'C'>('C');
  const [vendedorId, setVendedorId] = useState('');
  const [incluirSemNome, setIncluirSemNome] = useState(false);
  const [inicio, setInicio] = useState<InicioCadencia>('escalonado');
  const [gravando, setGravando] = useState(false);
  const [feito, setFeito] = useState<ResultadoImportacao | null>(null);

  const vendedores = usuarios.filter((u) => u.papel === 'vendedor').map((u) => ({ id: u.id, nome: u.nome, chave: u.chaveImport ?? slug(u.nome) }));

  async function ler(f: File) {
    setLendo(true);
    setFeito(null);
    try {
      await new Promise((r) => setTimeout(r, 30));
      let linhas: string[][];
      if (/\.(csv|txt|tsv)$/i.test(f.name)) linhas = lerCsv(new TextDecoder('utf-8').decode(new Uint8Array(await f.arrayBuffer())));
      else {
        const abas = lerXlsx(new Uint8Array(await f.arrayBuffer()));
        if (!abas.length) throw new Error('A planilha não tem abas');
        linhas = abas.sort((a, b) => b.linhas.length - a.linhas.length)[0].linhas;
      }
      const l = detectarLayout(linhas);
      setArquivo(f.name);
      setLayout(l);
      if (l === 'relatorio-erp') { setRel(lerRelatorioErp(linhas)); setTab(null); }
      else { const t = lerTabela(linhas); setTab(t); setMapa(t.mapa); setRel(null); }
    } catch (e) {
      setLayout(null);
      toast('erro', `Não consegui ler a planilha: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLendo(false);
    }
  }

  const clientes = useMemo(() => (layout === 'relatorio-erp' ? rel?.linhas ?? [] : tab ? aplicarMapa(tab.dados, mapa) : []), [layout, rel, tab, mapa]);
  const resolverVendedor = (nome: string) => {
    const n = normaliza(nome);
    const v = vendedores.find((x) => normaliza(x.nome) === n) ?? vendedores.find((x) => normaliza(x.nome).startsWith(n) || n.startsWith(normaliza(x.nome)));
    return v?.chave ?? null;
  };
  const r = useMemo(() => paraItens(clientes, {
    statusPadrao, tierPadrao, incluirSemNome, vendedorPadrao: vendedores.find((v) => v.id === vendedorId)?.chave ?? null, resolverVendedor,
  }), [clientes, statusPadrao, tierPadrao, incluirSemNome, vendedorId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function gravar() {
    setGravando(true);
    try {
      for (const v of vendedores) if (r.itens.some((i) => i.vendedor_chave === v.chave)) await garantirChaveImport(v.id, v.nome);
      const res = await importarKml(usuario!.id, r.itens, [], inicio);
      setFeito(res);
      await recarregar();
      toast('ok', `Planilha importada: ${inteiro(res.inseridos)} novos, ${inteiro(res.atualizados)} atualizados.`);
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
          <h1 className="hero-title">Planilha importada!</h1>
          <p className="small" style={{ opacity: 0.85, marginTop: 8 }}>{inteiro(feito.inseridos)} clientes novos · {inteiro(feito.atualizados)} atualizados</p>
        </div>
        <div className="banner ok"><CircleCheck size={20} aria-hidden /> Clientes que já estavam no mapa (mesmo código do ERP) foram atualizados com cadastro, endereço e telefones; nome e localização do mapa foram preservados.</div>
        <div className="banner"><TriangleAlert size={20} aria-hidden /> Clientes novos entram <strong>sem localização</strong>: o vendedor marca o ponto pelo GPS na ficha, na primeira visita.</div>
        <div className="row wrap"><Link to="/pontos" className="btn btn-primary btn-lg">Ver pontos e atribuir vendedores</Link><Link to="/" className="btn btn-ghost btn-lg">Painel</Link><button className="btn btn-soft btn-lg" onClick={() => { setFeito(null); setLayout(null); setArquivo(''); }}>Importar outra planilha</button></div>
      </div>
    );
  }

  const faltaNome = layout === 'relatorio-erp' && rel && rel.semNome > 0;
  const quaseTodosSemNome = !!rel && rel.blocos > 0 && rel.semNome / rel.blocos > 0.3;

  return (
    <div className="stack-lg">
      <div>
        <h1 className="h1">Importar planilha de clientes</h1>
        <p className="muted small">Excel (.xlsx) ou CSV exportado do ERP. Aceita a “Listagem de clientes – detalhada” e também tabelas simples com uma linha por cliente.</p>
      </div>

      <div className="card stack" style={{ alignItems: 'center', textAlign: 'center', borderStyle: 'dashed', borderWidth: 2, padding: 'var(--space-8) var(--space-4)' }}
        onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void ler(f); }}>
        <FileSpreadsheet size={36} aria-hidden style={{ color: 'var(--text-muted)' }} />
        <div><strong>{arquivo || 'Arraste a planilha aqui'}</strong><p className="small muted">.xlsx ou .csv</p></div>
        <input ref={input} type="file" hidden accept=".xlsx,.csv,.txt,.tsv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void ler(f); e.target.value = ''; }} />
        <button className="btn btn-primary" disabled={lendo} onClick={() => input.current?.click()}>{lendo ? <><span className="spinner" /> Lendo…</> : arquivo ? 'Escolher outra planilha' : 'Escolher planilha'}</button>
      </div>

      <div className="banner"><Lock size={20} aria-hidden /><span><strong>Privacidade (LGPD):</strong> CPF, RG, e-mail e limite de crédito <strong>não são importados</strong>. De documento, só o CNPJ (14 dígitos).</span></div>

      {layout && (
        <>
          <section className="bento" aria-label="Resumo da leitura">
            <div className="kpi"><span className="valor">{inteiro(clientes.length)}</span><span className="rotulo">clientes na planilha</span></div>
            <div className="kpi"><span className="valor">{inteiro(r.itens.length)}</span><span className="rotulo">a importar</span></div>
            <div className="kpi"><span className="valor">{inteiro(r.semNome)}</span><span className="rotulo">sem nome (pulados)</span></div>
            <div className="kpi"><span className="valor">{inteiro(r.duplicadosNoArquivo)}</span><span className="rotulo">repetidos</span></div>
          </section>

          {faltaNome && (
            <div className={`banner ${quaseTodosSemNome ? 'perigo' : ''}`} role="alert">
              <TriangleAlert size={20} aria-hidden />
              <div className="stack" style={{ gap: 'var(--space-2)' }}>
                <strong>{inteiro(rel!.semNome)} de {inteiro(rel!.blocos)} clientes vieram sem nome e sem código do ERP.</strong>
                <span className="small">Essa exportação do ERP perdeu a linha “razão social / código / fantasia” (só a primeira de cada folha saiu). Sem o nome, o vendedor não consegue identificar o cliente.
                  {' '}<strong>Peça uma nova exportação com as colunas Código, Razão social e Fantasia</strong> (de preferência “planilha de dados”/CSV, uma linha por cliente) e envie de novo: o sistema atualiza sem duplicar.</span>
                <label className="row small"><input type="checkbox" className="check" checked={incluirSemNome} onChange={(e) => setIncluirSemNome(e.target.checked)} /> Importar assim mesmo, usando o endereço como nome provisório</label>
              </div>
            </div>
          )}

          {layout === 'tabela' && tab && (
            <section className="stack" aria-labelledby="colunas">
              <h2 id="colunas" className="h2">Quais colunas são quais?</h2>
              <p className="small muted">Sugerimos pelo nome do cabeçalho. Ajuste o que precisar; o nome (ou a razão social) é obrigatório.</p>
              <div className="grid-fluid">
                {CAMPOS.map((c) => (
                  <CampoForm key={c} rotulo={ROTULO_CAMPO[c]}>
                    <select className="select" value={mapa[c] ?? ''} onChange={(e) => setMapa((m) => { const n = { ...m }; if (e.target.value === '') delete n[c]; else n[c] = Number(e.target.value); return n; })}>
                      <option value="">— não usar —</option>
                      {tab.cabecalho.map((h, i) => <option key={i} value={i}>{h || `(coluna ${i + 1})`}</option>)}
                    </select>
                  </CampoForm>
                ))}
              </div>
            </section>
          )}

          {r.vendedoresNaoReconhecidos.length > 0 && (
            <div className="banner"><TriangleAlert size={20} aria-hidden /><span>Vendedores da planilha que não existem no sistema (ficam sem vendedor): <strong>{r.vendedoresNaoReconhecidos.slice(0, 6).join(', ')}</strong>.</span></div>
          )}

          <section className="card stack" aria-labelledby="padroes">
            <h2 id="padroes" className="card-title">Como entram</h2>
            <div className="grid-fluid">
              <CampoForm rotulo="Status inicial" dica="Prospecto fica fora da cobrança de visitas.">
                <select className="select" value={statusPadrao} onChange={(e) => setStatusPadrao(e.target.value as Status)}>
                  {(['prospecto', 'em_prospeccao', 'ativo', 'inativo'] as const).map((s) => <option key={s} value={s}>{ROTULO_STATUS[s]}</option>)}
                </select>
              </CampoForm>
              <CampoForm rotulo="Classe inicial"><select className="select" value={tierPadrao} onChange={(e) => setTierPadrao(e.target.value as 'A' | 'B' | 'C')}><option value="A">A</option><option value="B">B</option><option value="C">C</option></select></CampoForm>
              <CampoForm rotulo="Vendedor (quando a planilha não diz)">
                <select className="select" value={vendedorId} onChange={(e) => setVendedorId(e.target.value)}>
                  <option value="">Sem vendedor</option>
                  {vendedores.map((v) => <option key={v.id} value={v.id}>{v.nome}</option>)}
                </select>
              </CampoForm>
            </div>
            <div className="stack" role="radiogroup" aria-label="Como começar a cadência" style={{ gap: 'var(--space-2)' }}>
              <span className="label" style={{ fontWeight: 650, fontSize: 'var(--text-sm)' }}>Como começar a cadência (só para clientes novos com vendedor)</span>
              {([['escalonado', 'Escalonado (recomendado)'], ['vencidos', 'Cobrar já'], ['zero', 'Do zero']] as [InicioCadencia, string][]).map(([k, t]) => (
                <label key={k} className="option" data-on={inicio === k || undefined} style={{ minHeight: 44 }}>
                  <input type="radio" name="inicio-planilha" className="check" checked={inicio === k} onChange={() => setInicio(k)} style={{ accentColor: 'var(--text)' }} /> {t}
                </label>
              ))}
            </div>
          </section>

          <div className="actionbar">
            <button className="btn btn-primary btn-lg btn-block" disabled={gravando || r.itens.length === 0} onClick={gravar}>
              {gravando ? <><span className="spinner" /> Importando…</> : r.itens.length === 0 ? 'Nada a importar' : <>Importar {inteiro(r.itens.length)} clientes</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
