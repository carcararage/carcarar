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

psql_base -d "$BANCO" -f "$AQUI/00_stub_supabase.sql"
for m in "$AQUI"/../migrations/*.sql; do
  echo "→ migração $(basename "$m")"
  psql_base -d "$BANCO" -f "$m"
done
for t in "$AQUI"/*.test.sql; do
  echo "→ teste $(basename "$t")"
  psql_base -d "$BANCO" -f "$t"
done
echo "✔ banco OK"

# --- Ponta a ponta: KML -> importador -> banco (idempotência do reimport) ---------------
RAIZ="$AQUI/../.."
TMP="$(mktemp -d)"; trap 'cleanup; rm -rf "$TMP"' EXIT
python3 -I "$RAIZ/tools/tests/test_kml_import.py" >/dev/null
python3 -I "$RAIZ/tools/kml_import.py" "$RAIZ/tools/tests/fixtures/exemplo.kml" \
        --formato sql --saida "$TMP/importar.sql" 2>/dev/null

q() { psql -X -tA -d "$BANCO" "$@"; }
esperar() { [ "$1" = "$2" ] || { echo "✘ $3: esperado '$2', veio '$1'"; exit 1; }; }

antes=$(q -c "select count(*) from estabelecimentos")
r1=$(q -f "$TMP/importar.sql")
esperar "$r1" '{"regioes": 1, "inseridos": 5, "atualizados": 0}' "1º import"
esperar "$(q -c "select count(*) from estabelecimentos")" "$((antes + 5))" "linhas após 1º import"
esperar "$(q -c "select count(*) from estabelecimentos where regiao_id is not null")" 4 "pontos com região"

# decisão comercial tomada entre os imports não pode ser desfeita pelo reimport
q -c "update estabelecimentos set status='ativo', tier='A' where nome='Restaurante Exemplo 1'" >/dev/null
r2=$(q -f "$TMP/importar.sql")
esperar "$r2" '{"regioes": 1, "inseridos": 0, "atualizados": 5}' "reimport idempotente"
esperar "$(q -c "select count(*) from estabelecimentos")" "$((antes + 5))" "sem duplicar no reimport"
esperar "$(q -c "select status||'/'||tier from estabelecimentos where nome='Restaurante Exemplo 1'")" "ativo/A" "reimport preserva decisões"
esperar "$(q -c "select telefone from estabelecimentos where nome='Restaurante Exemplo 2'")" "86 90000-0002" "telefone importado"
echo "✔ importação ponta a ponta OK"
