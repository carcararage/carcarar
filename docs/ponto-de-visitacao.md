# Ponto de Visitação — sistema de cadência de visitas para vendas

> Status: ideia em discussão (nada construído). Data: 2026-10-16.
> Objetivo: nenhum cliente fica esquecido, toda visita vira registro, e a gestão consegue cobrar a cadência como alavanca de vendas.

---

## 1. Resposta curta

**Sim, é possível, e é simples de começar.** Mas o insight central é este:

> O problema não é *registrar* visitas. É **saber quem está devendo visita e cobrar isso automaticamente.**

Um "ponto" que só grava check-in resolve auditoria. Um sistema que calcula **"próxima visita devida"** para cada cliente e transforma isso numa fila de trabalho diária resolve o problema que você descreveu (visitas espaçadas, clientes esquecidos). Por isso a arquitetura gira em torno de um **motor de cadência**, não de um formulário.

---

## 2. Conceito: motor de cadência

Cada cliente tem:

| Campo | Exemplo |
|---|---|
| Tier (A/B/C) | A = estratégico |
| Intervalo-alvo (dias) | A=15, B=30, C=60 |
| Última visita | 2026-09-20 |
| **Próxima visita devida** | última visita + intervalo |
| **Razão de atraso** | dias desde a última visita ÷ intervalo-alvo |

Semáforo sugerido (ajustável):

- 🟢 até 1,0 — em dia
- 🟡 1,0 a 1,5 — vencendo/atrasado
- 🔴 acima de 1,5 — crítico
- ⚫ acima de 2,0 — **esquecido** (vai para o topo do painel do gestor)

**Prioridade do dia** = razão de atraso × peso do cliente (tier/valor), agrupada por região para não gerar deslocamento inútil.

> Os intervalos acima são ponto de partida. Fontes de mercado convergem em A ≈ quinzenal/mensal, B ≈ mensal/bimestral, C ≈ trimestral, mas são regras práticas de blogs de fornecedores, **não benchmark independente**. Calibrar com os dados da própria operação (ver seção 9).

Boa prática reforçada nas fontes: o tier não deve ser só faturamento atual; incluir potencial de crescimento e importância estratégica, senão cliente novo promissor fica subvisitado. Também vale permitir **exceções por cliente** (ciclo de compra próprio).

---

## 3. Fluxo do vendedor (precisa levar menos de 1 minuto)

1. Abre o app → tela **"Hoje"**: lista priorizada (vencidos primeiro), com mapa/rota.
2. Toca no cliente → vê **histórico e combinados da última visita** (isso é o "o que eu ganho com isso" do vendedor).
3. **Check-in** (captura GPS no toque).
4. **Nota rápida estruturada**, não texto livre obrigatório:
   - resultado: pedido / orçamento / sem demanda / não encontrou decisor / reclamação
   - próximo passo + data de retorno (alimenta a cadência)
   - observação livre (aceita ditado por voz)
   - foto opcional (gôndola, fachada, proposta)
5. **Check-out**. Se não houver sinal, fica na fila local e sincroniza depois.

Regra de ouro: se registrar visita dá trabalho, o vendedor deixa de registrar. Todo campo obrigatório precisa pagar o próprio custo.

---

## 4. Fluxo do gestor (onde está o valor de "cobrar")

Painel com 5 respostas imediatas:

1. **Quem está esquecido?** Lista de clientes ⚫/🔴 por vendedor e região.
2. **Cobertura da carteira:** % de clientes visitados dentro do intervalo-alvo (KPI principal).
3. **Aderência por vendedor:** visitas feitas × devidas.
4. **Qualidade:** % de visitas com resultado e próximo passo registrados; duração média.
5. **Conversão:** visitas → pedido/orçamento, por tier e por vendedor.

### Mecanismos de cobrança (a estratégia em si)

- **Push/WhatsApp matinal** ao vendedor: "Hoje você tem 3 clientes vencidos na sua região".
- **Resumo semanal** ao gestor: lista de esquecidos + cobertura. Reunião de segunda parte dessa lista, não de achismo.
- **Meta de cobertura** (ex.: ≥ 90% da carteira A no prazo) em vez de meta de "número de visitas" (visita fácil em cliente fácil não conta).
- **Regra de carteira:** cliente ⚫ por X dias entra em "resgate" (outro vendedor, ação remota ou liberado para redistribuição). Isso cria incentivo real para não abandonar cliente.
- **Gamificação leve:** ranking de cobertura, não de volume.

> Risco: se o sistema for percebido só como vigilância, o time resiste ou burla. Mitigação: entregar valor ao vendedor (rota pronta, histórico, lembrete de combinados) e cobrar **resultado de cobertura**, não rastreamento de movimento.

---

