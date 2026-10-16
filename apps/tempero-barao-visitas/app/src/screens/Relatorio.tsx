import { Download, Printer } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { relatorioVisitas, type ResultadoVisita } from '../db/api';
import { useAsync } from '../hooks/useAsync';
import { baixar, paraCsv } from '../lib/csv';
import { brl, dataHoraCompleta, diasAtrasISO, hojeISO, inteiro, ROTULO_RESULTADO, ROTULO_VALIDACAO, soData, soHora } from '../lib/formatar';
import { ehGestao, useSessao } from '../state/sessao';
import { Carregando, Kpi, Vazio } from '../ui/componentes';
import { BadgeCheck, CalendarCheck, HandCoins, ShieldCheck } from 'lucide-react';

const PERIODOS = [['7', 'Últimos 7 dias'], ['30', 'Últimos 30 dias'], ['90', 'Últimos 90 dias'], ['0', 'Tudo']] as const;

export default function Relatorio() {
  const { usuario, usuarios } = useSessao();
  const uid = usuario!.id;
  const gestao = ehGestao(usuario);
  const [dias, setDias] = useState('30');
  const [vendedorId, setVendedorId] = useState('');
  const [resultado, setResultado] = useState<ResultadoVisita | ''>('');
  const filtro = useMemo(() => ({ de: dias === '0' ? undefined : diasAtrasISO(Number(dias)), ate: hojeISO(), vendedorId: vendedorId || undefined, resultado }), [dias, vendedorId, resultado]);
  const r = useAsync(() => relatorioVisitas(uid, filtro), [uid, filtro]);
  const linhas = r.dados ?? [];
  const conf = linhas.filter((l) => l.validacao === 'confirmada' || l.validacao === 'validada_gestor').length;
  const pedidos = linhas.filter((l) => l.resultado === 'pedido');
  const valor = linhas.reduce((a, l) => a + (l.valorPedido ?? 0), 0);

  function exportar() {
    baixar(`relatorio-visitas-${hojeISO()}.csv`, paraCsv([
      ['Data', 'Hora', 'Cliente', 'Código ERP', 'Bairro', 'Cidade', 'Vendedor', 'Tipo', 'Resultado', 'Valor (R$)', 'Próximo passo', 'Retorno combinado', 'Observação', 'Validação', 'Distância do ponto (m)'],
      ...linhas.map((l) => [soData(l.checkinEm), soHora(l.checkinEm), l.ponto, l.codigoErp, l.bairro, l.cidade, l.vendedor, l.tipo,
        l.resultado ? ROTULO_RESULTADO[l.resultado] : '', l.valorPedido?.toFixed(2).replace('.', ','), l.proximoPasso, l.retornoEm, l.observacao,
        ROTULO_VALIDACAO[l.validacao], l.distanciaM != null ? Math.round(l.distanciaM) : '']),
    ]));
  }

  return (
    <div className="stack-lg">
      <div className="row between wrap">
        <div>
          <h1 className="h1">Relatório de visitas</h1>
          <p className="muted small">{gestao ? 'Todas as visitas registradas, com data e hora.' : 'Suas visitas registradas, com data e hora.'}</p>
        </div>
        <div className="row no-print" style={{ gap: 'var(--space-2)' }}>
          <button className="btn btn-ghost btn-sm" onClick={() => window.print()}><Printer size={16} aria-hidden /> Imprimir</button>
          <button className="btn btn-dark btn-sm" onClick={exportar} disabled={linhas.length === 0}><Download size={16} aria-hidden /> Exportar CSV</button>
        </div>
      </div>

      <div className="stack no-print">
        <div className="chips" role="group" aria-label="Período">
          {PERIODOS.map(([k, l]) => <button key={k} className="chip" aria-pressed={dias === k} onClick={() => setDias(k)}>{l}</button>)}
        </div>
        <div className="grid-fluid">
          {gestao && (
            <select className="select" aria-label="Vendedor" value={vendedorId} onChange={(e) => setVendedorId(e.target.value)}>
              <option value="">Todos os vendedores</option>
              {usuarios.filter((u) => u.papel === 'vendedor').map((u) => <option key={u.id} value={u.id}>{u.nome}</option>)}
            </select>
          )}
          <select className="select" aria-label="Resultado" value={resultado} onChange={(e) => setResultado(e.target.value as ResultadoVisita | '')}>
            <option value="">Todos os resultados</option>
            {Object.entries(ROTULO_RESULTADO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
      </div>

      <section className="bento" aria-label="Resumo do período">
        <Kpi icone={CalendarCheck} valor={inteiro(linhas.length)} rotulo="Visitas" />
        <Kpi icone={ShieldCheck} valor={linhas.length ? `${Math.round((100 * conf) / linhas.length)}%` : '–'} rotulo="Com local confirmado" />
        <Kpi icone={BadgeCheck} valor={inteiro(pedidos.length)} rotulo="Pedidos fechados" />
        <Kpi icone={HandCoins} valor={valor ? brl(valor) : '–'} rotulo="Valor informado" />
      </section>

      {r.carregando && !r.dados ? <Carregando linhas={3} /> : linhas.length === 0 ? (
        <Vazio titulo="Nenhuma visita neste período" texto="Quando uma visita for registrada, ela aparece aqui com data e hora." />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Data e hora</th><th>Cliente</th>{gestao && <th>Vendedor</th>}<th>Resultado</th><th>Valor</th><th>Próximo passo</th><th>Local</th></tr></thead>
            <tbody>
              {linhas.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap"><strong>{soData(l.checkinEm)}</strong> <span className="muted">{soHora(l.checkinEm)}</span><div className="xs subtle">{dataHoraCompleta(l.checkinEm).split(',')[0]}</div></td>
                  <td><Link to={`/ponto/${l.pontoId}`} className="strong" style={{ color: 'inherit' }}>{l.ponto}</Link><div className="xs muted">{[l.bairro, l.cidade].filter(Boolean).join(' · ')}</div></td>
                  {gestao && <td>{l.vendedor}</td>}
                  <td>{l.resultado ? ROTULO_RESULTADO[l.resultado] : '—'}</td>
                  <td className="nowrap">{l.valorPedido ? brl(l.valorPedido) : '—'}</td>
                  <td>{l.proximoPasso ?? '—'}{l.retornoEm && <div className="xs muted">retorno {new Date(l.retornoEm + 'T12:00').toLocaleDateString('pt-BR')}</div>}</td>
                  <td><span className={`sem ${l.validacao === 'confirmada' || l.validacao === 'validada_gestor' ? 'sem-verde' : 'sem-amarelo'}`}>{ROTULO_VALIDACAO[l.validacao]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
