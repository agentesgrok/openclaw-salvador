#!/usr/bin/env bash
# Instala (ou reinstala) o serviço systemd de usuário `mythos-backend`.
#
# O WorkingDirectory é calculado a partir da localização DESTE script, então o
# serviço funciona com qualquer nome/caminho de pasta (openclaw-mythos,
# openclaw-salvador, /srv/x…). Se a pasta for renomeada ou movida, basta rodar
# o script de novo — é o que faltou no incidente de 2026-10-10.
#
# Uso:
#   ./deploy/install-service.sh            # instala/atualiza e (re)inicia
#   ./deploy/install-service.sh --dry-run  # só mostra o unit que seria gravado
#
# Variáveis opcionais:
#   NODE_BIN   binário Node pro servidor (default: CLAUDE_NODE_BIN do .env, senão `command -v node`)
#   UNIT_NAME  nome do serviço (default: mythos-backend)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
UNIT_NAME="${UNIT_NAME:-mythos-backend}"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/$UNIT_NAME.service"

[ -f "$BACKEND_DIR/server.js" ] || { echo "erro: $BACKEND_DIR/server.js não existe" >&2; exit 1; }
[ -f "$BACKEND_DIR/.env" ] || echo "aviso: $BACKEND_DIR/.env não existe — copie o .env.example e preencha antes de iniciar" >&2

# Node: NODE_BIN > CLAUDE_NODE_BIN do .env > node do PATH
if [ -z "${NODE_BIN:-}" ] && [ -f "$BACKEND_DIR/.env" ]; then
  NODE_BIN="$(grep -E '^CLAUDE_NODE_BIN=' "$BACKEND_DIR/.env" | tail -1 | cut -d= -f2- || true)"
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || { echo "erro: binário Node não encontrado (NODE_BIN='$NODE_BIN')" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

UNIT_CONTENT="[Unit]
Description=openclaw-mythos backend (Express + Claude Code CLI, LLM proxy /v1)
After=network.target

[Service]
Type=simple
WorkingDirectory=$BACKEND_DIR
ExecStart=$NODE_BIN server.js
Restart=on-failure
RestartSec=5
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
"

if [ "${1:-}" = "--dry-run" ]; then
  echo "# $UNIT_FILE"
  printf '%s' "$UNIT_CONTENT"
  exit 0
fi

mkdir -p "$UNIT_DIR"
printf '%s' "$UNIT_CONTENT" > "$UNIT_FILE"
systemctl --user daemon-reload
systemctl --user enable "$UNIT_NAME.service" >/dev/null
systemctl --user restart "$UNIT_NAME.service"
sleep 2
systemctl --user --no-pager --lines=0 status "$UNIT_NAME.service" || true
echo
echo "ok: $UNIT_NAME → WorkingDirectory=$BACKEND_DIR (node: $NODE_BIN)"
echo "dica: pra manter o serviço rodando sem sessão aberta: loginctl enable-linger $USER"
