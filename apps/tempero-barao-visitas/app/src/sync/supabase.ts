import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CHAVE_ANON, URL_SUPABASE } from './modo';
import { ErroAuth, ErroRede, ErroServidor, type Transporte } from './transporte';

let cliente: SupabaseClient | null = null;

/** Cliente do Supabase (login + RPC). A chave "anon" é pública por desenho: quem protege os dados é o RLS. */
export function clienteSupabase(): SupabaseClient {
  if (!URL_SUPABASE || !CHAVE_ANON) throw new Error('Supabase não configurado (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY)');
  cliente ??= createClient(URL_SUPABASE, CHAVE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'barao.auth' },
  });
  return cliente;
}

const pareceRede = (msg: string) => /failed to fetch|networkerror|network request failed|load failed|fetch failed|timeout|abort/i.test(msg);

export function transporteSupabase(c: SupabaseClient = clienteSupabase()): Transporte {
  return {
    async rpc<T>(nome: string, args: Record<string, unknown> = {}): Promise<T> {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ErroRede();
      let r;
      try {
        r = await c.rpc(nome, args);
      } catch (e) {
        throw new ErroRede(e instanceof Error ? e.message : String(e));
      }
      if (r.error) {
        const { code, message } = r.error;
        if (r.status === 401 || code === 'PGRST301' || code === 'PGRST303') throw new ErroAuth();
        if (!code && (r.status === 0 || pareceRede(message))) throw new ErroRede(message);
        if (r.status >= 502 && r.status <= 504) throw new ErroRede(message); // servidor/gateway indisponível
        throw new ErroServidor(message, code || null);
      }
      return r.data as T;
    },
  };
}
