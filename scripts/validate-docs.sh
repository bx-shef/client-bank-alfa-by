#!/usr/bin/env bash
# validate-docs.sh — оффлайн-валидация доков триажа обратной связи и вынесенных скриптов.
# Не делает НИ ОДНОГО реального вызова GitHub API. Запуск: bash scripts/validate-docs.sh
# Намеренно без `-e`: проверки должны продолжаться и после первого FAIL (агрегируем в $fail).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DOC="docs/FEEDBACK_TRIAGE_AGENT.md"
CHANNEL_DOC="docs/FEEDBACK.md"
SH="scripts/feedback-triage.sh"
PS="scripts/validate-docs.ps1"
PLACEHOLDER="bx-shef/REPLACE-ME-feedback-private"
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
body=$(mktemp)
dry=$(mktemp); trap 'rm -f "$dry" "$body"' EXIT
{
  sed -n '/^set -euo pipefail/,$p' "$SH"
  # стаб сетевого слоя: перекрываем _api после определения (резолв функций — на этапе вызова),
  # чтобы прогнать реальную сборку payload (mktemp/umask/python/strip-лейблов) без сети.
  echo '_api() { printf "%s" "{\"html_url\":\"https://example/mock\"}"; }'
  echo 'GH_WRITE_TOKEN=mock'
  echo "echo '## body' > '$body'"
  echo "create_issue 'o/r' 'T' '$body' 'bug, enhancement' >/dev/null"
  echo "comment_issue 'o/r' 1 'c'"
  echo "close_transferred 'o/r' 1"
  echo 'echo DRYRUN_OK'
} > "$dry"
if out=$(bash "$dry" 2>&1) && printf '%s' "$out" | grep -q DRYRUN_OK; then
  note "OK: dry-run функций"
else
  note "FAIL: dry-run"; printf '%s\n' "$out"; fail=1
fi

note "== 4. Блок лимитов GitHub API присутствует в доке =="
if grep -q "REST-core" "$DOC" && grep -q "GraphQL" "$DOC" && grep -q "GITHUB_TOKEN_INGEST" "$DOC"; then
  note "OK: правило лимитов описано (§7), ingest-токен объявлен"
else
  note "FAIL: нет блока лимитов (REST-core/GraphQL/GITHUB_TOKEN_INGEST) в $DOC"; fail=1
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

note "== 7. Плейсхолдер приватного репо консистентен =="
miss=""
for f in "$DOC" "$SH"; do
  grep -q "$PLACEHOLDER" "$f" || miss="$miss $f"
done
if [ -z "$miss" ]; then
  note "OK: плейсхолдер '$PLACEHOLDER' совпадает в доке и скрипте"
else
  note "FAIL: плейсхолдер отсутствует/разошёлся в:$miss"; fail=1
fi

note "== 8. Внутренние markdown-ссылки не битые =="
broken=""
for src in "$DOC" "$CHANNEL_DOC"; do
  # вытащить относительные пути из ссылок вида [текст](docs/...) и (FEEDBACK...)
  while IFS= read -r target; do
    [ -z "$target" ] && continue
    # ссылки внутри docs/ указываются относительно каталога docs/
    if [ -f "$target" ] || [ -f "docs/$target" ]; then :; else broken="$broken $src→$target"; fi
  done < <(grep -oE '\]\(([A-Za-z0-9_./-]+\.md)\)' "$src" | sed -E 's/^\]\(//; s/\)$//')
done
if [ -z "$broken" ]; then
  note "OK: внутренние .md-ссылки существуют"
else
  note "FAIL: битые ссылки:$broken"; fail=1
fi

note "== 9. Паритет проверок .sh/.ps1 (одинаковое число шагов) =="
sh_steps=$(grep -cE '^\s*note "== [0-9]+\.' "$0")
ps_steps=$(grep -cE 'Write-Host "== [0-9]+\.' "$PS")
if [ "$sh_steps" -eq "$ps_steps" ]; then
  note "OK: $sh_steps шагов в .sh и .ps1"
else
  note "FAIL: паритет .sh($sh_steps)/.ps1($ps_steps) разошёлся"; fail=1
fi

if [ "$fail" -eq 0 ]; then note "== ИТОГ: OK =="; else note "== ИТОГ: ЕСТЬ ОШИБКИ =="; fi
exit "$fail"
