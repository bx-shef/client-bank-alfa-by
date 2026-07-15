#!/usr/bin/env bash
# validate-docs.sh — оффлайн-валидация доков триажа обратной связи и вынесенных скриптов.
# Не делает НИ ОДНОГО реального вызова GitHub API. Запуск: bash scripts/validate-docs.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DOC="docs/FEEDBACK_TRIAGE_AGENT.md"
CHANNEL_DOC="docs/FEEDBACK.md"
SH="scripts/feedback-triage.sh"
fail=0
note() { printf '%s\n' "$*"; }

note "== 1. Синтаксис bash (bash -n) =="
if bash -n "$SH"; then note "OK: $SH"; else note "FAIL: синтаксис $SH"; fail=1; fi

note "== 2. shellcheck (если установлен) =="
if command -v shellcheck >/dev/null 2>&1; then
  if shellcheck -x "$SH"; then note "OK: shellcheck"; else note "FAIL: shellcheck"; fail=1; fi
else
  note "SKIP: shellcheck не найден (apt-get install shellcheck / brew install shellcheck)"
fi

note "== 3. Dry-run функций с моком curl (без сети) =="
dry=$(mktemp); trap 'rm -f "$dry" /tmp/_ft_body.md' EXIT
{
  sed -n '/^set -euo pipefail/,$p' "$SH"
  # стаб сетевого слоя: перекрываем _api после определения (резолв функций — на этапе вызова),
  # чтобы прогнать реальную сборку payload (mktemp/umask/python/strip-лейблов) без сети.
  echo '_api() { printf "%s" "{\"html_url\":\"https://example/mock\"}"; }'
  echo 'GH_WRITE_TOKEN=mock'
  echo 'echo "## body" > /tmp/_ft_body.md'
  echo 'create_issue "o/r" "T" /tmp/_ft_body.md "bug, enhancement" >/dev/null'
  echo 'comment_issue "o/r" 1 "c"'
  echo 'close_transferred "o/r" 1'
  echo 'echo DRYRUN_OK'
} > "$dry"
if out=$(bash "$dry" 2>&1) && printf '%s' "$out" | grep -q DRYRUN_OK; then
  note "OK: dry-run функций"
else
  note "FAIL: dry-run"; printf '%s\n' "$out"; fail=1
fi

note "== 4. Блок лимитов GitHub API присутствует в доке =="
if grep -q "REST-core" "$DOC" && grep -q "GraphQL" "$DOC"; then
  note "OK: правило лимитов описано (§7)"
else
  note "FAIL: нет блока лимитов (REST-core/GraphQL) в $DOC"; fail=1
fi

note "== 5. Приватность: в доках есть privacy-guard про публичный репо =="
if grep -qiE "публичн" "$DOC" && grep -qiE "приватн" "$CHANNEL_DOC"; then
  note "OK: privacy-guard присутствует"
else
  note "FAIL: нет оговорки о приватности"; fail=1
fi

note "== 6. Канал сбора описан (FEEDBACK.md) =="
if grep -q "user-feedback" "$CHANNEL_DOC" && grep -q "agent-feedback" "$CHANNEL_DOC"; then
  note "OK: оба канала описаны"
else
  note "FAIL: в $CHANNEL_DOC не описаны каналы user-feedback/agent-feedback"; fail=1
fi

if [ "$fail" -eq 0 ]; then note "== ИТОГ: OK =="; else note "== ИТОГ: ЕСТЬ ОШИБКИ =="; fi
exit "$fail"
