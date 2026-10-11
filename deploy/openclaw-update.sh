#!/usr/bin/env bash
# deploy/openclaw-update.sh — update semanal do OpenClaw (e do CLI do Claude) com gate do e2e e rollback.
#
# Fluxo: posse do pacote → versão elegível (≥ MIN_AGE_DAYS) → backup verificado → preflight e2e
#        → `openclaw update` nativo → doctor/health → `npm run test:e2e` → (rollback se FAIL)
#        → claude-code do mythos com o mesmo portão → aviso no WhatsApp → last-run.json.
#
#   ./deploy/openclaw-update.sh                # modo normal (é o que o timer roda)
#   ./deploy/openclaw-update.sh --check        # só compara versões e diz se há algo elegível (sem efeito)
#   ./deploy/openclaw-update.sh --dry-run      # posse + backup real + `openclaw update --dry-run`; não aplica
#   ./deploy/openclaw-update.sh --now          # ignora a maturação de MIN_AGE_DAYS
#   ./deploy/openclaw-update.sh --skip-mythos  # não mexe no @anthropic-ai/claude-code
#   ./deploy/openclaw-update.sh --notify-test  # manda "teste" para NOTIFY_TO e sai
#   ./deploy/openclaw-update.sh --notify       # com --check: também avisa o resultado
#
# Config: ~/.config/openclaw-update.env (modelo em deploy/openclaw-update.env.example).
# Exit: 0 ok/no-op · 1 falha/revertido · 2 lock ou inconclusivo.
# Nunca rodar como root (HOME viraria /root e o estado do OpenClaw ficaria errado).

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$REPO_DIR/backend"
export PATH="/opt/node/bin:$PATH"

CONF="${OPENCLAW_UPDATE_ENV:-$HOME/.config/openclaw-update.env}"
if [ -f "$CONF" ]; then set -a; . "$CONF"; set +a; fi
NOTIFY_TO="${NOTIFY_TO:-}"
MIN_AGE_DAYS="${MIN_AGE_DAYS:-7}"
KEEP_BACKUPS="${KEEP_BACKUPS:-6}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/.openclaw-backups}"
E2E_RETRIES="${E2E_RETRIES:-3}"
UPDATE_TIMEOUT="${UPDATE_TIMEOUT:-900}"
UPDATE_MYTHOS="${UPDATE_MYTHOS:-1}"
ALLOW_SCRIPTS="@google/genai,esbuild,koffi,protobufjs,openclaw"

MODE=run; NOW=0; DRY=0; SKIP_MYTHOS=0; NOTIFY_ON_CHECK=0
for a in "$@"; do
  case "$a" in
    --check) MODE=check ;;
    --dry-run) DRY=1 ;;
    --now) NOW=1 ;;
    --skip-mythos) SKIP_MYTHOS=1 ;;
    --notify-test) MODE=notify-test ;;
    --notify) NOTIFY_ON_CHECK=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "flag desconhecida: $a" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -ne 0 ] || { echo "erro: não rode como root" >&2; exit 2; }
command -v openclaw >/dev/null || { echo "erro: openclaw não está no PATH" >&2; exit 2; }
command -v jq >/dev/null || { echo "erro: jq não instalado" >&2; exit 2; }

mkdir -p -m 700 "$BACKUP_DIR" "$BACKUP_DIR/runs"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_LOG="$BACKUP_DIR/runs/$TS.log"
STATE="$BACKUP_DIR/last-run.json"
log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$RUN_LOG"; }
run_logged() { "$@" >>"$RUN_LOG" 2>&1; }   # comando com saída só no log

exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { echo "outra execução do openclaw-update em andamento — abortando" >&2; exit 2; }

# ── estado da execução (vai para last-run.json e para a mensagem) ──
INSTALLED=""; TARGET=""; AGE_DAYS=""; ELIGIBLE=0; ELIG_REASON=""
ARCHIVE=""; RESULT="no-op"; DETAIL=""; E2E_SUMMARY=""
MY_PREV=""; MY_TARGET=""; MY_RESULT="skipped"; MY_DETAIL=""
NOTIFY_PENDING=0; EXIT=0
START_EPOCH=$(date +%s)

