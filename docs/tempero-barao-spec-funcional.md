# Tempero Barão · Visitas — especificação funcional

> Status: base de dados construída e testada; app ainda não construído. Atualiza o raciocínio de [`ponto-de-visitacao.md`](ponto-de-visitacao.md) agora que o caso é real.
> Código: [`apps/tempero-barao-visitas/`](../apps/tempero-barao-visitas/). Visual/design fica para depois da funcionalidade.

---

## 1. Contexto do cliente (do que já temos nos documentos da Carcarar)

- Parnaíba (PI), desde 2000, 30+ produtos naturais, linha **food service** (restaurantes, lanchonetes) e **varejo regional** (mercados, supermercados).
- Já tem **promotoria ativa em supermercados**. O documento de arquitetura de sell-in cita Carvalho, Vanguarda, Grupo Mateus e Camino como redes-alvo de entrada.
- Pedidos chegam por WhatsApp, e há entrega.
- O problema: visitas muito espaçadas, estabelecimentos esquecidos.
- Premissa de campo: interior do Nordeste tem sinal irregular. O app precisa funcionar offline.

Não sei ainda: nº de vendedores, nº de pontos no mapa, se o mapa é só de clientes ou de todos os estabelecimentos da região, e se existe ERP/planilha de clientes. Ver seção 9.

---

## 2. Decisão: Google Earth é API ou replicar?

**Replicar.** Importar os pontos para o banco do app, com reimportação segura.

| | Integrar por API | **Replicar (escolhido)** |
|---|---|---|
| Existe API de dados do Earth? | **Não encontrei.** A pesquisa achou só exportação KML/KMZ. Para *My Maps* existe a Data Portability API (OAuth, exporta KML/KMZ). | Basta exportar o arquivo. |
| Campos que o app precisa (status, tier, dono, histórico, cadência) | Não existem no Earth | Ficam no nosso banco |
| Offline e velocidade | Depende de rede | Local + sincroniza |
| Permissão por vendedor | Impossível | Feita no banco (RLS) |

Como funciona o import (já feito e testado):
1. Exportar do Google Earth (projeto/pasta → exportar KML/KMZ).
2. `tools/kml_import.py` lê pastas, pontos e polígonos e gera um `select importar_estabelecimentos(...)` pronto para o SQL Editor do Supabase.
3. Reimportar **atualiza** nome, endereço e localização, e **não toca** em status, tier, dono e segmento.
4. Pasta do Earth vira `categoria`/`grupo_origem`; polígono vira **região**, e cada ponto recebe a menor região que o contém.

Limites conhecidos:
- Se alguém **renomear ou mover o pin** no Earth, o reimport cria um ponto novo (a chave é nome + coordenadas). Fase 2: reconciliar por proximidade.
- Ponto removido do Earth não some do app sozinho (decisão manual).
- Se o mapa estiver em **My Maps**, dá para automatizar a exportação depois. No Earth, a exportação é manual.

Mapa na tela e rota:
- Mapa via biblioteca aberta (Leaflet/MapLibre). Rota via **link para Google Maps/Waze** ("Abrir rota"), sem custo de API.
- Não popular a base com geocodificação do Google: os termos do Google Maps Platform limitam o cache de lat/lng vindos das APIs deles (30 dias, em versões de 2024 dos termos; confirmar a versão atual). Nossas coordenadas vêm do KML da Barão.

---

## 3. Modelo mental: universo × carteira

O mapa do Earth provavelmente é o **universo** (tudo que existe na região), e não só os clientes. O sistema separa isso por `status`:

| Status | Significado | Entra na cobrança de visita? |
|---|---|---|
| `prospecto` | Está no mapa, ninguém trabalha | Não (é "oportunidade") |
| `em_prospeccao` | Um vendedor assumiu e está conquistando | Sim (cadência de conquista) |
| `ativo` | Cliente que compra | Sim |
| `inativo` | Parou de comprar | Sim (cadência de **resgate**) |
| `perdido` | Descartado | Não |

