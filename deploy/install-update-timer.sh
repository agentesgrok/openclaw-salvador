#!/usr/bin/env bash
# Instala (ou reinstala) o timer semanal de update do OpenClaw como serviço systemd de usuário.
#
# Grava ~/.config/systemd/user/openclaw-update.{service,timer} apontando para
# deploy/openclaw-update.sh DESTE repo (caminho calculado — pasta pode ter qualquer nome).
#
# Uso:
#   ./deploy/install-update-timer.sh            # instala/atualiza e arma o timer
#   ./deploy/install-update-timer.sh --dry-run  # só mostra os units
#
# Variáveis opcionais:
#   ON_CALENDAR  janela (default: "Sun *-*-* 08:00:00 UTC" = domingo 05:00 BRT)
#   NODE_BIN     binário Node (default: CLAUDE_NODE_BIN do backend/.env, senão `command -v node`)

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$REPO_DIR/deploy/openclaw-update.sh"
UNIT_DIR="$HOME/.config/systemd/user"
ON_CALENDAR="${ON_CALENDAR:-Sun *-*-* 08:00:00 UTC}"

[ -x "$SCRIPT" ] || { echo "erro: $SCRIPT não existe ou não é executável" >&2; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "erro: rode como o usuário do OpenClaw, não como root" >&2; exit 1; }

if [ -z "${NODE_BIN:-}" ] && [ -f "$REPO_DIR/backend/.env" ]; then
  NODE_BIN="$(grep -E '^CLAUDE_NODE_BIN=' "$REPO_DIR/backend/.env" | tail -1 | cut -d= -f2- || true)"
fi
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
[ -x "$NODE_BIN" ] || { echo "erro: binário Node não encontrado (NODE_BIN='$NODE_BIN')" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"

SERVICE="[Unit]
Description=Update semanal do OpenClaw com gate do e2e e rollback (openclaw-mythos)
After=network-online.target openclaw-gateway.service mythos-backend.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$REPO_DIR
ExecStart=$SCRIPT
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-%h/.config/openclaw-update.env
TimeoutStartSec=3600
"

TIMER="[Unit]
Description=Dispara openclaw-update.service toda semana

[Timer]
OnCalendar=$ON_CALENDAR
RandomizedDelaySec=15min
Persistent=true
Unit=openclaw-update.service

[Install]
WantedBy=timers.target
"

if [ "${1:-}" = "--dry-run" ]; then
  echo "# $UNIT_DIR/openclaw-update.service"; printf '%s\n' "$SERVICE"
  echo "# $UNIT_DIR/openclaw-update.timer"; printf '%s' "$TIMER"
  exit 0
fi

mkdir -p "$UNIT_DIR"
printf '%s' "$SERVICE" > "$UNIT_DIR/openclaw-update.service"
printf '%s' "$TIMER" > "$UNIT_DIR/openclaw-update.timer"
systemctl --user daemon-reload
systemctl --user enable --now openclaw-update.timer >/dev/null
systemctl --user list-timers openclaw-update.timer --no-pager
echo
echo "ok: openclaw-update.timer armado ($ON_CALENDAR) → $SCRIPT"
echo "config: ~/.config/openclaw-update.env (modelo em deploy/openclaw-update.env.example)"
echo "logs:   journalctl --user -u openclaw-update · desligar: systemctl --user disable --now openclaw-update.timer"
