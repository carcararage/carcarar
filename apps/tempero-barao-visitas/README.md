# Tempero Barão · Visitas

Sistema de cadência de visitas: nenhum ponto de venda fica esquecido. Especificação em
[`docs/tempero-barao-spec-funcional.md`](../../docs/tempero-barao-spec-funcional.md).

## Estado atual

| Parte | Estado |
|---|---|
| Banco (regras, permissões, cadência, cadastro, duplicados) | Pronto e testado em Postgres 16 (`supabase/migrations` 0001–0006) |
| Importador do Google Earth (KML/KMZ) | Pronto, roda no navegador; testado com o mapa real da Barão |
| Importador de planilha de clientes (XLSX/CSV) | Pronto: relatório impresso do ERP e tabela simples; testado com a listagem real (ver aviso abaixo) |
| App (PWA) em **modo demonstração** | Pronto: Hoje, Mapa, Ficha, Registrar visita, Cadastrar cliente, Painel, Esquecidos, Pontos, Relatório de visitas (CSV/impressão), Importar, Ajustes, Design System |
| App ligado ao **Supabase** (multiusuário de verdade) | **Falta**: ver "Próximos passos" |

No modo demonstração o banco (Postgres em WebAssembly, [PGlite](https://pglite.dev)) vive **dentro do navegador**, roda exatamente as mesmas migrações do Supabase e guarda tudo em IndexedDB. Serve para validar o processo com os vendedores e funciona offline, mas os dados ficam num só aparelho.

## Rodar o app

```bash
cd app
npm ci
npm run dev        # http://localhost:5173
```

1. Entre como **Gestão Barão** → *Importar* → envie o `.kml` exportado do Google Earth.
2. Confira o que cada pasta significa (status, classe, vendedor) e escolha **como a cadência começa**.
3. Troque de usuário em *Ajustes* para ver o app do **João Oliveira** ou do **Gislandio Silveira**.

Build estático (qualquer hospedagem, inclusive Netlify): `npm run build` → pasta `app/dist`.

## Estrutura

```
supabase/migrations/   0001 base · 0002 importação com ERP · 0003 início da cadência
                       0004 cadastro/duplicados/visibilidade · 0005 planilha sem apagar o mapa
                       0006 planilha casa com o mapa por CNPJ; nome provisório vira nome real
supabase/local/        stub do que o Supabase já entrega (usado em testes e no modo demo)
supabase/tests/        suíte SQL + runner (Postgres real)
app/src/kml/           leitor de KML/KMZ, texto do ERP, mapeamento pasta → status/vendedor
app/src/planilha/      leitor de XLSX/CSV e conversão em clientes
app/src/db/            banco local (PGlite) e camada de dados (api.ts)
app/src/design/        tokens e CSS do design system
app/src/ui, screens/   componentes e telas
app/e2e/               fluxo no Chromium (smoke) e auditoria de acessibilidade (axe)
```

## Testes

```bash
supabase/tests/run_tests.sh           # migrações + regras no Postgres real (precisa de psql/createdb)
cd app && npx vitest run              # importadores + camada de dados em PGlite (56 testes)
cd app && npm run build && npx vite preview --port 4173 &
node e2e/smoke.mjs                    # fluxo completo no Chromium (KML=/caminho para usar o seu arquivo)
node e2e/fluxos.mjs                   # planilha, cadastro, "vinculado a outro vendedor", mapa, relatório
node e2e/a11y.mjs                     # axe-core, telas × temas claro/escuro (0 violações graves)
```

## Regras de visibilidade

- Cada vendedor **acessa só os próprios clientes** (ficha, telefones, CNPJ, histórico).
- Os clientes dos outros vendedores **aparecem** na lista e no mapa, mas só como "vinculado a Fulano" (nome, bairro e local; sem status, classe nem contato). Isso evita cadastro e visita em duplicidade.
- Cadastro de cliente na plataforma **barra duplicados** por CNPJ, código do ERP e nome+cidade, e diz a quem o cliente já pertence. Só a gestão pode "cadastrar mesmo assim".
- Cliente sem localização ganha o ponto pelo GPS do vendedor **uma vez**; corrigir um pino existente é só da gestão.

## Planilha de clientes do ERP: atenção

A "Listagem de Clientes – Detalhado" exportada em Excel perdeu o **nome e o código** de 2.165 dos 2.166 clientes (conferido dentro do arquivo: não estão escondidos). O app avisa isso. Para não travar o cadastro, o importador **já vem marcado** para criar esses clientes com o **endereço como nome provisório** ("Sem nome · Rua X, 10"), sem vendedor (livres, para o vendedor assumir) e sem localização. Os que têm o mesmo **CNPJ** de um pino do mapa são ligados a ele, sem duplicar (na planilha real: 325 de 2.166). Quando você reimportar a planilha com Código/Razão social/Fantasia, o nome provisório é trocado pelo real (casa por CNPJ, código ou endereço). Peça ao ERP uma exportação com as colunas **Código, Razão social e Fantasia** (de preferência "planilha de dados"/CSV, uma linha por cliente): o importador reconhece os cabeçalhos e atualiza sem duplicar.

## Mapa

O fundo do mapa é o OpenStreetMap (sem chave; serve para demonstração e uso leve). Para produção defina `VITE_MAP_TILES` (e `VITE_MAP_ATTRIBUTION`) com um provedor com chave, ex.: MapTiler.

## Privacidade

- O cadastro do ERP que vem no mapa traz CPF, RG, e-mail e limite de crédito. **Nada disso é importado** (testado: nenhum desses dados chega ao banco).
- Localização só é lida **uma vez**, no check-in. Não há rastreamento.
- Dados reais de cliente **não entram no repositório** (o KML de teste é fictício).
- Este repositório publica um site: hospede o app num **repositório privado** próprio antes de usar dados ou chaves reais.

## Próximos passos

1. **Supabase real**: trocar `app/src/db/api.ts` por chamadas ao Supabase (as regras já estão no SQL), login por e-mail/senha, fila offline com reenvio (a chave de idempotência já existe).
2. Aviso diário por WhatsApp e reconciliação de pins movidos no Google Earth.
3. Promotoria com checklist de PDV.

## Convenções

- **Toda regra de negócio fica no banco** (cadência, validação de check-in, permissões), para qualquer front obedecer.
- **Cada nova migração que criar função** deve revogar `EXECUTE` de `public/anon/authenticated` e liberar só o necessário.
- O provedor de mapa (CARTO/OpenStreetMap) é para demonstração: confirme os termos de uso antes de produção e considere uma chave própria.
