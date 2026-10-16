import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  aberto: boolean;
  onFechar: () => void;
  titulo: ReactNode;
  children: ReactNode;
  rodape?: ReactNode;
}

/** Gaveta inferior (celular) / diálogo (desktop). Fecha com Esc, toque fora ou botão. */
export function Sheet({ aberto, onFechar, titulo, children, rodape }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const tituloId = useId();

  useEffect(() => {
    if (!aberto) return;
    const antes = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    const tecla = (e: KeyboardEvent) => e.key === 'Escape' && onFechar();
    window.addEventListener('keydown', tecla);
    return () => {
      window.removeEventListener('keydown', tecla);
      document.body.style.overflow = overflow;
      antes?.focus?.();
    };
  }, [aberto, onFechar]);

  if (!aberto) return null;
  return createPortal(
    <>
      <div className="scrim" onClick={onFechar} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={tituloId} tabIndex={-1} ref={ref}>
        <div className="sheet-grip" aria-hidden />
        <div className="sheet-head">
          <h2 id={tituloId} className="h2 grow">{titulo}</h2>
          <button className="btn btn-ghost btn-icon" onClick={onFechar} aria-label="Fechar">
            <X size={20} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
        {rodape && <div className="sheet-foot">{rodape}</div>}
      </div>
    </>,
    document.body,
  );
}
