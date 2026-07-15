#!/usr/bin/env bash
# validate-docs.sh — оффлайн-валидация доков триажа обратной связи и вынесенных скриптов.
# Не делает НИ ОДНОГО реального вызова GitHub API (curl замокан). Запуск: bash scripts/validate-docs.sh
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
  if shellcheck -x "$SH" "$0"; then note "OK: shellcheck"; else note "FAIL: shellcheck"; fail=1; fi
else
  note "SKIP: shellcheck не найден (apt-get install shellcheck / brew install shellcheck)"
fi

note "== 3. Поведенческий прогон с моком curl (без сети): happy-path + guard'ы =="
# Мокается САМ curl (не _api): реальные _api/create_issue/comment/close прогоняются целиком
# (очистка mktemp, разбор http-кода, отсутствие протечки trap, privacy-guard) — это ловит
# класс багов «функция падает при прямом вызове», который мок _api пропустил бы.
harness=$(mktemp); cap=$(mktemp); body=$(mktemp)
trap 'rm -f "$harness" "$cap" "$body"' EXIT
SCRIPT_ABS="$PWD/$SH"
cat > "$harness" <<HARNESS
CAP="$cap"; BODY="$body"; MOCK_CODE=\${MOCK_CODE:-200}
curl() {
  local out="" databin="" i; local -a a=("\$@")
  for ((i=0;i<\${#a[@]};i++)); do
    case "\${a[i]}" in
      -o) out="\${a[i+1]}";;
      --data-binary) databin="\${a[i+1]}";;
    esac
  done
  cat >/dev/null 2>&1 || true                        # drain -K - config (token) from stdin
  [ -n "\$out" ] && printf '{"html_url":"https://example/mock","private":true}' > "\$out"
  [ -n "\$databin" ] && [ "\${databin:0:1}" = "@" ] && cp "\${databin:1}" "\$CAP" 2>/dev/null
  printf '%s' "\$MOCK_CODE"
}
export GH_WRITE_TOKEN=mocktoken
export PROJECT_REPO="bx-shef/client-bank-alfa-by"
export GITHUB_FEEDBACK_REPO="bx-shef/feedback-private"
source "$SCRIPT_ABS"
rc=0; chk(){ if eval "\$2"; then :; else echo "SUBFAIL: \$1"; rc=1; fi; }
false; echo "sourced-safe (shell alive)"            # source не должен включать set -e
echo "## body" > "\$BODY"
chk "create_issue"          'create_issue "\$PROJECT_REPO" T "\$BODY" "bug, enhancement" >/dev/null'
chk "comment_issue"         'comment_issue "\$FEEDBACK_REPO" 43 "перенос"'
chk "close_transferred"     'close_transferred "\$FEEDBACK_REPO" 43'
chk "labels .strip()"       'grep -q "\"labels\": \[\"bug\", \"enhancement\"\]" "\$CAP"'
chk "no-token → fail"       '! ( unset GH_WRITE_TOKEN; create_issue "\$PROJECT_REPO" T "\$BODY" bug >/dev/null 2>&1 )'
chk "HTTP 404 → fail"       '! ( MOCK_CODE=404; close_transferred "\$FEEDBACK_REPO" 43 >/dev/null 2>&1 )'
chk "public target refused" '! comment_issue "\$PROJECT_REPO" 1 ctx >/dev/null 2>&1'
chk "placeholder refused"   '! comment_issue "$PLACEHOLDER" 1 x >/dev/null 2>&1'
chk "bad repo → fail"       '! comment_issue "bad repo!" 1 x >/dev/null 2>&1'
chk "bad num → fail"        '! close_transferred "\$FEEDBACK_REPO" abc >/dev/null 2>&1'
chk "empty feedback → fail" '! ( unset FEEDBACK_REPO GITHUB_FEEDBACK_REPO; comment_issue "" 1 x >/dev/null 2>&1 )'
[ "\$rc" -eq 0 ] && echo BEHAVIOR_OK
HARNESS
if out=$(bash "$harness" 2>&1) && printf '%s' "$out" | grep -q BEHAVIOR_OK; then
  note "OK: поведенческий прогон (happy-path + 9 guard-кейсов)"
else
  note "FAIL: поведенческий прогон"; printf '%s\n' "$out"; fail=1
fi

note "== 4. Блок лимитов GitHub API присутствует в доке =="
if grep -q "REST-core" "$DOC" && grep -q "GraphQL" "$DOC" && grep -q "GITHUB_TOKEN_INGEST" "$DOC"; then
  note "OK: правило лимитов описано (§7), ingest-токен объявлен"
else
  note "FAIL: нет блока лимитов (REST-core/GraphQL/GITHUB_TOKEN_INGEST) в $DOC"; fail=1
fi

note "== 5. Privacy-guard: содержательная формулировка (не одно слово) =="
# Якорим на конкретный блок, а не на любое вхождение «публичн» (иначе «публичные
# комментарии» в §9 давали бы ложный OK).
if grep -q "Privacy-guard" "$DOC" && grep -qiE "не копируй|УНП" "$DOC" && grep -qiE "приватн" "$CHANNEL_DOC"; then
  note "OK: privacy-guard присутствует содержательно"
else
  note "FAIL: privacy-guard выродился в упоминание слова"; fail=1
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
  while IFS= read -r target; do
    [ -z "$target" ] && continue
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
