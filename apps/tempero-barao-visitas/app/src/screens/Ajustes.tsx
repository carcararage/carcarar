import { Download, LogOut, Palette, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { copiaDeSeguranca, lerRaioCheckin, listarRegras, salvarRaioCheckin, salvarRegra, zerarTudo, type RegraCadencia } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { useTema, type Tema } from '../hooks/useTema';
import { ROTULO_STATUS } from '../lib/formatar';
import { modoReal } from '../sync/modo';
import { sincronizar, useEstadoSync } from '../sync/motor';
import { ehGestao, useSessao } from '../state/sessao';
import { Avatar, Campo } from '../ui/componentes';
import { useToast } from '../ui/toast';

export default function Ajustes() {
  const { usuario, sair, recarregar } = useSessao();
  const nav = useNavigate();
  const toast = useToast();
  const { tema, setTema } = useTema();
  const gestao = ehGestao(usuario);
  const regras = useAsync(() => (gestao ? listarRegras(usuario!.id) : Promise.resolve([])), [usuario?.id]);
  const raio = useAsync(() => (gestao ? lerRaioCheckin(usuario!.id) : Promise.resolve(150)), [usuario?.id]);
  const [confirmando, setConfirmando] = useState(false);
  const real = modoReal();
  const sync = useEstadoSync();

  const [ultimoBackup, setUltimoBackup] = useState<string | null>(() => {
    try { return localStorage.getItem('barao.ultimoBackup'); } catch { return null; }
  });
  async function baixarBackup() {
    try {
      const c = await copiaDeSeguranca(usuario!.id);
      const arquivo = new Blob([JSON.stringify(c)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(arquivo);
      a.download = `barao-backup-${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' })}.json`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      const agora = new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Fortaleza' });
      try { localStorage.setItem('barao.ultimoBackup', agora); } catch { /* sem armazenamento */ }
      setUltimoBackup(agora);
      toast('ok', `Cópia gerada: ${c.estabelecimentos.length} clientes, ${c.visitas.length} visitas.`);
    } catch (e) {
      toast('erro', e instanceof Error ? e.message : String(e));
    }
  }

  const porStatus = new Map<string, RegraCadencia[]>();
  for (const r of regras.dados ?? []) porStatus.set(r.status, [...(porStatus.get(r.status) ?? []), r]);

  async function salvar(r: RegraCadencia, patch: Partial<RegraCadencia>) {
    const n = { ...r, ...patch };
    if (!(n.intervaloDias > 0) || !(n.peso > 0)) return;
    await salvarRegra(usuario!.id, n);
    toast('ok', `Regra salva: ${ROTULO_STATUS[n.status]} · classe ${n.tier}.`);
    regras.recarregar();
  }

  return (
    <div className="stack-lg">
      <h1 className="h1">Ajustes</h1>

      <section className="card row">
        <Avatar nome={usuario!.nome} grande />
        <div className="grow"><div className="strong">{usuario!.nome}</div><div className="small muted">{usuario!.papel}</div></div>
        <button
          className="btn btn-ghost"
          onClick={() => {
            if (real && sync.pendentes + sync.rejeitadas > 0) {
              toast('aviso', `Há ${sync.pendentes + sync.rejeitadas} ação(ões) sem enviar. Sincronize (ou descarte as recusadas) antes de sair.`);
              return;
            }
            sair();
            nav('/entrar');
          }}
        ><LogOut size={18} aria-hidden /> {real ? 'Sair' : 'Trocar usuário'}</button>
      </section>

      <section className="card stack">
        <h2 className="card-title">Aparência</h2>
        <div className="segmented" role="group" aria-label="Tema" style={{ alignSelf: 'flex-start' }}>
          {([['auto', 'Automático'], ['claro', 'Claro'], ['escuro', 'Escuro']] as [Tema, string][]).map(([k, l]) => (
            <button key={k} aria-pressed={tema === k} onClick={() => setTema(k)}>{l}</button>
          ))}
        </div>
        <Link to="/design-system" className="small strong"><Palette size={14} aria-hidden /> Ver o design system</Link>
      </section>

      {gestao && (
        <>
          <section className="card stack">
            <h2 className="card-title">Dados</h2>
            <p className="small muted">Traga clientes do Google Earth (KML/KMZ) ou de planilha do ERP.</p>
            <Link to="/importar" className="btn btn-soft" style={{ alignSelf: 'flex-start' }}>Importar mapa ou planilha</Link>
          </section>

          <section className="card stack">
            <h2 className="card-title">Regras de cadência</h2>
            <p className="small muted">Intervalo-alvo entre visitas (em dias) e peso na prioridade da fila. Valores iniciais são um ponto de partida: calibre com a operação.</p>
            {[...porStatus.entries()].map(([status, lista]) => (
              <div key={status} className="stack" style={{ gap: 'var(--space-2)' }}>
                <h3 className="h3">{ROTULO_STATUS[status]}</h3>
                {lista.map((r) => (
                  <div key={r.tier} className="row">
                    <span className="chip chip-tier" style={{ minHeight: 32, minWidth: 40, justifyContent: 'center' }}>{r.tier}</span>
                    <label className="grow small">Intervalo (dias)
                      <input className="input" type="number" min={1} max={365} defaultValue={r.intervaloDias} onBlur={(e) => Number(e.target.value) !== r.intervaloDias && void salvar(r, { intervaloDias: Number(e.target.value) })} />
                    </label>
                    <label className="small" style={{ width: 96 }}>Peso
                      <input className="input" type="number" min={0.5} max={10} step={0.5} defaultValue={r.peso} onBlur={(e) => Number(e.target.value) !== r.peso && void salvar(r, { peso: Number(e.target.value) })} />
                    </label>
                  </div>
                ))}
              </div>
            ))}
          </section>

          <section className="card stack">
            <h2 className="card-title">Check-in</h2>
            <Campo rotulo="Raio de confirmação (metros)" dica="Distância máxima entre o GPS do vendedor e o ponto para a visita contar automaticamente.">
              <input className="input" type="number" min={30} max={2000} defaultValue={raio.dados ?? 150} key={raio.dados} style={{ maxWidth: 160 }}
                onBlur={async (e) => { const n = Number(e.target.value); if (n >= 30 && n !== raio.dados) { await salvarRaioCheckin(usuario!.id, n); toast('ok', `Raio ajustado para ${n} m.`); raio.recarregar(); } }} />
            </Campo>
          </section>
        </>
      )}

      {gestao && (
        <section className="card stack">
          <h2 className="card-title">Cópia de segurança</h2>
          <p className="small muted">
            O plano gratuito do servidor não faz backup automático. Baixe uma cópia <strong>toda semana</strong> (clientes, visitas e regras) e guarde no Google Drive da empresa. Em caso de problema, ela permite restaurar tudo.
            {ultimoBackup ? ` Última cópia neste aparelho: ${ultimoBackup}.` : ' Nenhuma cópia feita neste aparelho ainda.'}
          </p>
          <button className="btn btn-soft" style={{ alignSelf: 'flex-start' }} onClick={() => void baixarBackup()}>
            <Download size={18} aria-hidden /> Baixar cópia de segurança
          </button>
        </section>
      )}

      <section className="card stack">
        <h2 className="card-title">Dados deste aparelho</h2>
        {real ? (
          <>
            <p className="small muted">
              O app guarda neste aparelho uma cópia dos seus clientes, para funcionar sem sinal. O que você registrar offline fica na fila e segue para o servidor quando a internet voltar.
              {sync.pendentes ? ` Aguardando envio: ${sync.pendentes}.` : ''}
            </p>
            <button className="btn btn-soft" style={{ alignSelf: 'flex-start' }} disabled={sync.ocupado} onClick={() => void sincronizar({ completo: true }).then(() => toast('ok', 'Dados atualizados.'))}>
              Baixar tudo de novo
            </button>
          </>
        ) : (
          <>
            <p className="small muted">No modo demonstração tudo fica guardado no navegador, sem enviar nada para a internet. Apagar remove usuários, pontos e visitas.</p>
            {!confirmando ? (
              <button className="btn btn-ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setConfirmando(true)}><Trash2 size={18} aria-hidden /> Apagar todos os dados…</button>
            ) : (
              <div className="banner perigo">
                <span className="grow"><strong>Apagar tudo?</strong> Não dá para desfazer.</span>
                <button className="btn btn-sm btn-ghost" onClick={() => setConfirmando(false)}>Cancelar</button>
                <button className="btn btn-sm btn-danger" onClick={async () => { await zerarTudo(); sair(); await recarregar(); setConfirmando(false); toast('ok', 'Dados apagados.'); nav('/entrar'); }}>Apagar</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}
