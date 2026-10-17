#!/usr/bin/env bash
# Publica ESTA pasta (apps/tempero-barao-visitas) como a raiz de um repositório privado próprio.
# Uso (na raiz do repositório carcarar):  apps/tempero-barao-visitas/tools/exportar-para-repo-privado.sh <url-do-repo-vazio> [branch]
set -euo pipefail
DESTINO="${1:?informe a URL do repositório privado (vazio)}"
RAMO="${2:-main}"
RAIZ="$(git rev-parse --show-toplevel)"
cd "$RAIZ"
git subtree split --prefix=apps/tempero-barao-visitas -b barao-export >/dev/null
git push "$DESTINO" "barao-export:refs/heads/$RAMO"
git branch -D barao-export >/dev/null
echo "Publicado em $DESTINO ($RAMO)."
