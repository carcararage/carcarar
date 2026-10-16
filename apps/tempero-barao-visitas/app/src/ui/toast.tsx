import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type Tipo = 'ok' | 'aviso' | 'erro';
interface T {
  id: number;
  tipo: Tipo;
  texto: string;
}
const Ctx = createContext<(tipo: Tipo, texto: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [itens, setItens] = useState<T[]>([]);
  const mostrar = useCallback((tipo: Tipo, texto: string) => {
    const id = Date.now() + Math.random();
    setItens((l) => [...l, { id, tipo, texto }]);
    setTimeout(() => setItens((l) => l.filter((x) => x.id !== id)), tipo === 'erro' ? 7000 : 4200);
  }, []);
  const v = useMemo(() => mostrar, [mostrar]);
  return (
    <Ctx.Provider value={v}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {itens.map((t) => (
          <div key={t.id} className={`toast ${t.tipo}`}>
            {t.tipo === 'ok' ? <CircleCheck size={20} /> : t.tipo === 'aviso' ? <TriangleAlert size={20} /> : <CircleAlert size={20} />}
            <span>{t.texto}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
