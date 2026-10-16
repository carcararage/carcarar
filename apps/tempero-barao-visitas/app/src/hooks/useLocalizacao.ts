import { useCallback, useState } from 'react';

export type StatusGps = 'idle' | 'buscando' | 'ok' | 'negado' | 'indisponivel';
export interface Posicao {
  lat: number;
  lng: number;
  precisaoM: number;
}

/** Pede a posição UMA vez, quando o usuário toca (sem rastreamento contínuo — LGPD). */
export function useLocalizacao() {
  const [pos, setPos] = useState<Posicao | null>(null);
  const [status, setStatus] = useState<StatusGps>('idle');

  const pedir = useCallback((): Promise<Posicao | null> => {
    if (!('geolocation' in navigator)) {
      setStatus('indisponivel');
      return Promise.resolve(null);
    }
    setStatus('buscando');
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          const x = { lat: p.coords.latitude, lng: p.coords.longitude, precisaoM: p.coords.accuracy };
          setPos(x);
          setStatus('ok');
          resolve(x);
        },
        (e) => {
          setStatus(e.code === e.PERMISSION_DENIED ? 'negado' : 'indisponivel');
          resolve(null);
        },
        { enableHighAccuracy: true, timeout: 12_000, maximumAge: 30_000 },
      );
    });
  }, []);

  return { pos, status, pedir };
}
