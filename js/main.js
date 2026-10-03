/* CARCARAR — comportamento do site. Sem dependências. */
(() => {
  'use strict';
  const C = window.CARCARAR || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- Navegação ---------- */
  const nav = $('.nav');
  const onScroll = () => nav && nav.classList.toggle('solid', scrollY > 30);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  $('.burger')?.addEventListener('click', () => document.body.classList.toggle('menu-open'));
  $$('.nav nav a').forEach(a => a.addEventListener('click', () => document.body.classList.remove('menu-open')));
  $$('.js-year').forEach(e => (e.textContent = new Date().getFullYear()));

  /* ---------- Revelação ao rolar ---------- */
  const io = new IntersectionObserver(es => es.forEach(e => {
    if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }), { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  $$('.rv, .step').forEach(el => io.observe(el));

  /* ---------- Hero: a lente que separa barulho de resultado ---------- */
  const hero = $('.hero');
  if (hero) {
    const noise = ['curtidas', 'alcance', 'seguidores', 'viral', 'trend', 'hashtag', 'views', 'likes', 'barulho', 'stories', 'reels', 'feed', 'post', 'vaidade'];
    const real = ['leads', 'receita', 'margem', 'conversão', 'funil', 'caixa', 'ROI', 'ticket', 'recompra', 'vendas', 'decisão', 'CAC', 'LTV', 'clareza'];
    const cols = 5, rows = 8;
    const build = (cls, list, step) => {
      const f = document.createElement('div'); f.className = 'field ' + cls; f.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < cols * rows; i++) f.insertAdjacentHTML('beforeend', `<span>${list[(i * step) % list.length]}</span>`);
      hero.prepend(f); return f;
    };
    const fReal = build('real', real, 5);
    build('noise', noise, 3);
    const lens = document.createElement('div'); lens.className = 'lens'; lens.setAttribute('aria-hidden', 'true'); hero.prepend(lens);

    let tx = innerWidth * .7, ty = innerHeight * .4, x = tx, y = ty, last = 0;
    hero.addEventListener('pointermove', e => { const r = hero.getBoundingClientRect(); tx = e.clientX - r.left; ty = e.clientY - r.top; last = performance.now(); });
    const tick = t => {
      const r = hero.getBoundingClientRect();
      if (!reduce && t - last > 2200) { // sem ponteiro: a lente "carcara" sozinha
        tx = r.width * (.5 + .38 * Math.sin(t / 2300)); ty = r.height * (.5 + .32 * Math.sin(t / 1700 + 1));
      }
      x += (tx - x) * .09; y += (ty - y) * .09;
      hero.style.setProperty('--x', x + 'px'); hero.style.setProperty('--y', y + 'px');
      lens.style.setProperty('--x', x + 'px'); lens.style.setProperty('--y', y + 'px');
      if (r.bottom > 0 && r.top < innerHeight) requestAnimationFrame(tick); else setTimeout(() => requestAnimationFrame(tick), 250);
    };
    requestAnimationFrame(tick);
    hero.style.setProperty('--r', innerWidth < 700 ? '120px' : '190px');
  }

  /* ---------- Manifesto: palavras acendem conforme a rolagem ---------- */
  const man = $('.manifesto h2');
  if (man) {
    const walk = n => [...n.childNodes].forEach(c => {
      if (c.nodeType === 3) {
        const frag = document.createDocumentFragment();
        c.textContent.split(/(\s+)/).forEach(p => {
          if (!p.trim()) return frag.append(p);
          const s = document.createElement('span'); s.className = 'w'; s.textContent = p; frag.append(s);
        });
        c.replaceWith(frag);
      } else if (c.nodeType === 1) {
        if (c.classList.contains('hl')) { // destaque inteiro vira um bloco de palavras
          c.innerHTML = c.textContent.split(/\s+/).map(w => `<span class="w hl">${w}</span>`).join(' ');
        } else walk(c);
      }
    });
    walk(man);
    const words = $$('.w', man);
    const upd = () => {
      const r = man.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (innerHeight * .85 - r.top) / (r.height + innerHeight * .35)));
      const n = Math.round(p * words.length);
      words.forEach((w, i) => w.classList.toggle('on', i < n));
    };
    addEventListener('scroll', upd, { passive: true }); upd();
  }

  /* ---------- Método: linha que desenha no scroll ---------- */
  const steps = $('.steps');
  if (steps) {
    const upd = () => {
      const r = steps.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (innerHeight * .6 - r.top) / r.height));
      steps.style.setProperty('--p', p.toFixed(3));
    };
    addEventListener('scroll', upd, { passive: true }); upd();
  }

  /* ---------- Cases: renderiza a partir de js/cases.js ---------- */
  const grid = $('#cases');
  if (grid) {
    const list = window.CARCARAR_CASES || [];
    const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
    grid.innerHTML = list.length ? list.map((c, i) => `
      <article class="case rv" style="--d:${(i % 3) * .08}s">
        <div class="cover" style="${c.imagem ? `background-image:url('${esc(c.imagem)}')` : ''}"></div>
        <div class="body"><small>${esc(c.segmento)}</small><h3>${esc(c.titulo)}</h3><p>${esc(c.resumo)}</p>
        ${c.resultado ? `<div class="res">${esc(c.resultado)}</div>` : ''}</div></article>`).join('')
      : `<div class="empty"><b>Cases a caminho.</b>Estamos organizando os resultados dos nossos projetos para mostrar com os números certos.</div>`;
    $$('.rv', grid).forEach(el => io.observe(el));
  }

  /* ---------- Formulário → Carcarar Core ---------- */
  const form = $('#leadForm');
  if (form) {
    const status = $('.status', form), btn = $('button[type=submit]', form);
    const wa = msg => `https://wa.me/${C.whatsapp}?text=${encodeURIComponent(msg)}`;
    const fail = d => {
      const msg = `Olá! Tentei enviar o formulário no site da Carcarar. Sou ${d.nome || ''}${d.empresa ? ' da ' + d.empresa : ''}.`;
      status.className = 'status err';
      status.innerHTML = `Não conseguimos enviar agora. <a href="${wa(msg)}" target="_blank" rel="noopener">Fale com a gente pelo WhatsApp</a>.`;
      btn.disabled = false;
    };
    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (form.elements._honey.value) { location.href = C.obrigadoUrl; return; } // bot: finge sucesso
      const f = Object.fromEntries(new FormData(form));
      const q = new URLSearchParams(location.search);
      const d = {
        nome: f.nome.trim(), email: f.email.trim(), whatsapp: f.whatsapp.trim(),
        empresa: (f.empresa || '').trim(), segmento: f.segmento, faturamento: f.faturamento, desafio: (f.desafio || '').trim(),
        origem: 'site', pagina: location.pathname, enviado_em: new Date().toISOString(),
        utm_source: q.get('utm_source'), utm_medium: q.get('utm_medium'), utm_campaign: q.get('utm_campaign'),
        utm_content: q.get('utm_content'), utm_term: q.get('utm_term')
      };
      btn.disabled = true; status.className = 'status'; status.textContent = 'Enviando…';
      if (!C.leadEndpoint) { console.warn('[carcarar] leadEndpoint não configurado em js/config.js'); return fail(d); }
      try {
        const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
        const res = await fetch(C.leadEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d), signal: ctl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(res.status);
        location.href = C.obrigadoUrl;
      } catch (err) { console.error('[carcarar] falha ao enviar lead', err); fail(d); }
    });
  }
})();