## 5. Arquitetura

### 5.1 Três caminhos

| Caminho | Quando faz sentido | Prós | Contras |
|---|---|---|---|
| **A. Comprar** (ex.: Skynamo, BeatRoute, Salesforce/Pipedrive com módulo de visitas) | Equipe grande, quer rodar já | Rápido, maduro | Custo recorrente por usuário; menos controle da regra de cadência. Preços **não verificados** nesta pesquisa. |
| **B. Montar sobre ferramenta existente** (Sheets/Airtable/ClickUp + formulário + automação) | **Validar a ideia em 1–2 semanas** | Quase zero custo, testa adesão | Sem offline, sem GPS confiável, não escala |
| **C. Construir** (PWA + Postgres) | Regra de negócio própria; possibilidade de virar **produto** | Controle total, encaixa a cadência exatamente como você quer | Exige dev e manutenção |

**Recomendação:** B → C. Rodar um piloto manual de 2–4 semanas para provar adesão e calibrar intervalos; só então construir. Se o piloto não pegar entre os vendedores, nenhum software salva.

### 5.2 Arquitetura-alvo (caminho C)

```
 Vendedor (celular)                         Servidor                    Gestor
┌───────────────────────┐          ┌──────────────────────────┐   ┌───────────────┐
│ PWA instalável        │  sync    │ Postgres + PostGIS       │   │ Painel web    │
│  • tela "Hoje"        │ ───────► │  clientes, visitas, notas│ ◄─│  esquecidos   │
│  • check-in/out + GPS │          │  RLS (cada um vê o seu)  │   │  cobertura    │
│  • fila offline local │ ◄─────── │ Job diário: recalcula    │   │  aderência    │
└───────────────────────┘          │  "próxima visita devida" │   └───────────────┘
                                   │ Notificações (push/WhatsApp)│
                                   └──────────────────────────┘
```

Decisões e justificativas:

- **PWA em vez de app nativo:** sem loja, instala pela tela inicial, um código só. Suficiente porque o check-in é um toque (não precisa de rastreamento em segundo plano).
- **Offline-first:** vendedor visita lugar sem sinal. Escrita vai para fila local e sobe ao reconectar. Opções: fila própria em IndexedDB (MVP) ou camada pronta de sync (ex.: PowerSync sobre Supabase, citado nas fontes).
- **Postgres + PostGIS** (ex.: Supabase): permite calcular distância entre o ponto do check-in e o endereço do cliente **no servidor**, que é onde a validação deve ficar (nunca confiar só no cliente).
- **Sem geofence automático:** na web, geofencing só funciona com a aba aberta em primeiro plano. Por isso o check-in é **manual com captura de GPS**, validado depois por distância. Isso também é melhor para LGPD (ver seção 7).
- **Job diário** recalcula a cadência e dispara os avisos. A lógica fica no banco/servidor, não no app.
- **WhatsApp** como canal de cobrança: no Brasil costuma ter mais leitura que push. Exige API oficial/BSP (custo e aprovação de templates, a verificar).
- **Push web no iOS** só funciona com o PWA instalado na tela inicial (comportamento que conheço, mas confirmar versão/regras atuais antes de depender disso).

### 5.3 Modelo de dados (mínimo)

```
usuarios        id, nome, papel (vendedor|gestor), equipe_id
clientes        id, nome, endereco, lat, lng, tier, intervalo_dias,
                vendedor_id, regiao, ativo
visitas         id, cliente_id, vendedor_id, checkin_at, checkout_at,
                checkin_lat, checkin_lng, distancia_m (calculada no servidor),
                resultado, proximo_passo, retorno_em, valido
notas           id, visita_id, texto, foto_url, criado_em
metas           id, escopo, cobertura_alvo, periodo
-- derivado (view/job): proxima_visita_devida, razao_atraso, status_semaforo
```

---

## 6. Anti-burla (check-in falso)

- Distância check-in ↔ endereço cadastrado calculada no servidor; fora do raio vira "visita não confirmada" (não zera, sinaliza).
- Resultado + próximo passo obrigatórios para fechar a visita.
- Foto opcional em tiers A.
- Duração mínima plausível.
- Auditoria por amostragem do gestor, não vigilância contínua.

Nenhum desses é infalível (GPS pode ser simulado); o objetivo é tornar a burla mais trabalhosa que a visita real.

---

## 7. LGPD e trabalhista (validar com advogado antes de ir a produção)

Pesquisa feita **não encontrou orientação específica da ANPD** sobre geolocalização de empregados; o que há são artigos jurídicos e jurisprudência trabalhista. Pontos recorrentes:

- Definir e **registrar a base legal** (discussão comum entre execução de contrato e legítimo interesse, com necessidade e proporcionalidade). Não confirmado nas fontes, validar.
- **Coletar localização só no check-in/out**, não rastrear continuamente; encerrar qualquer monitoramento ao fim da jornada.
- **Política interna/termo** com ciência expressa: o que é coletado, para quê, com quem é compartilhado, por quanto tempo.
- Definir **retenção** (prazo e descarte).
- Geolocalização tem sido aceita como prova no processo do trabalho quando obtida de forma lícita, proporcional e com contraditório. Ou seja, o dado pode ser usado contra a empresa também.

O desenho "check-in manual, sem rastreamento" já é o mais defensável.

---

## 8. Ideia disruptiva (hipótese a validar, não fato)

A Carcarar é uma agência de marketing estratégico. Se o problema aparece na sua operação, provavelmente aparece nos **clientes da Carcarar que têm time de vendas externo** (distribuidoras, indústrias, representações). Duas leituras:

1. **Uso interno:** ferramenta para o seu próprio time.
2. **Serviço/produto para clientes:** "Cadência comercial" como entrega recorrente (implantação + painel + cobrança semanal), conectando marketing (geração de demanda) com vendas (cobertura da carteira). Diferencial: a agência passa a atuar também onde a venda se perde, e o dado de visitas retroalimenta campanhas (ex.: clientes ⚫ recebem ação de reativação por WhatsApp/e-mail enquanto não há visita).

Antes de decidir, precisamos saber **qual é o caso real** (ver perguntas abaixo). Não há evidência na pesquisa de demanda de mercado para essa oferta; é hipótese.

---

## 9. Como provar que funciona (piloto)

- 3–5 vendedores, 4–6 semanas, carteira real.
- Medir antes/depois: **cobertura no prazo**, **intervalo médio entre visitas**, **% de clientes com >2× o intervalo**, **vendas por cliente** (e, se possível, grupo de controle sem o sistema).
- Ressalva honesta: **não encontrei estudo independente** que ligue frequência de visita a aumento de vendas; os números de ROI que circulam são de fornecedores ou hipotéticos. Por isso o piloto com controle é o que torna o argumento defensável, e também calibra os intervalos A/B/C.

---

## 10. Perguntas em aberto

1. Quem são os vendedores: time interno da Carcarar ou de clientes dela?
2. Quantos vendedores e quantos clientes por carteira? (define se planilha aguenta)
3. Já existe cadastro de clientes (CRM, planilha, ERP)? Com endereço/coordenadas?
4. Visita é presencial em campo, ou também há visita remota (vídeo/telefone)?
5. Existe critério hoje para classificar clientes em A/B/C?
6. O canal preferido de cobrança é WhatsApp?
7. Quem é o dono do processo (gestor comercial) e qual a reação esperada do time a ser acompanhado?

---

## 11. Próximos passos sugeridos

1. Responder as perguntas acima.
2. **Semana 1–2:** piloto manual (planilha/Airtable/ClickUp + formulário + painel simples) para testar adesão e calibrar tiers.
3. **Semana 3–6:** decisão comprar × construir com base no piloto.
4. Se construir: MVP = tela "Hoje" + check-in/out + nota estruturada + painel de esquecidos + aviso diário. Offline e WhatsApp entram na segunda iteração.

---

## Fontes consultadas

- [Skynamo — Call cycles vs visit frequencies](https://skynamo.com/blog/call-cycles-vs-visit-frequencies-which-one-helps-field-sales-reps-plan-better-days)
- [Portatour — priorização de clientes ABC na planificação de rotas](https://www.portatour.com/blog/en/?p=5947)
- [Upward — Field sales visit plan](https://upward.jp/en/weblog/field-sales-visit-plan/)
- [slm.mba — frequência de visitas por classe](https://slm.mba/?p=10648)
- [BeatRoute — visit planning software](https://beatroute.io/visit-planning-software/)
- [Creatio Academy — Field sales](https://academy.creatio.com/node/560686)
- [PowerSync — offline-first com Supabase](https://www.powersync.com/blog/bringing-offline-first-to-supabase)
- [PowerSync — dados GIS/PostGIS](https://docs.powersync.com/client-sdks/advanced/gis-data-postgis)
- [Lopes Castelo — geolocalização e prova digital no direito do trabalho](https://lopescastelo.adv.br/geolocalizacao-e-prova-digital-no-direito-do-trabalho/)
- [CACI — case de otimização de força de vendas em campo](https://www.caci.co.uk/insights/republic-technologies/)
- [Espatial — route optimization for field sales](https://www.espatial.com/blog/route-optimization-for-field-sales-teams)

Limitação: a maioria das fontes é de fornecedores (blogs/páginas de produto). Os intervalos e ganhos citados são regras práticas, não evidência independente.