write_state() {
  jq -n --arg startedAt "$TS" --arg installed "$INSTALLED" --arg target "$TARGET" --arg result "$RESULT" \
        --arg detail "$DETAIL" --arg archive "$ARCHIVE" --arg e2e "$E2E_SUMMARY" \
        --arg myPrev "$MY_PREV" --arg myTarget "$MY_TARGET" --arg myResult "$MY_RESULT" --arg myDetail "$MY_DETAIL" \
        --argjson notifyPending "$NOTIFY_PENDING" --argjson durationS "$(( $(date +%s) - START_EPOCH ))" --arg log "$RUN_LOG" \
        '{startedAt:$startedAt, durationS:$durationS, openclaw:{installed:$installed,target:$target,result:$result,detail:$detail,backup:$archive,e2e:$e2e},
          mythos:{prev:$myPrev,target:$myTarget,result:$myResult,detail:$myDetail}, notifyPending:$notifyPending, log:$log}' > "$STATE"
}

notify() {  # notify "<texto>" — envio puro pelo WhatsApp; falha vira notifyPending
  local msg="$1"
  log "aviso: $msg"
  [ -n "$NOTIFY_TO" ] || return 0
  if openclaw message send --channel whatsapp --target "$NOTIFY_TO" --message "$msg" --json >>"$RUN_LOG" 2>&1; then
    NOTIFY_PENDING=0
  else
    NOTIFY_PENDING=1; log "AVISO: não consegui enviar a mensagem para $NOTIFY_TO (ver log)"
  fi
}

ver_gt() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }
days_since() { echo $(( ( $(date +%s) - $(date -d "$1" +%s) ) / 86400 )); }

# ── 1. posse do pacote (pré-requisito do `openclaw update` nativo; único sudo do fluxo) ──
PKG_DIR="$(dirname "$(readlink -f "$(command -v openclaw)")")"
NPM_PREFIX="$(cd "$PKG_DIR/../../.." && pwd)"
# O ~/.npmrc do usuário aponta prefix=~/.npm-global; qualquer `npm -g` (do updater ou nosso) tem que ir pro prefix real.
export npm_config_prefix="$NPM_PREFIX"
ensure_ownership() {
  local me; me="$(id -un)"
  if [ "$(stat -c %U "$PKG_DIR")" != "$me" ] || [ "$(stat -c %U "$NPM_PREFIX/lib/node_modules")" != "$me" ] || [ "$(stat -c %U "$NPM_PREFIX/bin")" != "$me" ]; then
    log "posse: corrigindo dono de $PKG_DIR, $NPM_PREFIX/lib/node_modules e $NPM_PREFIX/bin para $me (sudo)"
    sudo -n chown -R "$me:$me" "$PKG_DIR"
    sudo -n chown "$me" "$NPM_PREFIX/lib/node_modules" "$NPM_PREFIX/bin"
    sudo -n chown -h "$me" "$NPM_PREFIX/bin/openclaw"
    sudo -n find "$NPM_PREFIX/lib/node_modules" -maxdepth 1 -name '.openclaw*' -exec chown -R "$me:$me" {} + 2>/dev/null || true
  else
    log "posse: ok ($me)"
  fi
  # Arquivos de outro dono dentro de ~/.openclaw (ex.: *.bak criados com sudo) quebram o `backup create` com EACCES.
  local stray; stray="$(sudo -n find "$HOME/.openclaw" ! -user "$me" 2>/dev/null | wc -l)"
  if [ "$stray" -gt 0 ]; then
    log "posse: $stray arquivo(s) em ~/.openclaw não são de $me — corrigindo (sudo)"
    sudo -n find "$HOME/.openclaw" ! -user "$me" -exec chown "$me:$me" {} +
  fi
}

