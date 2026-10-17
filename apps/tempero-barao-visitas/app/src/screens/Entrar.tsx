import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { modoReal } from '../sync/modo';
import { useSessao } from '../state/sessao';
import { Avatar, Campo } from '../ui/componentes';
import { Logo } from '../ui/logo';

const PAPEL: Record<string, string> = { admin: 'Administração', gestor: 'Gestão', vendedor: 'Vendedor', promotor: 'Promotor' };

export default function Entrar() {
  return modoReal() ? <EntrarComSenha /> : <EntrarDemo />;
}

function EntrarComSenha() {
  const { entrarComSenha, baixandoPrimeiraVez } = useSessao();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [senha, setSenha] = useState('');
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    setEnviando(true);
    try {
      await entrarComSenha(email, senha);
      nav('/');
    } catch (x) {
      setErro(x instanceof Error ? x.message : String(x));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="page stack-lg" style={{ maxWidth: 480 }}>
      <div className="hero" style={{ textAlign: 'center' }}>
        <div className="hero-conteudo" style={{ alignItems: 'center' }}>
          <div className="logo-sticker">
            <Logo className="logo" />
          </div>
          <h1 className="hero-title">Nenhum cliente fica esquecido.</h1>
          <p className="small" style={{ opacity: 0.8 }}>Entre com o e-mail e a senha que a gestão criou para você.</p>
        </div>
      </div>

      <form className="card stack" onSubmit={enviar} aria-label="Entrar">
        <Campo rotulo="E-mail">
          <input className="input" type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Campo>
        <Campo rotulo="Senha">
          <input className="input" type="password" autoComplete="current-password" required value={senha} onChange={(e) => setSenha(e.target.value)} />
        </Campo>
        {erro && <div className="banner perigo" role="alert">{erro}</div>}
        <button className="btn btn-primary btn-lg" disabled={enviando || baixandoPrimeiraVez}>
          {enviando || baixandoPrimeiraVez ? <><span className="spinner" /> {baixandoPrimeiraVez ? 'Baixando seus clientes…' : 'Entrando…'}</> : 'Entrar'}
        </button>
      </form>

      <div className="banner">
        <ShieldCheck size={20} aria-hidden />
        <span>
          O primeiro acesso neste aparelho precisa de internet para baixar seus clientes. Depois, o app funciona <strong>sem sinal</strong>:
          as visitas ficam guardadas e seguem para o servidor quando a conexão voltar.
        </span>
      </div>
    </div>
  );
}

function EntrarDemo() {
  const { usuarios, entrar, pontos } = useSessao();
  const nav = useNavigate();
  return (
    <div className="page stack-lg" style={{ maxWidth: 560 }}>
      <div className="hero" style={{ textAlign: 'center' }}>
        <div className="hero-conteudo" style={{ alignItems: 'center' }}>
          <div className="logo-sticker">
            <Logo className="logo" />
          </div>
          <h1 className="hero-title">Nenhum cliente fica esquecido.</h1>
          <p className="small" style={{ opacity: 0.8 }}>Visitas, cadência e cobrança num lugar só.</p>
        </div>
      </div>

      <section className="stack" aria-labelledby="quem">
        <h2 id="quem" className="h2">Quem está usando?</h2>
        <div className="list">
          {usuarios.map((u) => (
            <button
              key={u.id}
              className="item row"
              style={{ textAlign: 'left', cursor: 'pointer', width: '100%' }}
              onClick={() => {
                entrar(u.id);
                nav('/');
              }}
            >
              <Avatar nome={u.nome} grande />
              <span className="grow">
                <span className="titulo" style={{ display: 'block' }}>{u.nome}</span>
                <span className="meta">{PAPEL[u.papel]}</span>
              </span>
              <ChevronRight aria-hidden />
            </button>
          ))}
        </div>
      </section>

      <div className="banner">
        <ShieldCheck size={20} aria-hidden />
        <span>
          <strong>Modo demonstração.</strong> Os dados ficam só neste aparelho, dentro do navegador
          {pontos > 0 ? ` (${pontos} pontos carregados)` : ' (ainda vazio: entre como Gestão e importe o mapa do Google Earth)'}.
          Nada é enviado para a internet.
        </span>
      </div>
    </div>
  );
}
