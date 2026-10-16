import {
  BadgeCheck, Bell, CalendarCheck, Ghost, House, Layers, Locate, Map as MapIcon, MapPin, MessageCircle, Moon,
  Navigation, Package, Phone, Search, Store, Sun, TriangleAlert, Upload, UserPlus, WifiOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import mascote from '../brand/mascote.png';
import { useTema } from '../hooks/useTema';
import { Sheet } from '../ui/Sheet';
import { Campo, Carregando, Kpi, Ring, SemaforoBadge, StackBar, Vazio } from '../ui/componentes';
import { Logo } from '../ui/logo';
import { ToastProvider, useToast } from '../ui/toast';

function Sw({ nome, rotulo }: { nome: string; rotulo?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [hex, setHex] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setHex(getComputedStyle(document.documentElement).getPropertyValue(nome).trim()), 0);
    return () => clearTimeout(t);
  });
  return (
    <div className="swatch">
      <i style={{ background: `var(${nome})` }} />
      <span ref={ref}><strong>{rotulo ?? nome.replace('--', '')}</strong><br /><span className="muted">{hex}</span></span>
    </div>
  );
}

const ESCALA = (p: string, n: number[]) => n.map((x) => `--${p}-${x}`);

function Secao({ id, titulo, children, texto }: { id: string; titulo: string; children: React.ReactNode; texto?: string }) {
  return (
    <section className="stack" aria-labelledby={id} style={{ scrollMarginTop: 16 }}>
      <h2 id={id} className="h2">{titulo}</h2>
      {texto && <p className="small muted" style={{ maxWidth: 680 }}>{texto}</p>}
      {children}
    </section>
  );
}

