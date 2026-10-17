import { CloudAlert, CloudCheck, CloudOff, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { modoReal } from '../sync/modo';
import {
  aoRecusar, descartarRejeitadas, listarFila, sincronizar, useEstadoSync, type ItemFilaEnvio,
} from '../sync/motor';
import { Sheet } from './Sheet';
import { useToast } from './toast';

/** Avisa (uma vez, no Shell) quando o servidor recusar ações feitas offline. */
export function useAvisosSync() {
  const toast = useToast();
  useEffect(
    () => (modoReal() ? aoRecusar((l) => toast('erro', `${l.length === 1 ? 'Uma ação foi recusada' : `${l.length} ações foram recusadas`} pelo servidor: ${l[0].erro}`)) : undefined),
    [toast],
  );
}

const ROTULO_OP: Record<string, string> = {
  visita: 'Visita',
  cadastro: 'Cadastro de cliente',
  localizacao: 'Localização do cliente',
  assumir: 'Assumir cliente',
  contato: 'Contato do cliente',
  atualizar_pontos: 'Edição de clientes',
  regra: 'Regra de cadência',
  raio: 'Raio de check-in',
  validar_visita: 'Validação de visita',
};

function quando(d: Date) {
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** Chip no topo: sinal, quanto falta enviar, e abre a lista de pendências. */
export function IndicadorSync() {
  const e = useEstadoSync();
  const [aberto, setAberto] = useState(false);
  const [fila, setFila] = useState<ItemFilaEnvio[]>([]);
  const ativo = modoReal();

  const carregar = useCallback(() => void listarFila().then(setFila), []);
  useEffect(() => {
    if (aberto) carregar();
  }, [aberto, carregar, e.pendentes, e.rejeitadas]);

  if (!ativo) return null;

  const total = e.pendentes + e.rejeitadas;
  const Icone = !e.online ? CloudOff : e.rejeitadas || e.erro || e.precisaEntrar ? CloudAlert : e.ocupado ? RefreshCw : CloudCheck;
  const texto = e.precisaEntrar
    ? 'Entre de novo'
    : e.rejeitadas
      ? `${e.rejeitadas} recusada${e.rejeitadas > 1 ? 's' : ''}`
      : !e.online
        ? e.pendentes ? `Sem sinal · ${e.pendentes} a enviar` : 'Sem sinal'
        : e.ocupado
          ? 'Sincronizando…'
          : e.pendentes
            ? `${e.pendentes} a enviar`
            : 'Tudo enviado';

  return (
    <>
      <button
        className="chip"
        style={{ minHeight: 44 }}
        onClick={() => setAberto(true)}
        aria-label={`Sincronização: ${texto}. Abrir detalhes`}
      >
        <Icone size={16} aria-hidden className={e.ocupado ? 'girar' : undefined} />
        <span>{texto}</span>
      </button>

      <Sheet aberto={aberto} onFechar={() => setAberto(false)} titulo="Sincronização">
        <div className="stack">
          <p className="small muted">
            {e.online ? 'Com internet.' : 'Sem internet agora: o que você fizer fica guardado neste aparelho e segue sozinho quando o sinal voltar.'}{' '}
            {e.ultimaSync ? `Última atualização: ${quando(e.ultimaSync)}.` : 'Ainda não sincronizou nesta sessão.'}
          </p>
          {e.precisaEntrar && (
            <div className="banner perigo" role="alert">
              A sessão expirou. Seus dados e as ações pendentes continuam guardados; <Link to="/entrar" className="strong">entre de novo</Link> para enviar.
            </div>
          )}
          {e.erro && <div className="banner perigo" role="alert">{e.erro}</div>}

          {fila.length === 0 ? (
            <p className="small">Nada pendente.</p>
          ) : (
            <div className="list" role="list" aria-label="Ações na fila">
              {fila.map((f) => (
                <div key={f.id} className="item" role="listitem">
                  <div className="row">
                    <span className="grow">
                      <span className="titulo" style={{ display: 'block' }}>{ROTULO_OP[f.tipo] ?? f.tipo}</span>
                      <span className="meta">{quando(f.criadoEm)}</span>
                    </span>
                    <span className={`chip ${f.estado === 'rejeitada' ? 'is-on' : ''}`}>{f.estado === 'rejeitada' ? 'Recusada' : 'Aguardando'}</span>
                  </div>
                  {f.erro && <div className="banner perigo" style={{ marginTop: 'var(--space-2)' }}>{f.erro}</div>}
                  {f.estado === 'rejeitada' && f.tipo === 'visita' && typeof f.dados.observacao === 'string' && f.dados.observacao && (
                    <p className="small muted">Anotação: “{f.dados.observacao}”</p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="row wrap">
            <button className="btn btn-primary" disabled={e.ocupado} onClick={() => void sincronizar()}>
              <RefreshCw size={18} aria-hidden /> Sincronizar agora
            </button>
            {e.rejeitadas > 0 && (
              <button className="btn btn-ghost" onClick={() => void descartarRejeitadas().then(carregar)}>
                Descartar recusadas
              </button>
            )}
          </div>
          {total === 0 && e.online && <p className="small muted">Tudo certo: nada para enviar.</p>}
        </div>
      </Sheet>
    </>
  );
}
