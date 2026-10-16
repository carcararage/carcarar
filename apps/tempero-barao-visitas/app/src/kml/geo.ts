export type Coord = [lng: number, lat: number]; // KML guarda longitude primeiro

/** "lng,lat[,alt] lng,lat ..." -> [[lng,lat], ...] */
export function parseCoords(texto: string | null | undefined): Coord[] {
  const out: Coord[] = [];
  for (const trecho of (texto ?? '').split(/\s+/)) {
    const p = trecho.split(',');
    if (p.length >= 2) {
      const lng = Number(p[0]);
      const lat = Number(p[1]);
      if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat]);
    }
  }
  return out;
}

export const coordValida = (lng: number, lat: number) =>
  lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90;

/** Ray casting. */
export function pontoNoAnel(lng: number, lat: number, anel: Coord[]): boolean {
  let dentro = false;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [xi, yi] = anel[i];
    const [xj, yj] = anel[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}

export function areaAnel(anel: Coord[]): number {
  let s = 0;
  for (let i = 0; i < anel.length; i++) {
    const [x1, y1] = anel[i];
    const [x2, y2] = anel[(i + 1) % anel.length];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function distanciaKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = (g: number) => (g * Math.PI) / 180;
  const a =
    Math.sin(rad(lat2 - lat1) / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

export function mediana(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Hash de 53 bits (cyrb53), síncrono — serve para chave estável de import, não para segurança. */
export function hash53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

export const semAcento = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
export const normaliza = (s: string) => semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim();