function Demo() {
  const { tema, setTema } = useTema();
  const toast = useToast();
  const [sheet, setSheet] = useState(false);
  const [opt, setOpt] = useState('pedido');
  return (
    <main className="page stack-lg">
      <header className="row between wrap">
        <div className="row"><Logo className="logo logo-md" /></div>
        <div className="row">
          <div className="segmented" role="group" aria-label="Tema">
            <button aria-pressed={tema === 'claro'} onClick={() => setTema('claro')}><Sun size={14} aria-hidden /> Claro</button>
            <button aria-pressed={tema === 'escuro'} onClick={() => setTema('escuro')}><Moon size={14} aria-hidden /> Escuro</button>
          </div>
          <Link className="btn btn-dark btn-sm" to="/">Abrir o app</Link>
        </div>
      </header>

      <section className="hero">
        <img className="mascote" src={mascote} alt="" />
        <div className="stack" style={{ maxWidth: '64%' }}>
          <span className="eyebrow">Design system · v0.1</span>
          <h1 className="hero-title">Barão Visitas, do tempero ao tablet.</h1>
          <p className="small" style={{ opacity: 0.85 }}>Quente como a marca, direto como um app de campo: pensado para o vendedor sob sol forte, com uma mão, às vezes sem sinal.</p>
        </div>
      </section>

      <Secao id="principios" titulo="Princípios">
        <div className="grid-auto">
          {[
            [Locate, 'Legível ao sol', 'Contraste alto, texto grande, nada de cinza claro sobre branco.'],
            [Layers, 'Uma mão só', 'Alvos de toque de 44 px ou mais; ações principais na zona do polegar (barra inferior, gaveta).'],
            [TriangleAlert, 'Nunca só cor', 'Todo estado leva cor, ícone e texto: o semáforo funciona para daltônicos e sob reflexo.'],
            [WifiOff, 'Funciona sem sinal', 'Os dados vivem no aparelho. Reenvios não duplicam; só a localização é lida, uma vez, no check-in.'],
          ].map(([I, t, d]) => {
            const Ic = I as typeof Locate;
            return <div key={t as string} className="card stack" style={{ gap: 6 }}><Ic size={22} aria-hidden /><h3 className="h3">{t as string}</h3><p className="small muted">{d as string}</p></div>;
          })}
        </div>
      </Secao>

      <Secao id="cores" titulo="Cor" texto="Três famílias vindas da marca: o amarelo-ouro de “Barão”, o vermelho de “Temperos” e o marrom-chocolate do contorno e dos posts. Componentes só usam tokens semânticos; trocar de tema é trocar os tokens.">
        <h3 className="h3">Âmbar — a cor da marca</h3>
        <div className="swatches">{ESCALA('amber', [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]).map((n) => <Sw key={n} nome={n} />)}</div>
        <h3 className="h3">Chocolate — neutros quentes</h3>
        <div className="swatches">{ESCALA('choc', [25, 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]).map((n) => <Sw key={n} nome={n} />)}</div>
        <h3 className="h3">Tomate e folha — ação e estado</h3>
        <div className="swatches">{['--tomato-50', '--tomato-500', '--tomato-700', '--leaf-50', '--leaf-500', '--leaf-700', '--sky-500'].map((n) => <Sw key={n} nome={n} />)}</div>
        <h3 className="h3">Semânticos (mudam com o tema)</h3>
        <div className="swatches">{['--bg', '--surface', '--surface-2', '--surface-3', '--border', '--text', '--text-muted', '--primary', '--on-primary', '--accent', '--focus'].map((n) => <Sw key={n} nome={n} />)}</div>
        <h3 className="h3">Semáforo da cadência</h3>
        <div className="row wrap">
          <SemaforoBadge s="verde" /><SemaforoBadge s="amarelo" /><SemaforoBadge s="vermelho" /><SemaforoBadge s="preto" /><SemaforoBadge s={null} />
        </div>
        <StackBar v={46} a={22} r={14} p={8} />
        <p className="hint">Verde: em dia · Amarelo: até meio intervalo de atraso · Vermelho: até um intervalo inteiro · Preto/âmbar: esquecido. Texto escuro sobre âmbar: contraste ≈ 10:1.</p>
      </Secao>

      <Secao id="tipografia" titulo="Tipografia" texto="Fredoka (a fonte da pasta de marca) dá o caráter arredondado e amigável aos títulos e números; Inter cuida da leitura de interface, com algarismos tabulares nos indicadores.">
        <div className="card specimen">
          <div className="display" style={{ fontSize: 'var(--text-4xl)' }}>Aa 128 visitas</div>
          <div className="h1">Título 1 · 28/32</div>
          <div className="h2">Título 2 · 22</div>
          <div className="h3">Título 3 · 18</div>
          <p>Corpo · Inter 16/24. Nenhum cliente fica esquecido quando a cadência cobra por você.</p>
          <p className="small muted">Apoio · 14 — metadados e legendas</p>
          <p className="eyebrow">Sobrelinha · 12 caixa-alta</p>
          <p className="num" style={{ fontSize: 'var(--text-3xl)' }}>1.234,56</p>
        </div>
      </Secao>

      <Secao id="espaco" titulo="Espaço, raio e sombra" texto="Grade de 4 px. Raios generosos (14–28) deixam tudo mais tátil; sombras são quentes (tom de chocolate), nunca cinza puro.">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          {[4, 8, 12, 16, 24, 32, 48].map((n) => <div key={n} className="stack" style={{ alignItems: 'center', gap: 4 }}><i style={{ display: 'block', width: n, height: n, background: 'var(--primary)', borderRadius: 4 }} /><span className="xs muted">{n}</span></div>)}
        </div>
        <div className="row wrap">
          {[['xs', 6], ['sm', 10], ['md', 14], ['lg', 20], ['xl', 28]].map(([n, r]) => <div key={n as string} className="card card-flat" style={{ borderRadius: r as number, width: 84, height: 64, display: 'grid', placeItems: 'center' }}><span className="xs">{n} · {r}</span></div>)}
          {[1, 2, 3].map((n) => <div key={n} className="card card-flat" style={{ boxShadow: `var(--shadow-${n})`, width: 84, height: 64, display: 'grid', placeItems: 'center' }}><span className="xs">sombra {n}</span></div>)}
        </div>
      </Secao>

      <Secao id="botoes" titulo="Botões e chips">
        <div className="row wrap">
          <button className="btn btn-primary">Primário</button>
          <button className="btn btn-dark">Escuro</button>
          <button className="btn btn-soft">Suave</button>
          <button className="btn btn-ghost">Contorno</button>
          <button className="btn btn-danger">Perigo</button>
          <button className="btn btn-primary" disabled>Desativado</button>
          <button className="btn btn-primary btn-sm">Pequeno</button>
          <button className="btn btn-primary btn-lg"><Locate size={20} aria-hidden /> Grande</button>
          <button className="btn btn-ghost btn-icon" aria-label="Ligar"><Phone size={18} /></button>
        </div>
        <div className="row wrap">
          <span className="chip">Informativo</span>
          <button className="chip" aria-pressed="true">Selecionado</button>
          <button className="chip" aria-pressed="false">Não selecionado</button>
          <span className="chip chip-tier">A</span><span className="chip chip-tier">B</span><span className="chip chip-tier">C</span>
        </div>
      </Secao>

      <Secao id="cartoes" titulo="Cartões e indicadores">
        <div className="bento">
          <Kpi icone={Store} valor="656" rotulo="Pontos na base" />
          <Kpi icone={TriangleAlert} valor="38" rotulo="Atrasados" tom="alerta" />
          <Kpi icone={Ghost} valor="12" rotulo="Esquecidos" tom="escuro" />
          <Kpi icone={CalendarCheck} valor="21" rotulo="Visitas hoje" />
        </div>
        <div className="row wrap" style={{ gap: 'var(--space-6)' }}>
          <div className="hero" style={{ padding: 'var(--space-4)' }}><Ring pct={72} /></div>
          <div className="item" style={{ maxWidth: 420, flex: 1 }}>
            <div className="row between"><span className="titulo">MERCANTIL EXEMPLO</span><span className="chip chip-tier">A</span></div>
            <p className="meta">Centro · Parnaíba · Varejo</p>
            <div className="row" style={{ marginTop: 8 }}><SemaforoBadge s="vermelho" /><span className="small muted">Atrasada há 12 dias · 850 m</span></div>
            <div className="item-actions">
              <button className="btn btn-ghost btn-icon btn-sm" style={{ width: 40 }} aria-label="Rota"><Navigation size={18} /></button>
              <button className="btn btn-ghost btn-icon btn-sm" style={{ width: 40 }} aria-label="WhatsApp"><MessageCircle size={18} /></button>
              <span className="spacer" /><button className="btn btn-primary btn-sm">Registrar visita</button>
            </div>
          </div>
        </div>
      </Secao>

      <Secao id="forms" titulo="Formulário e seleção">
        <div className="grid-auto">
          <Campo rotulo="Campo de texto" dica="Dica curta abaixo do campo."><input className="input" placeholder="Ex.: levar amostra" /></Campo>
          <Campo rotulo="Lista"><select className="select"><option>Ativo</option><option>Inativo</option></select></Campo>
          <div className="search"><Search size={18} aria-hidden /><input className="input" placeholder="Buscar" aria-label="Buscar" /></div>
        </div>
        <div className="options" style={{ maxWidth: 520 }}>
          {[['pedido', 'Pedido fechado', BadgeCheck], ['sem', 'Sem demanda', Package]].map(([k, l, I]) => {
            const Ic = I as typeof Package;
            return <button key={k as string} className="option" aria-pressed={opt === k} onClick={() => setOpt(k as string)}><Ic size={20} aria-hidden /> {l as string}</button>;
          })}
        </div>
      </Secao>

      <Secao id="feedback" titulo="Gaveta, avisos e estados">
        <div className="row wrap">
          <button className="btn btn-dark" onClick={() => setSheet(true)}>Abrir gaveta</button>
          <button className="btn btn-ghost" onClick={() => toast('ok', 'Visita registrada. Cadência zerada.')}>Aviso de sucesso</button>
          <button className="btn btn-ghost" onClick={() => toast('aviso', 'Visita salva, aguardando validação.')}>Alerta</button>
          <button className="btn btn-ghost" onClick={() => toast('erro', 'Não foi possível salvar.')}>Erro</button>
        </div>
        <div className="banner">Faixa informativa: use para contexto que não bloqueia.</div>
        <div className="banner perigo">Faixa de atenção: algo precisa de ação.</div>
        <div className="banner ok">Faixa de sucesso.</div>
        <div className="grid-auto"><Carregando linhas={1} /><div className="card"><Vazio titulo="Estado vazio" texto="Sempre explique o que fazer em seguida." /></div></div>
      </Secao>

      <Secao id="icones" titulo="Iconografia" texto="Lucide, traço de 2 px e pontas arredondadas, combinando com os raios do sistema. Sempre acompanha texto ou tem aria-label.">
        <div className="row wrap" style={{ gap: 'var(--space-5)' }}>
          {[[House, 'Hoje'], [MapIcon, 'Mapa'], [Store, 'Pontos'], [Ghost, 'Esquecido'], [Upload, 'Importar'], [MapPin, 'Local'], [Navigation, 'Rota'], [Phone, 'Ligar'], [MessageCircle, 'WhatsApp'], [UserPlus, 'Assumir'], [Bell, 'Aviso'], [BadgeCheck, 'Pedido']].map(([I, l]) => {
            const Ic = I as typeof House;
            return <div key={l as string} className="stack" style={{ alignItems: 'center', gap: 4 }}><Ic size={26} aria-hidden /><span className="xs muted">{l as string}</span></div>;
          })}
        </div>
      </Secao>

      <Secao id="a11y" titulo="Acessibilidade e movimento">
        <ul className="small stack" style={{ paddingLeft: 18, margin: 0 }}>
          <li>Alvos de toque ≥ 44 px (botões, chips de filtro, opções); controles compactos têm ≥ 36 px e espaçamento de 8 px.</li>
          <li>Foco visível de 3 px em todos os controles; ordem de tabulação segue a leitura.</li>
          <li>Contraste: texto escuro sobre âmbar ≈ 10:1; texto sobre superfícies ≥ 4,5:1 nos dois temas (verificar de novo ao mudar tokens).</li>
          <li>Tema claro e escuro por preferência do sistema, com escolha manual em Ajustes.</li>
          <li>Movimento curto (120–360 ms) e desligado em “reduzir movimento”.</li>
        </ul>
      </Secao>

      <Sheet aberto={sheet} onFechar={() => setSheet(false)} titulo="Exemplo de gaveta"
        rodape={<button className="btn btn-primary btn-lg btn-block" onClick={() => setSheet(false)}>Confirmar</button>}>
        <p className="small muted">No celular sobe da base; no desktop vira diálogo central. Fecha com Esc, toque fora ou botão.</p>
      </Sheet>
    </main>
  );
}

export default function DesignSystem() {
  return <ToastProvider><Demo /></ToastProvider>;
}
