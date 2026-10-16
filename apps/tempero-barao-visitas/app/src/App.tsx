import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { ehGestao, useSessao } from './state/sessao';
import Shell from './screens/Shell';
import Entrar from './screens/Entrar';
import Hoje from './screens/Hoje';
import Painel from './screens/Painel';
import Ponto from './screens/Ponto';
import Pontos from './screens/Pontos';
import Esquecidos from './screens/Esquecidos';
import Importar from './screens/Importar';
import Ajustes from './screens/Ajustes';
import Cadastrar from './screens/Cadastrar';
import Relatorio from './screens/Relatorio';
import DesignSystem from './screens/DesignSystem';
import { Carregando } from './ui/componentes';
import { Logo } from './ui/logo';

const Mapa = lazy(() => import('./screens/Mapa')); // Leaflet só carrega quando abre o mapa

export default function App() {
  const { pronto, erro, usuario } = useSessao();

  if (erro) {
    return (
      <div className="page">
        <div className="banner perigo">Não foi possível abrir o banco de dados local: {erro}</div>
      </div>
    );
  }
  if (!pronto) {
    return (
      <div className="page stack" style={{ alignItems: 'center', paddingTop: '18dvh' }}>
        <Logo className="logo" />
        <p className="muted small">Abrindo o banco de dados local…</p>
      </div>
    );
  }

  return (
    <Routes>
      <Route path="/design-system" element={<DesignSystem />} />
      <Route path="/entrar" element={<Entrar />} />
      {!usuario ? (
        <Route path="*" element={<Navigate to="/entrar" replace />} />
      ) : (
        <Route element={<Shell />}>
          <Route index element={ehGestao(usuario) ? <Painel /> : <Hoje />} />
          <Route path="esquecidos" element={<Esquecidos />} />
          <Route
            path="mapa"
            element={
              <Suspense fallback={<Carregando linhas={2} />}>
                <Mapa />
              </Suspense>
            }
          />
          <Route path="pontos" element={<Pontos />} />
          <Route path="ponto/:id" element={<Ponto />} />
          <Route path="cadastrar" element={<Cadastrar />} />
          <Route path="relatorio" element={<Relatorio />} />
          <Route path="importar" element={ehGestao(usuario) ? <Importar /> : <Navigate to="/" replace />} />
          <Route path="ajustes" element={<Ajustes />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      )}
    </Routes>
  );
}