# ── 2. versão elegível ──
resolve_target() {
  INSTALLED="$(openclaw --version | awk '{print $2}')"
  local view; view="$(npm view openclaw dist-tags time --json 2>>"$RUN_LOG")"
  TARGET="$(jq -r '."dist-tags".latest' <<<"$view")"
  local published; published="$(jq -r --arg v "$TARGET" '.time[$v] // empty' <<<"$view")"
  AGE_DAYS="$([ -n "$published" ] && days_since "$published" || echo 0)"
  local status; status="$(openclaw update status --json 2>>"$RUN_LOG" || echo '{}')"
  local issues; issues="$(jq -r '[(.channelIssues // [])[], (.migrationWarnings // [])[]] | map(tostring) | join("; ")' <<<"$status")"
  if [ -n "$issues" ]; then ELIG_REASON="update status com avisos: $issues"; ELIGIBLE=0; RESULT="blocked"; return; fi
  if ! ver_gt "$TARGET" "$INSTALLED"; then ELIG_REASON="já na última estável ($INSTALLED)"; ELIGIBLE=0; return; fi
  if [ "$NOW" = 1 ] || [ "$AGE_DAYS" -ge "$MIN_AGE_DAYS" ]; then
    ELIGIBLE=1; ELIG_REASON="$TARGET publicada há ${AGE_DAYS}d$([ "$NOW" = 1 ] && echo ' (--now)')"
  else
    ELIGIBLE=0; ELIG_REASON="$TARGET disponível, elegível em $(( MIN_AGE_DAYS - AGE_DAYS ))d (publicada há ${AGE_DAYS}d)"
  fi
}

# ── 3. backup ──
do_backup() {
  log "backup: openclaw backup create --output $BACKUP_DIR --verify"
  local out code; set +e; out="$(openclaw backup create --output "$BACKUP_DIR" --verify --json 2>>"$RUN_LOG")"; code=$?; set -e
  printf '%s\n' "$out" >>"$RUN_LOG"
  [ "$code" = 0 ] || { DETAIL="backup falhou (exit $code): $( { sed 's/\x1b\[[0-9;]*m//g' "$RUN_LOG" | grep -i -E 'error|fail' | grep -v -E 'slow |integrity|reclamation' | tail -1 | head -c 200; } || true)"; return 1; }
  ARCHIVE="$(jq -r '.archivePath // empty' <<<"$out" 2>/dev/null)"
  local verified; verified="$(jq -r '.verified // false' <<<"$out" 2>/dev/null)"
  [ -n "$ARCHIVE" ] && [ -f "$ARCHIVE" ] && [ "$verified" = true ] || { DETAIL="backup sem archivePath/verified: $(head -c 200 <<<"$out")"; return 1; }
  log "backup: ok → $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
}
prune_backups() {
  local old
  old="$( { ls -1t "$BACKUP_DIR"/*-openclaw-backup.tar.gz 2>/dev/null || true; } | { grep -v -F "${ARCHIVE:-__none__}" || true; } | tail -n +"$KEEP_BACKUPS" )"
  [ -n "$old" ] || return 0
  while read -r f; do [ -n "$f" ] && { log "retenção: removendo $f"; rm -f "$f"; }; done <<<"$old"
}

# ── 4/6. e2e ──
run_e2e() {  # run_e2e <script-npm> → define E2E_CODE e E2E_SUMMARY
  local script="$1" n=0 out
  while :; do
    n=$((n+1)); out="$BACKUP_DIR/runs/$TS-e2e-$n.json"
    set +e; ( cd "$BACKEND_DIR" && npm run -s "$script" -- --json >"$out" 2>>"$RUN_LOG" ); E2E_CODE=$?; set -e
    E2E_SUMMARY="$(jq -r '"\(.summary.pass) pass, \(.summary.fail) fail, \(.summary.skip) skip" + (([.steps[] | select(.status=="FAIL") | .hint // .id] | unique | join(",")) as $h | if $h != "" then " [" + $h + "]" else "" end)' "$out" 2>/dev/null || echo "sem relatório (exit $E2E_CODE)")"
    log "e2e ($script) tentativa $n: exit $E2E_CODE — $E2E_SUMMARY"
    [ "$E2E_CODE" = 2 ] && [ "$n" -lt "$E2E_RETRIES" ] || break
    log "e2e: inconclusivo, aguardando 120 s"; sleep 120
  done
}

