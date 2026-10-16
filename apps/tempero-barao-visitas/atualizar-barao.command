#!/bin/bash
# Barão Visitas — atualiza o projeto e abre o app no navegador.
# Uso (no Terminal do Mac):  bash ~/Downloads/atualizar-barao.command
BRANCH="claude/awesome-brahmagupta-e7o7jj"
REPO="${BARAO_REPO:-https://github.com/carcararage/carcarar.git}"

titulo() { printf '\n\033[1m%s\033[0m\n' "$*"; }
falha() {
  printf '\n\033[31mERRO: %s\033[0m\n' "$*"
  echo "Copie TUDO o que aparece nesta janela e envie para o Claude."
  [ "${BARAO_DRY:-}" = 1 ] || read -r -p "Aperte Enter para fechar..."
  exit 1
}

command -v git  >/dev/null || falha "O git não está instalado. Rode 'xcode-select --install', espere terminar e tente de novo."
command -v node >/dev/null || falha "O Node.js não está instalado. Baixe a versão LTS em https://nodejs.org, instale e tente de novo."
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || falha "O Node.js está velho ($(node -v)). Instale a versão LTS em https://nodejs.org e tente de novo."

titulo "1/4  Procurando a pasta do projeto..."
PASTA=$(find "$HOME" -maxdepth 6 -type d -name tempero-barao-visitas -path "*/apps/*" -not -path "*/node_modules/*" 2>/dev/null | head -1)
if [ -n "$PASTA" ]; then
  RAIZ="${PASTA%/apps/tempero-barao-visitas}"
  echo "Achei: $RAIZ"
else
  RAIZ="$HOME/carcarar"
  echo "Não achei. Baixando o projeto para $RAIZ ..."
  git clone "$REPO" "$RAIZ" || falha "Não consegui baixar o projeto do GitHub (confira se você está logado no GitHub neste computador)."
fi
cd "$RAIZ" || falha "Não consegui entrar na pasta $RAIZ."

titulo "2/4  Baixando a versão mais nova..."
git fetch origin                              || falha "Não consegui falar com o GitHub (internet ou login)."
git checkout "$BRANCH"                        || falha "Não consegui trocar para a versão nova. Provavelmente há arquivos alterados nesta pasta."
git pull --ff-only origin "$BRANCH"           || falha "Não consegui atualizar para a versão nova."
echo "Versão: $(git log -1 --format='%h %s')"

[ "${BARAO_DRY:-}" = 1 ] && { echo "OK (teste)"; exit 0; }

APP="$RAIZ/apps/tempero-barao-visitas/app"
cd "$APP" || falha "Não achei a pasta do app em $APP."

titulo "3/4  Instalando (pode levar 1 a 2 minutos)..."
npm ci --no-audit --no-fund || npm install --no-audit --no-fund || falha "A instalação falhou."

titulo "4/4  Abrindo o app..."
# se uma versão antiga ainda estiver rodando na porta 5173, encerra
lsof -ti tcp:5173 2>/dev/null | xargs kill 2>/dev/null
(sleep 5; open "http://localhost:5173") &
echo "O app abre sozinho no navegador. Para parar: aperte Ctrl + C nesta janela."
npm run dev -- --port 5173 --strictPort
