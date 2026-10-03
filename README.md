# Site Carcarar

Site estático (HTML/CSS/JS puro, sem build). Páginas: `index.html`, `metodo.html`, `cases.html`, `obrigado.html`.

## Estrutura
- `css/style.css` — design system e todas as seções
- `js/main.js` — animações (lente do hero, manifesto, timeline), formulário
- `js/config.js` — **configuração do CRM e contatos**
- `js/cases.js` — lista de cases (vazia = mostra aviso "cases a caminho")
- `assets/` — símbolo e wordmark em SVG

## Ligar o formulário ao Carcarar Core
Edite `leadEndpoint` em `js/config.js`. O formulário envia `POST` com JSON:

```json
{ "nome": "", "email": "", "whatsapp": "", "empresa": "", "segmento": "", "faturamento": "",
  "desafio": "", "origem": "site", "pagina": "/", "enviado_em": "ISO-8601",
  "utm_source": null, "utm_medium": null, "utm_campaign": null, "utm_content": null, "utm_term": null }
```

Regras:
- Sucesso = resposta HTTP 2xx → redireciona para `obrigado.html`. Qualquer outra coisa mostra erro com link de WhatsApp pré-preenchido (nenhum lead se perde em silêncio).
- Token/chave do CRM **nunca** vai no front-end (`js/config.js` é público). Aponte para uma função/proxy no mesmo domínio que guarde o segredo e repasse ao Core, ou para um endpoint público do Core protegido por CORS + rate limit.
- Se o endpoint for de outro domínio, ele precisa liberar CORS para `https://carcarar.com.br`.
- Com `leadEndpoint` vazio, o formulário só mostra o fallback de WhatsApp.