# ── 5. update nativo + pós-checks ──
wait_gateway() {
  local i; for i in $(seq 1 30); do
    openclaw gateway call health --json --timeout 5000 >/dev/null 2>&1 && return 0; sleep 2
  done; return 1
}
post_checks() {
  log "pós-update: doctor --fix --non-interactive"
  run_logged openclaw doctor --fix --non-interactive || { DETAIL="doctor --fix falhou"; return 1; }
  log "pós-update: doctor --post-upgrade"
  run_logged openclaw doctor --post-upgrade --json || { DETAIL="doctor --post-upgrade com erro"; return 1; }
  wait_gateway || { DETAIL="gateway não respondeu em 60 s"; return 1; }
  [ "$(openclaw health --json 2>>"$RUN_LOG" | jq -r '.ok')" = true ] || { DETAIL="openclaw health ok=false"; return 1; }
  [ "$(openclaw channels status --json 2>>"$RUN_LOG" | jq -r '.channels.whatsapp.connected')" = true ] || { DETAIL="WhatsApp não conectou após o update"; return 1; }
  log "pós-update: health ok, whatsapp conectado"
}
apply_update() {  # apply_update <versão>
  local target="$1" out code
  log "update: openclaw update --tag $target --yes --timeout $UPDATE_TIMEOUT"
  set +e; out="$(openclaw update --tag "$target" --yes --json --timeout "$UPDATE_TIMEOUT" 2>>"$RUN_LOG")"; code=$?; set -e
  printf '%s\n' "$out" >>"$RUN_LOG"
  if [ "$code" = 75 ]; then   # handoff para helper em background (serviço gerenciado)
    log "update: handoff (exit 75) — aguardando o helper terminar"
    local i; for i in $(seq 1 90); do
      sleep 10
      [ "$(openclaw update status --json 2>/dev/null | jq -r '.activeRun // .update.activeRun // empty')" = "" ] && break
    done
  elif [ "$code" != 0 ]; then
    DETAIL="openclaw update exit $code: $(jq -r '.error.message // .error // .run.reason // .run.status // "?"' <<<"$out" 2>/dev/null | head -c 200)"; return 1
  fi
  local st; st="$(jq -r '.run.status // .result.status // .status // "?"' <<<"$out" 2>/dev/null)"
  log "update: status do updater = $st$( [ "$st" = skipped ] && echo " ($(jq -r '.run.reason // ""' <<<"$out"))" )"
  case "$st" in rolled-back|error|failed) DETAIL="updater reportou $st: $(jq -r '.run.reason // .error.message // ""' <<<"$out" | head -c 200)"; return 1 ;; esac
  hash -r
  local now; now="$(openclaw --version | awk '{print $2}')"
  [ "$now" = "$target" ] || { DETAIL="após o update, openclaw --version = $now (esperado $target)"; return 1; }
  log "update: binário em $now"
  post_checks
}

# ── 7. rollback ──
rollback() {
  export OPENCLAW_NO_AUTO_UPDATE=1
  log "ROLLBACK: tentando caminho gerenciado (openclaw update --tag $INSTALLED)"
  if apply_update "$INSTALLED"; then
    run_e2e test:e2e
    if [ "$E2E_CODE" = 0 ]; then RESULT="rolled-back"; return 0; fi
    log "ROLLBACK gerenciado: e2e ainda falha ($E2E_SUMMARY) — restaurando o backup"
  else
    log "ROLLBACK gerenciado falhou: $DETAIL — restaurando o backup"
  fi
  local staging="$HOME/.openclaw.restore-$TS"
  log "ROLLBACK: restaurando $ARCHIVE em $staging"
  run_logged openclaw backup restore "$ARCHIVE" --target "$staging" || { RESULT="rollback-failed"; DETAIL="backup restore falhou; backup em $ARCHIVE"; return 1; }
  log "ROLLBACK: parando gateway e trocando ~/.openclaw (cópia atual fica em ~/.openclaw.failed-$TS)"
  systemctl --user stop openclaw-gateway.service
  mv "$HOME/.openclaw" "$HOME/.openclaw.failed-$TS"
  mv "$staging" "$HOME/.openclaw"
  log "ROLLBACK: npm install -g openclaw@$INSTALLED (prefix $NPM_PREFIX)"
  run_logged npm install -g --prefix "$NPM_PREFIX" "openclaw@$INSTALLED" "--allow-scripts=$ALLOW_SCRIPTS" || { RESULT="rollback-failed"; DETAIL="npm install openclaw@$INSTALLED falhou"; systemctl --user start openclaw-gateway.service || true; return 1; }
  hash -r
  run_logged openclaw doctor --fix --non-interactive || log "ROLLBACK: doctor --fix com aviso (ver log)"
  run_logged openclaw plugins update whatsapp || log "ROLLBACK: plugins update whatsapp com aviso (ver log)"
  systemctl --user start openclaw-gateway.service
  wait_gateway || { RESULT="rollback-failed"; DETAIL="gateway não voltou após restore; estado anterior em ~/.openclaw.failed-$TS"; return 1; }
  run_e2e test:e2e
  if [ "$E2E_CODE" = 0 ]; then RESULT="rolled-back"; DETAIL="$DETAIL (restaurado do backup)"; return 0; fi
  RESULT="rollback-failed"; DETAIL="restaurado do backup mas e2e: $E2E_SUMMARY"; return 1
}

