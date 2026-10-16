import { useCallback, useEffect, useState } from 'react';

export type Tema = 'auto' | 'claro' | 'escuro';
const CHAVE = 'barao.tema';

function aplicar(t: Tema) {
  const r = document.documentElement;
  if (t === 'auto') r.removeAttribute('data-theme');
  else r.setAttribute('data-theme', t === 'claro' ? 'light' : 'dark');
}

export function useTema() {
  const [tema, setTema] = useState<Tema>(() => {
    try {
      return (localStorage.getItem(CHAVE) as Tema) || 'auto';
    } catch {
      return 'auto';
    }
  });
  useEffect(() => {
    aplicar(tema);
    try {
      localStorage.setItem(CHAVE, tema);
    } catch {
      /* armazenamento indisponível: segue sem lembrar */
    }
  }, [tema]);
  const alternar = useCallback(() => setTema((t) => (t === 'escuro' ? 'claro' : 'escuro')), []);
  return { tema, setTema, alternar };
}
