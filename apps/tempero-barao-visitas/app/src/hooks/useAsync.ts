import { useCallback, useEffect, useRef, useState } from 'react';

export interface Estado<T> {
  dados: T | null;
  carregando: boolean;
  erro: Error | null;
  recarregar: () => void;
}

/** Carrega dados assíncronos e recarrega quando `deps` mudam. Ignora respostas antigas. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Estado<T> {
  const [dados, setDados] = useState<T | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<Error | null>(null);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    const meu = ++seq.current;
    setCarregando(true);
    fn()
      .then((d) => {
        if (meu === seq.current) {
          setDados(d);
          setErro(null);
        }
      })
      .catch((e: unknown) => {
        if (meu === seq.current) setErro(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => {
        if (meu === seq.current) setCarregando(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const recarregar = useCallback(() => setTick((t) => t + 1), []);
  return { dados, carregando, erro, recarregar };
}
