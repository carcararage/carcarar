#!/usr/bin/env bash
# Roda a migração + testes num banco Postgres descartável (sem Supabase).
# Uso:  supabase/tests/run_tests.sh            (usa o Postgres local, usuário atual)
#       PGHOST/PGUSER/PGPORT já exportados são respeitados.
set -euo pipefail

AQUI="$(cd "$(dirname "$0")" && pwd)"
BANCO="barao_test_$$"
export PGOPTIONS="${PGOPTIONS:-} -c client_min_messages=warning"

psql_base() { psql -X -q -v ON_ERROR_STOP=1 "$@"; }

cleanup() { dropdb --if-exists "$BANCO" >/dev/null 2>&1 || true; }
trap cleanup EXIT

createdb "$BANCO"

psql_base -d "$BANCO" -f "$AQUI/../local/stub_supabase.sql"
for m in "$AQUI"/../migrations/*.sql; do
  echo "→ migração $(basename "$m")"
  psql_base -d "$BANCO" -f "$m"
done
for t in "$AQUI"/*.test.sql; do
  echo "→ teste $(basename "$t")"
  psql_base -d "$BANCO" -f "$t"
done
echo "✔ banco OK"
