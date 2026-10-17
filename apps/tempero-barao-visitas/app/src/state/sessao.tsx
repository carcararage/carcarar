import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { criarUsuario, listarUsuarios, totalPontos, type Usuario } from '../db/api';
import { abrirBanco } from '../db/banco';
import { aoMudarSessao, entrarComSenha, prepararAparelho, sairDaConta, sessaoSalva } from '../sync/conta';
import { modoReal } from '../sync/modo';
import { estadoSync, iniciarMotor, sincronizar } from '../sync/motor';
import { transporteSupabase } from '../sync/supabase';
import { definirTransporte } from '../sync/transporte';

interface Sessao {
  pronto: boolean;
  erro: string | null;
  usuario: Usuario | null;
  usuarios: Usuario[];
  pontos: number;
  /** modo demonstração: escolhe um usuário da lista */
  entrar: (id: string) => void;
  /** modo real: e-mail e senha (Supabase Auth) */
  entrarComSenha: (email: string, senha: string) => Promise<void>;
  sair: () => void;
  recarregar: () => Promise<void>;
  /** modo real: baixando a primeira cópia dos dados */
  baixandoPrimeiraVez: boolean;
}

const Ctx = createContext<Sessao | null>(null);
const CHAVE_UID = 'barao.uid';

const lerUid = () => {
  try {
    return localStorage.getItem(CHAVE_UID);
  } catch {
    return null;
  }
};

const BANCO_DEMO = 'idb://tempero-barao-v1';
const BANCO_REAL = 'idb://tempero-barao-real-v1'; // separado: dado de demonstração nunca se mistura com o de verdade

export function SessaoProvider({ children }: { children: ReactNode }) {
  const real = modoReal();
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [uid, setUid] = useState<string | null>(real ? null : lerUid());
  const [pontos, setPontos] = useState(0);
  const [baixando, setBaixando] = useState(false);

  const recarregar = useCallback(async () => {
    let us = await listarUsuarios();
    if (!real && !us.some((u) => u.papel === 'gestor' || u.papel === 'admin')) {
      await criarUsuario('Gestão Barão', 'gestor'); // modo demo: sempre existe alguém para importar o mapa
      us = await listarUsuarios();
    }
    setUsuarios(us);
    setPontos(await totalPontos());
  }, [real]);

  useEffect(() => {
    let cancelado = false;
    let soltar: (() => void) | undefined;
    (async () => {
      await abrirBanco({ persistencia: real ? BANCO_REAL : BANCO_DEMO });
      if (real) {
        if (navigator.storage?.persist) void navigator.storage.persist(); // pede ao navegador para não apagar o banco do aparelho
        definirTransporte(transporteSupabase());
        const s = await sessaoSalva();
        soltar = aoMudarSessao(() => !cancelado && setUid(null));
        if (s) {
          const us = await listarUsuarios();
          if (!us.some((u) => u.id === s.uid)) {
            // primeira vez neste aparelho (ou cópia apagada): precisa baixar antes de abrir
            setBaixando(true);
            await sincronizar({ completo: true });
            setBaixando(false);
          }
          setUid(s.uid);
          iniciarMotor();
        }
      }
      await recarregar();
    })()
      .then(() => !cancelado && setPronto(true))
      .catch((e: unknown) => !cancelado && setErro(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelado = true;
      soltar?.();
    };
  }, [real, recarregar]);

  const usuario = useMemo(() => usuarios.find((u) => u.id === uid) ?? null, [usuarios, uid]);

  const entrar = useCallback((id: string) => {
    try {
      localStorage.setItem(CHAVE_UID, id);
    } catch {
      /* sem armazenamento: vale só nesta aba */
    }
    setUid(id);
  }, []);

  const entrarReal = useCallback(
    async (email: string, senha: string) => {
      const s = await entrarComSenha(email, senha);
      try {
        await prepararAparelho(s.uid);
        definirTransporte(transporteSupabase());
        setBaixando(true);
        await sincronizar({ completo: true });
        const st = estadoSync();
        if (!st.online) throw new Error('Sem conexão. O primeiro acesso neste aparelho precisa de internet.');
        if (st.erro) throw new Error(st.erro);
        await recarregar();
        const us = await listarUsuarios();
        if (!us.some((u) => u.id === s.uid)) throw new Error('Seu usuário ainda não foi liberado. Fale com a administração.');
      } catch (e) {
        await sairDaConta().catch(() => undefined);
        throw e;
      } finally {
        setBaixando(false);
      }
      iniciarMotor();
      setUid(s.uid);
    },
    [recarregar],
  );

  const sair = useCallback(() => {
    if (real) {
      void sairDaConta().catch(() => undefined);
    } else {
      try {
        localStorage.removeItem(CHAVE_UID);
      } catch {
        /* ignore */
      }
    }
    setUid(null);
  }, [real]);

  const valor = useMemo(
    () => ({ pronto, erro, usuario, usuarios, pontos, entrar, entrarComSenha: entrarReal, sair, recarregar, baixandoPrimeiraVez: baixando }),
    [pronto, erro, usuario, usuarios, pontos, entrar, entrarReal, sair, recarregar, baixando],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSessao(): Sessao {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSessao fora do SessaoProvider');
  return c;
}

export const ehGestao = (u: Usuario | null) => u?.papel === 'gestor' || u?.papel === 'admin';
