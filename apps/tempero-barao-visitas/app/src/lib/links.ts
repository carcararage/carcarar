/** Links de ação rápida (sem custo de API): ligar, WhatsApp, rota. */
const digitos = (s: string) => s.replace(/\D/g, '');

export const linkTel = (fone: string) => `tel:+55${digitos(fone).replace(/^55/, '')}`;

export function linkWhats(fone: string, texto?: string): string {
  const d = digitos(fone).replace(/^55/, '');
  return `https://wa.me/55${d}${texto ? `?text=${encodeURIComponent(texto)}` : ''}`;
}

/** Abre o app de mapas do celular com a rota até o ponto. */
export const linkRota = (lat: number, lng: number) =>
  `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

export const linkWaze = (lat: number, lng: number) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;

/** WhatsApp só funciona com celular brasileiro (11 dígitos, 9 após o DDD). */
export const ehCelular = (fone: string | null | undefined) => {
  if (!fone) return false;
  const d = digitos(fone).replace(/^55/, '');
  return d.length === 11 && d[2] === '9';
};
