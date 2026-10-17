import {
  FileText, Ghost, House, LayoutDashboard, Map as MapaIcone, Moon, Settings, Store, Sun, Upload, Users, type LucideIcon,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTema } from '../hooks/useTema';
import { modoReal } from '../sync/modo';
import { ehGestao, useSessao } from '../state/sessao';
import { Avatar } from '../ui/componentes';
import { IndicadorSync, useAvisosSync } from '../ui/Sincronizacao';
import { Logo } from '../ui/logo';

interface Aba {
  para: string;
  rotulo: string;
  icone: LucideIcon;
  fim?: boolean;
  /** só no menu lateral (desktop); na barra do celular não cabe */
  lateral?: boolean;
}

export default function Shell() {
  const { usuario } = useSessao();
  useAvisosSync();
  const { tema, alternar } = useTema();
  const gestao = ehGestao(usuario);
  const abas: Aba[] = gestao
    ? [
        { para: '/', rotulo: 'Painel', icone: LayoutDashboard, fim: true },
        { para: '/esquecidos', rotulo: 'Esquecidos', icone: Ghost },
        { para: '/mapa', rotulo: 'Mapa', icone: MapaIcone },
        { para: '/pontos', rotulo: 'Pontos', icone: Store },
        { para: '/relatorio', rotulo: 'Relatório', icone: FileText },
        { para: '/importar', rotulo: 'Importar', icone: Upload, lateral: true },
        ...(modoReal() && usuario?.papel === 'admin' ? [{ para: '/equipe', rotulo: 'Equipe', icone: Users, lateral: true }] : []),
      ]
    : [
        { para: '/', rotulo: 'Hoje', icone: House, fim: true },
        { para: '/mapa', rotulo: 'Mapa', icone: MapaIcone },
        { para: '/pontos', rotulo: 'Pontos', icone: Store },
        { para: '/relatorio', rotulo: 'Relatório', icone: FileText },
      ];

  const escuro = tema === 'escuro' || (tema === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);

  return (
    <div className="shell">
      <aside className="sidebar">
        <Logo className="logo" />
        <nav aria-label="Principal">
          {abas.map((a) => (
            <NavLink key={a.para} to={a.para} end={a.fim} className="navlink">
              <a.icone size={20} aria-hidden /> {a.rotulo}
            </NavLink>
          ))}
        </nav>
        <div className="spacer" />
        <nav aria-label="Conta">
          <NavLink to="/ajustes" className="navlink">
            <Settings size={20} aria-hidden /> Ajustes
          </NavLink>
        </nav>
        <div style={{ padding: '0 var(--space-2)' }}><IndicadorSync /></div>
        <div className="row" style={{ padding: '0 var(--space-2)' }}>
          <Avatar nome={usuario!.nome} />
          <div className="grow">
            <div className="strong small ellipsis">{usuario!.nome}</div>
            <div className="xs muted">{usuario!.papel}</div>
          </div>
          <button className="btn btn-ghost btn-icon" onClick={alternar} aria-label="Alternar tema claro/escuro">
            {escuro ? <Sun size={18} /> : <Moon size={18} />}
          </button>
        </div>
      </aside>

      <main>
        <div className="page">
          <header className="page-head" style={{ display: 'flex' }}>
            <span className="lg-hide"><Logo className="logo" /></span>
            <div className="topbar-actions lg-hide">
              <IndicadorSync />
              <button className="btn btn-ghost btn-icon" onClick={alternar} aria-label="Alternar tema claro/escuro">
                {escuro ? <Sun size={18} /> : <Moon size={18} />}
              </button>
              <NavLink to="/ajustes" aria-label="Ajustes e conta">
                <Avatar nome={usuario!.nome} />
              </NavLink>
            </div>
          </header>
          <Outlet />
        </div>
      </main>

      <nav className="tabbar" aria-label="Principal">
        {abas.filter((a) => !a.lateral).map((a) => (
          <NavLink key={a.para} to={a.para} end={a.fim}>
            <a.icone size={22} aria-hidden />
            {a.rotulo}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
