import '@fontsource-variable/fredoka';
import '@fontsource-variable/inter';
import 'leaflet/dist/leaflet.css';
import './design/tokens.css';
import './design/base.css';
import './design/components.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import { SessaoProvider } from './state/sessao';
import { ToastProvider } from './ui/toast';

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <HashRouter>
      <ToastProvider>
        <SessaoProvider>
          <App />
        </SessaoProvider>
      </ToastProvider>
    </HashRouter>
  </StrictMode>,
);