Isso evita um erro grave: importar 3 mil pontos e o painel ficar 100% vermelho no dia 1. Só entra na cobrança quem tem dono e status com regra.

---

## 4. Perfis e permissões (testado no banco)

| | Vendedor | Promotor | Gestor | Admin |
|---|---|---|---|---|
| Vê | Própria carteira + pontos sem dono | Pontos sem dono* | Tudo | Tudo |
| Registra visita | Em ponto que enxerga, só em nome próprio | Idem | Idem | Idem |
| Edita ponto | Só telefone/contato/observações dos próprios | — | Tudo | Tudo |
| Assume ponto sem dono | Sim | Não | Sim | Sim |
| Valida visita fora do raio | Não | Não | Sim | Sim |
| Importa KML, edita regras | Não | Não | Sim | Sim |
| Gerencia usuários/papéis | Não | Não | Só leitura | Sim |

\* Promotor precisa de lista própria de lojas. Ainda não modelado (Fase 3).

Vendedor **não vê a carteira de outro vendedor** (evita "roubo de cliente" e vazamento).

---

## 5. Funcionalidades

### MVP (Marcos 2 e 3)

**Vendedor**
1. **Hoje:** fila priorizada por atraso × peso do cliente, com semáforo, distância e botão "Abrir rota". *(lógica pronta: `fila_do_dia`)*
2. **Mapa:** meus pontos coloridos pelo semáforo + oportunidades sem dono por perto.
3. **Assumir ponto:** pega um prospecto sem dono, e ele vira "em prospecção". *(pronto: `assumir_estabelecimento`)*
4. **Ficha do ponto:** histórico de visitas, combinados e próximo passo, contato, ligar/WhatsApp.
5. **Registrar visita:** check-in com GPS → resultado (pedido, orçamento, sem demanda, decisor ausente, reclamação, fechado) → valor do pedido (opcional) → próximo passo + data de retorno → observação (ditado por voz) → foto opcional → check-out.
6. **Offline:** tudo acima funciona sem sinal e sincroniza depois, sem duplicar (chave de idempotência já no banco).

**Gestor**
7. **Painel:** cobertura da carteira por vendedor (% no prazo), esquecidos, críticos, nunca visitados. *(pronto: `v_cobertura_vendedor`)*
8. **Lista de esquecidos:** quem está ⚫ e com qual vendedor, para a reunião de segunda.
9. **Validar visita fora do raio:** aceitar manualmente (fica registrado quem validou).
10. **Carteira:** atribuir/transferir pontos, definir tier e segmento, mudar status.
11. **Importar KML** (tela) e **editar regras** de cadência e raio de check-in.
12. **Usuários:** criar vendedor, definir papel.

### Fase 2
- **Aviso diário** por WhatsApp ao vendedor ("hoje você tem N vencidos") e resumo semanal ao gestor. Exige API oficial do WhatsApp (custo e aprovação de modelos de mensagem a verificar).
- **Reconciliar pins** movidos/renomeados no reimport.
- **Mapa de oportunidades:** onde há muito prospecto sem cliente (buracos de cobertura), e clientes inativos para resgate.
- Rota do dia agrupada por região/proximidade.

### Fase 3 (hipóteses a validar com a Barão)
- **Promotoria com checklist de PDV** (presença, ruptura, preço, foto da gôndola) e lista própria de lojas para o promotor. Hipótese estratégica: os dados de execução em loja podem alimentar o **kit de sell-in** para as redes (comprador de rede quer prova de giro). Depende de a promotoria já coletar algo parecido hoje.
- Integração de pedidos/ERP (se existir).

### Fora do escopo agora
Rastreamento contínuo de GPS (decisão de LGPD: só no check-in), CRM completo de funil, emissão de pedido/nota, app nativo de loja.

---

## 6. Regras de negócio (implementadas e testadas)

