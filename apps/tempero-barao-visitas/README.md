# Tempero Barão · Visitas

Sistema de cadência de visitas: nenhum ponto de venda fica esquecido. Especificação em
[`docs/tempero-barao-spec-funcional.md`](../../docs/tempero-barao-spec-funcional.md).

## Estado atual

| Parte | Estado |
|---|---|
| Banco (regras, permissões, cadência, cadastro, duplicados) | Pronto e testado em Postgres 16 (`supabase/migrations` 0001–0007) |
| Importador do Google Earth (KML/KMZ) | Pronto, roda no navegador; testado com o mapa real da Barão |
| Importador de planilha de clientes (XLSX/CSV) | Pronto: relatório impresso do ERP e tabela simples; testado com a listagem real (ver aviso abaixo) |
| App (PWA) em **modo demonstração** | Pronto: Hoje, Mapa, Ficha, Registrar visita, Cadastrar cliente, Painel, Esquecidos, Pontos, Relatório de visitas (CSV/impressão), Importar, Ajustes, Design System |
| App ligado ao **Supabase** (login, multiusuário, **offline** com fila de envio) | **Pronto e testado** com Postgres real e um "porteiro" simulado; falta só criar o projeto Supabase: ver [`supabase/README.md`](supabase/README.md) |

No modo demonstração o banco (Postgres em WebAssembly, [PGlite](https://pglite.dev)) vive **dentro do navegador**, roda exatamente as mesmas migrações do Supabase e guarda tudo em IndexedDB. Serve para validar o processo com os vendedores e funciona offline, mas os dados ficam num só aparelho.

## Dois modos

- **Demonstração** (padrão, sem configurar nada): o banco (Postgres no navegador) fica só no aparelho; sem login; serve para testar e mostrar.
- **Real** (com `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY`, ver `app/.env.example`): login por e-mail e senha, dados no Supabase, **cópia local para trabalhar sem sinal** e fila de envio. Detalhes e passo a passo em [`supabase/README.md`](supabase/README.md).

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
                       0007 sincronização offline (sync_baixar / sync_enviar)
supabase/setup_producao.sql  todas as migrações num arquivo só, para colar no Supabase
supabase/README.md     passo a passo para colocar no ar + como o offline funciona
app/src/sync/          motor de sincronização, fila offline, login (modo real)
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
cd app && npx vitest run              # importadores + camada de dados em PGlite (77 testes, incl. celular × servidor e gestão de usuários)
cd app && npm run build && npx vite preview --port 4173 &
node e2e/smoke.mjs                    # fluxo completo no Chromium (KML=/caminho para usar o seu arquivo)
node e2e/fluxos.mjs                   # planilha, cadastro, "vinculado a outro vendedor", mapa, relatório
node e2e/a11y.mjs                     # axe-core, telas × temas claro/escuro (0 violações graves)
node e2e/real.mjs                     # modo real: login, trabalho sem internet, volta do sinal (ver supabase/README.md)
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

1. **Criar o projeto Supabase e publicar o app** (`supabase/README.md`).
2. Aviso diário por WhatsApp e reconciliação de pins movidos no Google Earth.
3. Promotoria com checklist de PDV.

## Convenções

- **Toda regra de negócio fica no banco** (cadência, validação de check-in, permissões), para qualquer front obedecer.
- **Cada nova migração que criar função** deve revogar `EXECUTE` de `public/anon/authenticated` e liberar só o necessário.
- O provedor de mapa (CARTO/OpenStreetMap) é para demonstração: confirme os termos de uso antes de produção e considere uma chave própria.
