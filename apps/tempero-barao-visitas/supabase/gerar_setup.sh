#!/usr/bin/env bash
# Junta todas as migrações em UM arquivo para colar no SQL Editor do Supabase.
# Rode de novo sempre que criar uma migração nova:  supabase/gerar_setup.sh
set -euo pipefail
AQUI="$(cd "$(dirname "$0")" && pwd)"
SAIDA="$AQUI/setup_producao.sql"
{
  echo "-- Tempero Barão · Visitas — instalação do banco no Supabase"
  echo "-- GERADO por supabase/gerar_setup.sh a partir de supabase/migrations/*.sql (não edite à mão)."
  echo "-- Cole TUDO no SQL Editor de um projeto NOVO e execute UMA vez. Não rode em projeto que já tem dados."
  for m in "$AQUI"/migrations/*.sql; do
    echo
    echo "-- ============================================================================"
    echo "-- $(basename "$m")"
    echo "-- ============================================================================"
    cat "$m"
  done
} > "$SAIDA"
echo "gerado: $SAIDA ($(wc -l < "$SAIDA") linhas)"