# ── 8. mythos: @anthropic-ai/claude-code ──
update_mythos() {
  local view target published age
  MY_PREV="$(cd "$BACKEND_DIR" && node -p "require('@anthropic-ai/claude-code/package.json').version")"
  view="$(npm view @anthropic-ai/claude-code dist-tags time --json 2>>"$RUN_LOG")"
  target="$(jq -r '."dist-tags".latest' <<<"$view")"
  published="$(jq -r --arg v "$target" '.time[$v] // empty' <<<"$view")"
  age="$([ -n "$published" ] && days_since "$published" || echo 0)"
  if ! ver_gt "$target" "$MY_PREV"; then MY_RESULT="no-op"; MY_DETAIL="claude-code já em $MY_PREV"; return 0; fi
  if [ "$NOW" != 1 ] && [ "$age" -lt "$MIN_AGE_DAYS" ]; then MY_RESULT="no-op"; MY_DETAIL="claude-code $target elegível em $(( MIN_AGE_DAYS - age ))d"; return 0; fi
  MY_TARGET="$target"
  if [ "$DRY" = 1 ]; then MY_RESULT="dry-run"; MY_DETAIL="faria: npm install @anthropic-ai/claude-code@$target + restart + e2e:backend"; return 0; fi
  log "mythos: npm install @anthropic-ai/claude-code@$target"
  ( cd "$BACKEND_DIR" && run_logged npm install "@anthropic-ai/claude-code@$target" --no-audit --no-fund ) || { MY_RESULT="failed"; MY_DETAIL="npm install falhou"; return 1; }
  systemctl --user restart mythos-backend.service
  local i; for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:${MYTHOS_PORT:-3456}/v1/models" && break; sleep 2; done
  run_e2e test:e2e:backend
  if [ "$E2E_CODE" = 0 ]; then MY_RESULT="ok"; MY_DETAIL="$MY_PREV → $target ($E2E_SUMMARY); package-lock alterado, commitar"; return 0; fi
  log "mythos: e2e falhou ($E2E_SUMMARY) — voltando para $MY_PREV"
  ( cd "$BACKEND_DIR" && run_logged npm install "@anthropic-ai/claude-code@$MY_PREV" --no-audit --no-fund ) || true
  systemctl --user restart mythos-backend.service
  for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:${MYTHOS_PORT:-3456}/v1/models" && break; sleep 2; done
  run_e2e test:e2e:backend
  if [ "$E2E_CODE" = 0 ]; then MY_RESULT="rolled-back"; MY_DETAIL="$target quebrou o e2e; voltou para $MY_PREV"; else MY_RESULT="rollback-failed"; MY_DETAIL="voltou para $MY_PREV mas e2e: $E2E_SUMMARY"; fi
  return 1
}

# ── 9. mensagem final ──
compose_message() {
  local icon="🟢" oc my
  case "$RESULT" in
    ok) oc="OpenClaw $INSTALLED → $TARGET ok (e2e $E2E_SUMMARY)" ;;
    no-op) oc="OpenClaw: $ELIG_REASON" ;;
    dry-run) oc="OpenClaw dry-run: backup ok, update $TARGET não aplicado" ;;
    blocked) icon="⚠️"; oc="OpenClaw bloqueado: $ELIG_REASON" ;;
    updated-unverified) icon="⚠️"; oc="OpenClaw atualizado para $TARGET mas e2e inconclusivo ($E2E_SUMMARY) — rode npm run test:e2e" ;;
    rolled-back) icon="🔴"; oc="OpenClaw revertido para $INSTALLED: $DETAIL — backup: $ARCHIVE" ;;
    rollback-failed) icon="🔴"; oc="OpenClaw $TARGET FALHOU e o rollback também: $DETAIL — AÇÃO MANUAL" ;;
    failed) icon="🔴"; oc="OpenClaw falhou antes de aplicar: $DETAIL" ;;
    *) oc="OpenClaw: $RESULT $DETAIL" ;;
  esac
  case "$MY_RESULT" in
    ok) my="claude-code $MY_DETAIL" ;;
    no-op|dry-run|skipped) my="claude-code: $MY_DETAIL" ;;
    *) [ "$icon" = "🟢" ] && icon="🔴"; my="claude-code $MY_RESULT: $MY_DETAIL" ;;
  esac
  printf '%s openclaw-update %s\n%s\n%s\n(%ss · log %s)' "$icon" "$TS" "$oc" "$my" "$(( $(date +%s) - START_EPOCH ))" "$(basename "$RUN_LOG")"
}

