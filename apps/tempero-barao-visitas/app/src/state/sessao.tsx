import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { criarUsuario, listarUsuarios, totalPontos, type Usuario } from '../db/api';
import { abrirBanco } from '../db/banco';

interface Sessao {
  pronto: boolean;
  erro: string | null;
  usuario: Usuario | null;
  usuarios: Usuario[];
  pontos: number;
  entrar: (id: string) => void;
  sair: () => void;
  recarregar: () => Promise<void>;
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

export function SessaoProvider({ children }: { children: ReactNode }) {
  const [pronto, setPronto] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [uid, setUid] = useState<string | null>(lerUid);
  const [pontos, setPontos] = useState(0);

  const recarregar = useCallback(async () => {
    let us = await listarUsuarios();
    if (!us.some((u) => u.papel === 'gestor' || u.papel === 'admin')) {
      await criarUsuario('Gestão Barão', 'gestor'); // modo demo: sempre existe alguém para importar o mapa
      us = await listarUsuarios();
    }
    setUsuarios(us);
    setPontos(await totalPontos());
  }, []);

  useEffect(() => {
    abrirBanco({ persistencia: 'idb://tempero-barao-v1' })
      .then(recarregar)
      .then(() => setPronto(true))
      .catch((e: unknown) => setErro(e instanceof Error ? e.message : String(e)));
  }, [recarregar]);

  const usuario = useMemo(() => usuarios.find((u) => u.id === uid) ?? null, [usuarios, uid]);

  const entrar = useCallback((id: string) => {
    try {
      localStorage.setItem(CHAVE_UID, id);
    } catch {
      /* sem armazenamento: vale só nesta aba */
    }
    setUid(id);
  }, []);
  const sair = useCallback(() => {
    try {
      localStorage.removeItem(CHAVE_UID);
    } catch {
      /* ignore */
    }
    setUid(null);
  }, []);

  const valor = useMemo(
    () => ({ pronto, erro, usuario, usuarios, pontos, entrar, sair, recarregar }),
    [pronto, erro, usuario, usuarios, pontos, entrar, sair, recarregar],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

export function useSessao(): Sessao {
  const c = useContext(Ctx);
  if (!c) throw new Error('useSessao fora do SessaoProvider');
  return c;
}

export const ehGestao = (u: Usuario | null) => u?.papel === 'gestor' || u?.papel === 'admin';
