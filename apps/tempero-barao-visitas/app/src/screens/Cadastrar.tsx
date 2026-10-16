import { ChevronLeft, Locate, LoaderCircle, MapPinOff, TriangleAlert, Lock, CircleCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { buscarDuplicados, cadastrarCliente, ErroDuplicado, type Duplicado, type StatusComercial } from '../db/api';
import { useLocalizacao } from '../hooks/useLocalizacao';
import { ROTULO_SEGMENTO, ROTULO_STATUS } from '../lib/formatar';
import { ehGestao, useSessao } from '../state/sessao';
import { Campo } from '../ui/componentes';
import { useToast } from '../ui/toast';

const VAZIO = {
  nome: '', razaoSocial: '', cnpj: '', codigoErp: '', telefone: '', celular: '', contato: '',
  endereco: '', bairro: '', cidade: 'Parnaíba', uf: 'PI', cep: '', segmento: 'varejo', observacoes: '',
};

export default function Cadastrar() {
  const { usuario, usuarios, recarregar } = useSessao();
  const uid = usuario!.id;
  const gestao = ehGestao(usuario);
  const nav = useNavigate();
  const toast = useToast();
  const [f, setF] = useState(VAZIO);
  const [compra, setCompra] = useState<'sim' | 'nao'>('nao');
  const [tier, setTier] = useState<'A' | 'B' | 'C'>('C');
  const [statusG, setStatusG] = useState<StatusComercial>('ativo');
  const [vendedorId, setVendedorId] = useState('');
  const [forcar, setForcar] = useState(false);
  const [dups, setDups] = useState<Duplicado[]>([]);
  const [erro, setErro] = useState<ErroDuplicado | null>(null);
  const [salvando, setSalvando] = useState(false);
  const { pos, status: gps, pedir } = useLocalizacao();
  const set = (k: keyof typeof VAZIO) => (e: { target: { value: string } }) => { setErro(null); setF((x) => ({ ...x, [k]: e.target.value })); };

  // aviso de duplicado enquanto digita (CNPJ, código do ERP, nome + cidade)
  useEffect(() => {
    const t = setTimeout(() => {
      buscarDuplicados(uid, { nome: f.nome, cnpj: f.cnpj, codigoErp: f.codigoErp, cidade: f.cidade }).then(setDups).catch(() => setDups([]));
    }, 350);
    return () => clearTimeout(t);
  }, [uid, f.nome, f.cnpj, f.codigoErp, f.cidade]);

  async function salvar(e: React.FormEvent) {
    e.preventDefault();
    if (!f.nome.trim()) return;
    setSalvando(true);
    setErro(null);
    try {
      const id = await cadastrarCliente(uid, {
        nome: f.nome, razaoSocial: f.razaoSocial, cnpj: f.cnpj, codigoErp: f.codigoErp, telefone: f.telefone,
        celular: f.celular, contato: f.contato, endereco: f.endereco, bairro: f.bairro, cidade: f.cidade, uf: f.uf,
        cep: f.cep, segmento: f.segmento, observacoes: f.observacoes,
        lat: pos?.lat ?? null, lng: pos?.lng ?? null,
        ...(gestao
          ? { status: statusG, tier, vendedorId: vendedorId || null, forcar }
          : { status: compra === 'sim' ? ('ativo' as const) : ('em_prospeccao' as const) }),
      });
      toast('ok', `${f.nome} cadastrado${gestao ? '' : ' na sua carteira'}.`);
      await recarregar();
      nav(`/ponto/${id}`);
    } catch (x) {
      if (x instanceof ErroDuplicado) setErro(x);
      else toast('erro', x instanceof Error ? x.message : String(x));
    } finally {
      setSalvando(false);
    }
  }

  const bloqueado = dups.length > 0 && !(gestao && forcar);

  return (
    <form className="stack-lg" onSubmit={salvar} noValidate>
      <div>
        <Link to="/pontos" className="back"><ChevronLeft size={18} aria-hidden /> Pontos</Link>
        <h1 className="h1">Cadastrar cliente</h1>
        <p className="muted small">Para clientes que não vieram do Google Earth ou do ERP. {gestao ? 'Você escolhe o vendedor e o status.' : 'Ele entra direto na sua carteira.'}</p>
      </div>

      {dups.length > 0 && (
        <div className="banner perigo" role="alert">
          <TriangleAlert size={20} aria-hidden />
          <div className="stack" style={{ gap: 'var(--space-2)' }}>
            <strong>Esse cliente parece já existir:</strong>
            {dups.map((d) => (
              <div key={d.id} className="small">
                <strong>{d.nome}</strong> ({d.motivo}) — {d.meu ? 'já está na sua carteira' : d.livre ? 'está sem vendedor' : (<><Lock size={12} aria-hidden style={{ display: 'inline' }} /> vinculado a {d.vendedorNome ?? 'outro vendedor'}</>)}
                {(d.meu || d.livre || gestao) && <> · <Link to={`/ponto/${d.id}`}>abrir</Link></>}
              </div>
            ))}
            {!gestao && <span className="small">Não é possível cadastrar em duplicidade. Se está sem vendedor, assuma o ponto em vez de cadastrar de novo.</span>}
            {gestao && (
              <label className="row small"><input type="checkbox" className="check" checked={forcar} onChange={(e) => setForcar(e.target.checked)} /> Cadastrar mesmo assim (é outra unidade)</label>
            )}
          </div>
        </div>
      )}
      {erro && dups.length === 0 && <div className="banner perigo" role="alert"><TriangleAlert size={20} aria-hidden /> {erro.message}</div>}

      <section className="card stack" aria-labelledby="id">
        <h2 id="id" className="card-title">Identificação</h2>
        <Campo rotulo="Nome do estabelecimento *"><input className="input" required value={f.nome} onChange={set('nome')} autoComplete="off" /></Campo>
        <div className="grid-fluid">
          <Campo rotulo="Razão social"><input className="input" value={f.razaoSocial} onChange={set('razaoSocial')} /></Campo>
          <Campo rotulo="CNPJ" dica="Usado para evitar cadastro em duplicidade."><input className="input" inputMode="numeric" value={f.cnpj} onChange={set('cnpj')} /></Campo>
          <Campo rotulo="Código no ERP"><input className="input" inputMode="numeric" value={f.codigoErp} onChange={set('codigoErp')} /></Campo>
        </div>
        <Campo rotulo="Segmento">
          <select className="select" value={f.segmento} onChange={set('segmento')}>
            {Object.entries(ROTULO_SEGMENTO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </Campo>
      </section>

      <section className="card stack" aria-labelledby="ct">
        <h2 id="ct" className="card-title">Contato</h2>
        <div className="grid-fluid">
          <Campo rotulo="Telefone"><input className="input" inputMode="tel" value={f.telefone} onChange={set('telefone')} /></Campo>
          <Campo rotulo="Celular / WhatsApp"><input className="input" inputMode="tel" value={f.celular} onChange={set('celular')} /></Campo>
          <Campo rotulo="Pessoa de contato"><input className="input" value={f.contato} onChange={set('contato')} /></Campo>
        </div>
      </section>

      <section className="card stack" aria-labelledby="en">
        <h2 id="en" className="card-title">Endereço e localização</h2>
        <Campo rotulo="Endereço"><input className="input" value={f.endereco} onChange={set('endereco')} placeholder="Rua, número" /></Campo>
        <div className="grid-fluid">
          <Campo rotulo="Bairro"><input className="input" value={f.bairro} onChange={set('bairro')} /></Campo>
          <Campo rotulo="Cidade"><input className="input" value={f.cidade} onChange={set('cidade')} /></Campo>
          <Campo rotulo="UF"><input className="input" maxLength={2} value={f.uf} onChange={set('uf')} /></Campo>
          <Campo rotulo="CEP"><input className="input" inputMode="numeric" value={f.cep} onChange={set('cep')} /></Campo>
        </div>
        <div className={`banner ${pos ? 'ok' : ''}`}>
          {gps === 'buscando' ? <LoaderCircle className="spinner-icon" size={20} aria-hidden /> : pos ? <CircleCheck size={20} aria-hidden /> : <MapPinOff size={20} aria-hidden />}
          <span className="grow">
            {pos ? `Localização capturada (±${Math.round(pos.precisaoM)} m). O cliente será marcado no mapa neste ponto.`
              : gps === 'negado' || gps === 'indisponivel' ? 'Não consegui a localização. Você pode cadastrar assim e definir o ponto depois, na ficha.'
              : 'Está no local do cliente? Marque o ponto no mapa com sua localização atual (lida uma vez, sem rastreamento).'}
          </span>
          <button type="button" className="btn btn-sm btn-dark" onClick={() => void pedir()}><Locate size={16} aria-hidden /> {pos ? 'Atualizar' : 'Usar minha localização'}</button>
        </div>
      </section>

      <section className="card stack" aria-labelledby="cl">
        <h2 id="cl" className="card-title">Classificação</h2>
        {gestao ? (
          <div className="grid-fluid">
            <Campo rotulo="Status">
              <select className="select" value={statusG} onChange={(e) => setStatusG(e.target.value as StatusComercial)}>
                {Object.entries(ROTULO_STATUS).filter(([k]) => k !== 'perdido').map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </Campo>
            <Campo rotulo="Classe"><select className="select" value={tier} onChange={(e) => setTier(e.target.value as 'A' | 'B' | 'C')}><option value="A">A — estratégico</option><option value="B">B — regular</option><option value="C">C — básico</option></select></Campo>
            <Campo rotulo="Vendedor">
              <select className="select" value={vendedorId} onChange={(e) => setVendedorId(e.target.value)}>
                <option value="">Sem vendedor</option>
                {usuarios.filter((u) => u.papel === 'vendedor').map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
              </select>
            </Campo>
          </div>
        ) : (
          <Campo grupo rotulo="Esse cliente já compra da Barão?">
            <div className="options">
              <button type="button" className="option" aria-pressed={compra === 'sim'} onClick={() => setCompra('sim')}>Sim, já compra</button>
              <button type="button" className="option" aria-pressed={compra === 'nao'} onClick={() => setCompra('nao')}>Ainda não (prospecção)</button>
            </div>
          </Campo>
        )}
        <Campo rotulo="Observações"><textarea className="textarea" value={f.observacoes} onChange={set('observacoes')} /></Campo>
      </section>

      <div className="actionbar">
        <button className="btn btn-primary btn-lg btn-block" type="submit" disabled={salvando || !f.nome.trim() || bloqueado}>
          {salvando ? <span className="spinner" /> : null} Cadastrar cliente
        </button>
      </div>
    </form>
  );
}
