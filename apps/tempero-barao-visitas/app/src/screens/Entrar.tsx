import { ChevronRight, ShieldCheck } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSessao } from '../state/sessao';
import { Avatar } from '../ui/componentes';
import { Logo } from '../ui/logo';

const PAPEL: Record<string, string> = { admin: 'Administração', gestor: 'Gestão', vendedor: 'Vendedor', promotor: 'Promotor' };

export default function Entrar() {
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
