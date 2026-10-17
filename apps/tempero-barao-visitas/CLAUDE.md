# Barão Visitas — regras de operação para quem (pessoa ou IA) mexer neste repositório

Sistema de cadência de visitas da Tempero Barão (Parnaíba-PI). Leia `README.md` e `supabase/README.md` antes de mexer.

## Como as coisas chegam ao ar (tudo por push)

| O que mudou | Como publica |
|---|---|
| `app/` (telas, regras do app) | push na `main` → **Netlify** faz o build e publica sozinho (`netlify.toml`) |
| `supabase/migrations/` ou `supabase/functions/` | push na `main` → GitHub Actions **"Supabase · publicar"** aplica no banco e publica a função |
| Cópia de segurança | Actions **"Backup e manter ativo"**, a cada 5 dias (arquivo em Artifacts, 90 dias) |

Trabalho em branch; só vai para a `main` com testes verdes (Actions **"Testes"**). Nunca force-push na `main`.

## Regras de ouro

1. **Banco só muda por migração nova** (`supabase/migrations/NNNN_nome.sql`, numeração seguinte). Nunca editar migração já publicada. Depois de criar uma: `supabase/gerar_setup.sh` e registrar em `app/src/db/schema.ts` (o teste "migrações do app" avisa se esquecer).
2. **Toda regra de negócio fica no banco** (cadência, raio do check-in, permissões/RLS). O app só chama. Função nova: `revoke` de `public/anon/authenticated` e `grant` só do necessário.
3. **Nada destrutivo em produção sem confirmação humana explícita** (apagar tabela/coluna/dados, `reset`, mudar RLS para mais permissivo, desligar autenticação). Pedir antes e dizer o que será perdido.
4. **Segredos**: só a chave `publishable` (pública) pode estar no código. `SUPABASE_ACCESS_TOKEN`, senha do banco e `service_role` vivem apenas em GitHub Secrets / ambiente da Edge Function. Nunca imprimir, commitar ou colar em chat.
5. **LGPD**: não importar CPF, RG, e-mail de cliente nem limite de crédito; localização só no check-in; cada vendedor só acessa a própria carteira. Dados reais de clientes não entram no repositório (use `app/src/kml/__fixtures__`, que é fictício).
6. **Offline**: toda ação do vendedor passa pela fila (`app/src/sync`) e precisa ser idempotente no servidor (`sync_enviar`). Ao criar ação nova: tipo em `sync_enviar` (SQL) + `enfileirarTx` no app + teste em `app/src/sync/sync.test.ts`.

## Testes (rodar antes de qualquer push)

```bash
supabase/tests/run_tests.sh          # migrações + regras no Postgres (precisa de psql/createdb)
cd app && npx tsc --noEmit && npx vitest run
# navegador, modo real com Supabase simulado:
npx tsx e2e/fake-supabase.mjs &      # porta 54321
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=x npx vite build --outDir dist-real
npx vite preview --outDir dist-real --port 4174 &  &&  node e2e/real.mjs
```

## Dicas de ambiente

- Subir/parar servidores de teste com `pkill -f` dentro do mesmo comando que contém o nome do processo mata o próprio shell: use scripts separados.
- Postgres local para os testes: `pg_ctlcluster 16 main start`.
