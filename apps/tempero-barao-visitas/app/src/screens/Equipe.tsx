import { Check, Copy, KeyRound, Power, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { listarEquipe } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { gerirUsuarios, listarContas } from '../sync/equipe';
import { sincronizar } from '../sync/motor';
import { useSessao } from '../state/sessao';
import { Avatar, Campo, Carregando, Vazio } from '../ui/componentes';
import { Sheet } from '../ui/Sheet';
import { useToast } from '../ui/toast';

const PAPEL: Record<string, string> = { admin: 'Administração', gestor: 'Gestão', vendedor: 'Vendedor', promotor: 'Promotor' };

/** senha fácil de ditar por telefone, difícil de adivinhar (sem 0/O/1/l) */
function gerarSenha() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(10));
  return Array.from(bytes, (b) => letras[b % letras.length]).join('');
}

export default function Equipe() {
  const { usuario, recarregar } = useSessao();
  const toast = useToast();
  const equipe = useAsync(() => listarEquipe(), []);
  const contas = useAsync(() => listarContas().catch(() => null), []);
  const [novo, setNovo] = useState(false);
  const [senhaDe, setSenhaDe] = useState<{ id: string; nome: string } | null>(null);
  const [criado, setCriado] = useState<{ nome: string; email: string; senha: string } | null>(null);

  const emailDe = (id: string) => contas.dados?.find((c) => c.id === id)?.email ?? '';
  const ultimo = (id: string) => {
    const t = contas.dados?.find((c) => c.id === id)?.ultimoAcesso;
    return t ? new Date(t).toLocaleDateString('pt-BR') : null;
  };

  async function atualizar() {
    await sincronizar();
    await recarregar();
    equipe.recarregar();
    contas.recarregar();
  }

  async function alternar(id: string, nome: string, ativar: boolean) {
    try {
      await gerirUsuarios({ acao: ativar ? 'ativar' : 'desativar', id });
      toast('ok', ativar ? `${nome} reativado.` : `${nome} desativado: não consegue mais entrar.`);
      await atualizar();
    } catch (e) {
      toast('erro', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div className="stack-lg">
      <div className="row">
        <div className="grow">
          <h1 className="h1">Equipe</h1>
          <p className="muted small">Quem pode entrar no sistema. Só a administração vê esta tela.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setNovo(true)}><UserPlus size={18} aria-hidden /> Novo usuário</button>
      </div>

      {contas.dados === null && !contas.carregando && (
        <div className="banner">Os e-mails não puderam ser carregados (sem internet ou a função de usuários ainda não foi publicada no Supabase). A lista de pessoas abaixo continua valendo.</div>
      )}

      {equipe.carregando && !equipe.dados ? (
        <Carregando linhas={3} />
      ) : !equipe.dados?.length ? (
        <Vazio titulo="Ninguém ainda" texto="Crie o primeiro vendedor." />
      ) : (
        <div className="list">
          {equipe.dados.map((u) => (
            <div key={u.id} className="item" style={{ opacity: u.ativo ? 1 : 0.6 }}>
              <div className="row">
                <Avatar nome={u.nome} />
                <span className="grow">
                  <span className="titulo" style={{ display: 'block' }}>{u.nome}</span>
                  <span className="meta">
                    {PAPEL[u.papel] ?? u.papel}
                    {emailDe(u.id) ? ` · ${emailDe(u.id)}` : ''}
                    {ultimo(u.id) ? ` · último acesso ${ultimo(u.id)}` : ''}
                    {!u.ativo ? ' · DESATIVADO' : ''}
                  </span>
                </span>
              </div>
              <div className="row wrap" style={{ marginTop: 'var(--space-2)' }}>
                <button className="btn btn-sm btn-ghost" onClick={() => setSenhaDe({ id: u.id, nome: u.nome })}><KeyRound size={16} aria-hidden /> Trocar senha</button>
                {u.id !== usuario?.id && u.papel !== 'admin' && (
                  <button className="btn btn-sm btn-ghost" onClick={() => void alternar(u.id, u.nome, !u.ativo)}>
                    <Power size={16} aria-hidden /> {u.ativo ? 'Desativar' : 'Reativar'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <FormNovo aberto={novo} onFechar={() => setNovo(false)} onCriado={async (d) => { setNovo(false); setCriado(d); await atualizar(); }} />
      <FormSenha alvo={senhaDe} onFechar={() => setSenhaDe(null)} onTrocada={(d) => { setSenhaDe(null); setCriado(d); }} />

      <Sheet aberto={!!criado} onFechar={() => setCriado(null)} titulo="Passe estes dados para a pessoa">
        {criado && (
          <div className="stack">
            <p className="small muted">Esta senha <strong>não aparece de novo</strong>. Envie por um canal privado (ex.: WhatsApp direto) e peça para a pessoa trocar em Ajustes.</p>
            <div className="card stack" style={{ gap: 'var(--space-1)' }}>
              <div><span className="muted small">Nome</span><div className="strong">{criado.nome}</div></div>
              <div><span className="muted small">E-mail</span><div className="strong">{criado.email}</div></div>
              <div><span className="muted small">Senha</span><div className="strong" style={{ fontFamily: 'monospace', fontSize: '1.2rem' }}>{criado.senha}</div></div>
            </div>
            <button className="btn btn-primary" onClick={() => { void navigator.clipboard?.writeText(`App Barão Visitas\nE-mail: ${criado.email}\nSenha: ${criado.senha}\nEndereço: ${location.origin}${location.pathname}`); toast('ok', 'Copiado.'); }}>
              <Copy size={18} aria-hidden /> Copiar dados de acesso
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

function FormNovo({ aberto, onFechar, onCriado }: { aberto: boolean; onFechar: () => void; onCriado: (d: { nome: string; email: string; senha: string }) => Promise<void> }) {
  const toast = useToast();
  const [nome, setNome] = useState('');
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState(gerarSenha);
  const [papel, setPapel] = useState('vendedor');
  const [enviando, setEnviando] = useState(false);

  async function criar(e: React.FormEvent) {
    e.preventDefault();
    setEnviando(true);
    try {
      await gerirUsuarios({ acao: 'criar', nome, email, senha, papel });
      const d = { nome: nome.trim(), email: email.trim().toLowerCase(), senha };
      setNome(''); setEmail(''); setSenha(gerarSenha()); setPapel('vendedor');
      await onCriado(d);
    } catch (x) {
      toast('erro', x instanceof Error ? x.message : String(x));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Sheet aberto={aberto} onFechar={onFechar} titulo="Novo usuário">
      <form className="stack" onSubmit={criar}>
        <Campo rotulo="Nome completo"><input className="input" required minLength={2} value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Ex.: João Oliveira" /></Campo>
        <Campo rotulo="E-mail (será o login)"><input className="input" type="email" required inputMode="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} /></Campo>
        <Campo rotulo="Senha inicial" dica="Gerada para você; dá para trocar. Mínimo de 8 caracteres.">
          <div className="row">
            <input className="input grow" required minLength={8} value={senha} onChange={(e) => setSenha(e.target.value)} style={{ fontFamily: 'monospace' }} />
            <button type="button" className="btn btn-ghost" onClick={() => setSenha(gerarSenha())}>Gerar outra</button>
          </div>
        </Campo>
        <Campo rotulo="Papel" grupo>
          <div className="segmented" role="group" aria-label="Papel">
            {([['vendedor', 'Vendedor'], ['gestor', 'Gestão']] as const).map(([k, l]) => (
              <button type="button" key={k} aria-pressed={papel === k} onClick={() => setPapel(k)}>{l}</button>
            ))}
          </div>
        </Campo>
        <button className="btn btn-primary btn-lg" disabled={enviando}>
          {enviando ? <><span className="spinner" /> Criando…</> : <><Check size={18} aria-hidden /> Criar usuário</>}
        </button>
      </form>
    </Sheet>
  );
}

function FormSenha({ alvo, onFechar, onTrocada }: { alvo: { id: string; nome: string } | null; onFechar: () => void; onTrocada: (d: { nome: string; email: string; senha: string }) => void }) {
  const toast = useToast();
  const [senha, setSenha] = useState(gerarSenha);
  const [enviando, setEnviando] = useState(false);

  async function trocar(e: React.FormEvent) {
    e.preventDefault();
    if (!alvo) return;
    setEnviando(true);
    try {
      await gerirUsuarios({ acao: 'senha', id: alvo.id, senha });
      onTrocada({ nome: alvo.nome, email: '(o mesmo de sempre)', senha });
      setSenha(gerarSenha());
    } catch (x) {
      toast('erro', x instanceof Error ? x.message : String(x));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <Sheet aberto={!!alvo} onFechar={onFechar} titulo={`Nova senha — ${alvo?.nome ?? ''}`}>
      <form className="stack" onSubmit={trocar}>
        <Campo rotulo="Nova senha" dica="Mínimo de 8 caracteres. A pessoa continua logada nos aparelhos até a sessão expirar.">
          <div className="row">
            <input className="input grow" required minLength={8} value={senha} onChange={(e) => setSenha(e.target.value)} style={{ fontFamily: 'monospace' }} />
            <button type="button" className="btn btn-ghost" onClick={() => setSenha(gerarSenha())}>Gerar outra</button>
          </div>
        </Campo>
        <button className="btn btn-primary btn-lg" disabled={enviando}>{enviando ? 'Salvando…' : 'Salvar nova senha'}</button>
      </form>
    </Sheet>
  );
}
