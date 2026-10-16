import { normaliza } from './geo';

export type Segmento = 'food_service' | 'varejo' | 'rede' | 'outro';

// SUGESTÃO por palavras-chave no nome/pasta. A gestão corrige depois (edição em lote na Carteira).
const REDE = /\b(carvalho super\w*|super\w* carvalho|vanguarda|grupo mateus|mateus (super|mais)\w*|camino)\b/;
const FOOD =
  /\b(restaurante|lanchonete|pizzaria|churrascaria|bar|cantina|cantinho|sorveteria|hamburgueria|espetinho|pastelaria|padaria|panificadora|cafe|cafeteria|buffet|marmitaria|self ?service|quiosque|barraca|tapiocaria|bistro|grill|churrasco)\b/;
const VAREJO =
  /\b(mercad\w*|supermercado|mercantil|minimercado|mini ?mercado|comercial|atacad\w*|atacarejo|distribuidora|deposito|emporio|hortifruti|frigor\w*|acougue|mercearia|armazem|conveni\w*|casa de carnes)\b/;

export function inferirSegmento(nome: string, pasta?: string | null): Segmento {
  const t = normaliza(`${nome} ${pasta ?? ''}`);
  if (REDE.test(t)) return 'rede';
  if (FOOD.test(t)) return 'food_service';
  if (VAREJO.test(t)) return 'varejo';
  return 'outro';
}
