import type { Semaforo } from '../db/api';

export const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const inteiro = (n: number) => n.toLocaleString('pt-BR');

export const ROTULO_SEMAFORO: Record<Semaforo, string> = {
  verde: 'Em dia',
  amarelo: 'Atrasando',
  vermelho: 'Crítico',
  preto: 'Esquecido',
};

export const ROTULO_STATUS: Record<string, string> = {
  prospecto: 'Prospecto',
  em_prospeccao: 'Em prospecção',
  ativo: 'Ativo',
  inativo: 'Inativo (resgate)',
  perdido: 'Perdido',
};

export const ROTULO_SEGMENTO: Record<string, string> = {
  food_service: 'Food service',
  varejo: 'Varejo',
  rede: 'Rede',
  outro: 'Outro',
};

export const ROTULO_RESULTADO: Record<string, string> = {
  pedido: 'Pedido fechado',
  orcamento: 'Orçamento enviado',
  sem_demanda: 'Sem demanda hoje',
  decisor_ausente: 'Decisor ausente',
  reclamacao: 'Reclamação',
  fechado: 'Estabelecimento fechado',
  outro: 'Outro',
};

export const ROTULO_VALIDACAO: Record<string, string> = {
  confirmada: 'Local confirmado',
  fora_do_raio: 'Fora do raio',
  sem_gps: 'Sem GPS',
  sem_coordenadas: 'Ponto sem localização',
  validada_gestor: 'Validada pela gestão',
};

/** "Atrasada há 12 dias", "Vence hoje", "Vence em 3 dias" */
export function textoPrazo(diasAtraso: number): string {
  if (diasAtraso > 1) return `Atrasada há ${diasAtraso} dias`;
  if (diasAtraso === 1) return 'Atrasada há 1 dia';
  if (diasAtraso === 0) return 'Vence hoje';
  if (diasAtraso === -1) return 'Vence amanhã';
  return `Vence em ${-diasAtraso} dias`;
}

export function distanciaTexto(m: number | null): string | null {
  if (m == null) return null;
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0).replace('.', ',')} km`;
}

export function quando(d: Date | null | undefined): string {
  if (!d) return 'nunca';
  const dias = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (dias <= 0) return 'hoje';
  if (dias === 1) return 'ontem';
  if (dias < 30) return `há ${dias} dias`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
}

export const dataHora = (d: Date) =>
  d.toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function saudacao(d = new Date()): string {
  const h = d.getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export const dataExtensa = (d = new Date()) =>
  d.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });

export const iniciais = (nome: string) =>
  nome
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

export const primeiroNome = (nome: string) => nome.split(/\s+/)[0] ?? nome;

export const maisDias = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const FUSO = 'America/Fortaleza';
/** "sex., 16 de out. de 2026, 14:35" no fuso de Parnaíba, independente do aparelho. */
export const dataHoraCompleta = (d: Date) =>
  d.toLocaleString('pt-BR', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: FUSO });
export const soData = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: FUSO });
export const soHora = (d: Date) => d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: FUSO });
export const hojeISO = () => new Date().toLocaleDateString('sv-SE', { timeZone: FUSO }); // AAAA-MM-DD
export const diasAtrasISO = (n: number) => new Date(Date.now() - n * 86_400_000).toLocaleDateString('sv-SE', { timeZone: FUSO });