1. **Intervalo-alvo** por status × tier, editável sem deploy. Valores iniciais: ativo A/B/C = 15/30/60 dias; em prospecção 10/20/30; inativo (resgate) 20/30/45. **São chute inicial a calibrar no piloto**, não benchmark.
2. **Próxima visita devida** = última visita contada + intervalo. Nunca visitado conta a partir da entrada na carteira (não do cadastro).
3. **Retorno combinado só antecipa**, nunca adia além do intervalo (impede "esconder" cliente empurrando data). Retorno anterior à própria visita é ignorado.
4. **Semáforo:** 🟢 em dia · 🟡 até meio intervalo de atraso · 🔴 até um intervalo inteiro · ⚫ mais que isso (esquecido).
5. **Prioridade** = peso do tier × (1 + atraso/intervalo).
6. **O que zera o relógio:** visita **confirmada** (GPS dentro do raio, padrão 150 m) ou **validada pelo gestor**. Fora do raio, sem GPS e **promotoria** não zeram (promotor repõe gôndola, não substitui o vendedor).
7. **O servidor decide a validação**, não o aparelho: distância calculada no banco; o cliente não consegue marcar a própria visita como confirmada.
8. Autor completa a própria visita por 24 h; depois, só o gestor mexe. Campos de check-in são imutáveis para o autor.
9. Fuso fixo de Parnaíba (UTC-3) para "hoje".

Verificado por testes automatizados, incluindo teste de mutação (quebrei de propósito 3 regras e a suíte falhou nas 3).

---

## 7. Telas (estrutura, sem visual)

**Vendedor (celular):** Hoje · Mapa · Ficha do ponto · Registrar visita · Meu desempenho (cobertura própria).
**Gestor (computador/tablet):** Painel · Esquecidos · Carteira · Visitas a validar · Importar · Regras · Usuários.

---

## 8. Estratégia para a Barão

1. **Segmentar a cadência:** food service (restaurante/lanchonete) = relacionamento e recompra; varejo = reposição e giro; **rede** = conta-chave. Comprador de rede se trata como negociação de sell-in, não por cadência de visita. Já as **lojas** da rede entram como pontos (`segmento = rede`), onde a promotoria atua.
2. **Meta de cobertura, não de visitas:** ≥ X% dos A no prazo, em vez de "número de visitas".
3. **Resgate:** cliente `inativo` tem cadência própria; é a venda mais barata.
4. **Conquista com dono:** prospecto só é cobrado depois que alguém assume. Evita carteira "de ninguém".
5. **Piloto com controle:** 3–5 vendedores, 4–6 semanas, comparar cobertura e vendas por cliente com um grupo sem o sistema. Não achei estudo independente ligando frequência de visita a vendas; o piloto é o que prova.

---

## 9. O que preciso para seguir

1. **Exportar o mapa do Google Earth** (KML/KMZ) e me enviar, ou me dizer onde está. Não encontrei esse arquivo no Drive.
2. O mapa tem só clientes ou todos os estabelecimentos? Que pastas existem (restaurantes, mercados, rotas)?
3. Quantos vendedores e promotores? Quantos pontos?
4. Existe lista de clientes (planilha/ERP) com quem compra e quando foi o último pedido? Isso permite definir `ativo`/`inativo` e tier de partida com dado real.
5. Onde hospedar (conta Supabase da Carcarar ou da Barão?) e quem administra.
6. O sistema ficará na conta da Barão ou é produto da Carcarar para outros clientes? (muda multi-empresa no banco)

---

## 10. Roadmap

| Marco | Entrega | Estado |
|---|---|---|
| 1 | Banco: modelo, cadência, permissões, importador KML, testes | **Feito** |
| 2 | App do vendedor: Hoje, ficha, check-in, nota, offline | Próximo |
| 3 | Painel do gestor, import e regras por tela | |
| 4 | Aviso diário WhatsApp, reconciliação de pins | |
| 5 | Promotoria/checklist PDV | |
| 6 | Design e visual | Depois de validar a funcionalidade |
