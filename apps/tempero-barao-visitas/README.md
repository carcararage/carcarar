# Tempero Barão · Visitas

Sistema de cadência de visitas: nenhum ponto de venda fica esquecido. Especificação em
[`docs/tempero-barao-spec-funcional.md`](../../docs/tempero-barao-spec-funcional.md).

## O que existe hoje (Marco 1: base)

```
supabase/migrations/0001_base.sql   modelo, cadência, regras, RLS, funções
supabase/tests/                     mini-Supabase de teste + suíte SQL + runner
tools/kml_import.py                 KML/KMZ (Google Earth) -> importar_estabelecimentos()
tools/tests/                        testes do importador + KML fictício de exemplo
```

Ainda **não há app** (front-end). Também **não foi aplicado num projeto Supabase real**: a migração foi
testada em Postgres 16 local com um stub do que o Supabase fornece (`auth.uid()`, papéis `anon`/`authenticated`).

## Rodar os testes

Precisa de Postgres 16 (com `createdb`/`psql` no PATH e permissão para criar banco) e Python 3.

```bash
supabase/tests/run_tests.sh                 # migração + suíte SQL + importação ponta a ponta
python3 -I tools/tests/test_kml_import.py   # só o importador
```

## Importar o mapa do Google Earth

```bash
python3 -I tools/kml_import.py mapa.kmz --formato sql --saida importar.sql
# resumo (pontos, duplicados, ignorados, regiões) sai no terminal
```

Cole o conteúdo de `importar.sql` no SQL Editor do Supabase e execute (como gestor/admin ou service role).
Pode reimportar à vontade: atualiza nome/endereço/localização e preserva status, tier, carteira e segmento.

## Subir num Supabase (passos previstos, ainda não executados)

1. Criar projeto no Supabase.
2. Aplicar `supabase/migrations/0001_base.sql` (SQL Editor ou `supabase db push`).
3. Criar os usuários em Authentication; cada um ganha perfil de vendedor. Promover gestor/admin:
   `update perfis set papel = 'admin' where id = '<uuid>';`
4. Importar o KML (acima).

## Convenções

- **Toda regra de negócio fica no banco** (cadência, validação de check-in, permissões), para qualquer front obedecer.
- **Cada nova migração que criar função** deve revogar `EXECUTE` de `public/anon/authenticated` e liberar só o necessário
  (no Supabase, funções novas nascem executáveis por `anon`/`authenticated`).
- **Dados reais de cliente não entram no repositório** (só o KML fictício de teste).
- Hospedar este app num **repositório privado** próprio antes de colocar dados ou chaves reais; este repositório publica um site.