# ════════════════════════════ main ════════════════════════════
log "openclaw-update $TS — modo=$MODE now=$NOW dry=$DRY skip-mythos=$SKIP_MYTHOS repo=$REPO_DIR"

if [ "$MODE" = notify-test ]; then
  notify "🧪 teste da rotina de update do OpenClaw ($TS) — se chegou, o aviso está funcionando"
  write_state; exit $NOTIFY_PENDING
fi

resolve_target
log "versões: instalada $INSTALLED · latest $TARGET (há ${AGE_DAYS}d) · $ELIG_REASON"
if [ "$MODE" = check ]; then
  [ "$NOTIFY_ON_CHECK" = 1 ] && notify "🔎 openclaw-update check: instalada $INSTALLED · $ELIG_REASON"
  write_state; exit 0
fi

if [ -f "$STATE" ] && [ "$(jq -r '.notifyPending // false' "$STATE")" = true ]; then
  notify "📨 (reenvio) execução anterior: $(jq -r '"\(.openclaw.result) \(.openclaw.detail) · mythos \(.mythos.result)"' "$STATE")"
fi

if [ "$RESULT" = blocked ]; then
  notify "$(compose_message)"; write_state; exit 1
fi

if [ "$ELIGIBLE" = 1 ]; then
  ensure_ownership
  do_backup || { RESULT="failed"; notify "$(compose_message)"; write_state; exit 1; }
  prune_backups
  run_e2e test:e2e:preflight
  if [ "$E2E_CODE" != 0 ]; then
    RESULT="failed"; DETAIL="ambiente já estava com problema antes do update: $E2E_SUMMARY"
    notify "$(compose_message)"; write_state; exit 1
  fi
  if [ "$DRY" = 1 ]; then
    log "dry-run: openclaw update --tag $TARGET --dry-run"
    openclaw update --tag "$TARGET" --dry-run --json 2>>"$RUN_LOG" | tee -a "$RUN_LOG" | jq -c '{status, result: (.result // null), plan: (.plan // .steps // null)}' 2>/dev/null || true
    log "dry-run: faria → update $TARGET → doctor --fix/--post-upgrade → health → e2e (≤$E2E_RETRIES tentativas) → rollback se FAIL"
    RESULT="dry-run"
  elif apply_update "$TARGET"; then
    run_e2e test:e2e
    case "$E2E_CODE" in
      0) RESULT="ok" ;;
      2) RESULT="updated-unverified" ;;
      *) DETAIL="e2e FAIL após $TARGET: $E2E_SUMMARY"; rollback || true ;;
    esac
  else
    log "update falhou: $DETAIL"
    rollback || true
  fi
else
  log "OpenClaw: nada a aplicar ($ELIG_REASON)"
fi

if [ "$SKIP_MYTHOS" = 1 ] || [ "$UPDATE_MYTHOS" != 1 ]; then
  MY_RESULT="skipped"; MY_DETAIL="desligado"
elif [ "$RESULT" = rolled-back ] || [ "$RESULT" = rollback-failed ] || [ "$RESULT" = failed ]; then
  MY_RESULT="skipped"; MY_DETAIL="pulado (OpenClaw falhou)"
else
  update_mythos || true
fi

case "$RESULT" in ok|no-op|dry-run) EXIT=0 ;; updated-unverified) EXIT=2 ;; *) EXIT=1 ;; esac
case "$MY_RESULT" in failed|rolled-back|rollback-failed) EXIT=1 ;; esac

if [ "$RESULT" = no-op ] && { [ "$MY_RESULT" = no-op ] || [ "$MY_RESULT" = skipped ]; }; then
  log "nada a fazer — sem aviso (só --check --notify avisa no-op)"
else
  notify "$(compose_message)"
fi
write_state
log "fim: openclaw=$RESULT mythos=$MY_RESULT exit=$EXIT"
exit $EXIT
