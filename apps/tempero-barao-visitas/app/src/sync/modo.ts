/**
 * Dois modos de funcionamento, escolhidos pelo build:
 *  - demonstração (sem variáveis): banco local só neste aparelho, sem login, nada vai para a internet;
 *  - real (VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY): login no Supabase, cópia local para trabalhar
 *    offline e sincronização com o servidor.
 */
export const URL_SUPABASE = (import.meta.env?.VITE_SUPABASE_URL as string | undefined) || undefined;
export const CHAVE_ANON = (import.meta.env?.VITE_SUPABASE_ANON_KEY as string | undefined) || undefined;

let forcado: boolean | null = null;

export function modoReal(): boolean {
  return forcado ?? Boolean(URL_SUPABASE && CHAVE_ANON);
}

/** Só para testes. */
export function forcarModoReal(v: boolean | null) {
  forcado = v;
}
