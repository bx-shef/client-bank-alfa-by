#!/usr/bin/env bash
# feedback-triage.sh — helper-функции для триажа обратной связи через GitHub REST API.
#
# Назначение: создание/комментирование/закрытие issue, когда путь MCP недоступен
# (см. docs/FEEDBACK_TRIAGE_AGENT.md §8). Это FALLBACK; основной путь — MCP/GraphQL.
#
# ТОКЕН: требуется GH_WRITE_TOKEN — fine-grained PAT, ограниченный ТОЛЬКО целевыми
#   репозиториями и правом Issues: Read and write (без Contents/кода).
#   Read-only ingest-токен для записи НЕ годится (→ 'Resource not accessible').
#
# ЗАВИСИМОСТИ: bash (массивы), curl (>= 7.55 — для `-H @file`), python3 (JSON-энкодинг).
#
# БЕЗОПАСНОСТЬ:
#   - Токен НЕ передаётся в argv curl (иначе виден в `ps`/`/proc/<pid>/cmdline`):
#     заголовок Authorization пишется во временный файл с umask 077 и подаётся
#     как `-H @file`. Не включайте `set -x`; держите токен вне shell-history.
#   - REST не поддерживает state_reason 'duplicate' (только completed/not_planned) —
#     для дубля используйте MCP с duplicate_of, либо not_planned + комментарий.
#   - ПРИВАТНОСТЬ: не копируйте сырой контекст отзыва (member_id, имя файла выписки,
#     № счёта/сделки, суммы, УНП, названия компаний) и не переносите приложенный файл
#     выписки в issue ПУБЛИЧНОГО репо. Только обезличенная суть + ссылка на приватный
#     отзыв. Проверьте приватность целевого репо (см. §5, §8).
#   - Скрипт предназначен для `source`; после работы рекомендуется `unset GH_WRITE_TOKEN`.
set -euo pipefail

API="https://api.github.com"

# Целевые репозитории — параметризованы (переопределяемы через env).
# FEEDBACK_REPO — приватный репо-приёмник отзывов; конкретное имя ещё не выбрано,
# поэтому дефолт — ПЛЕЙСХОЛДЕР. Задайте через env GITHUB_FEEDBACK_REPO / FEEDBACK_REPO.
PROJECT_REPO="${PROJECT_REPO:-bx-shef/client-bank-alfa-by}"                        # репо кода/задач
FEEDBACK_REPO="${FEEDBACK_REPO:-${GITHUB_FEEDBACK_REPO:-bx-shef/REPLACE-ME-feedback-private}}" # приватный репо отзывов

# _require <cmd> — fail-closed проверка наличия обязательной утилиты.
_require() {
  command -v "$1" >/dev/null 2>&1 || { echo "feedback-triage.sh: требуется '$1'" >&2; return 1; }
}

# _auth_file — печатает путь к временному файлу с заголовком Authorization (umask 077).
# Токен НЕ уходит в argv curl. Вызывающий обязан удалить файл после использования.
_auth_file() {
  : "${GH_WRITE_TOKEN:?GH_WRITE_TOKEN не задан (fine-grained PAT, Issues:write)}"
  local hdr; hdr=$(mktemp)
  ( umask 077; printf 'Authorization: Bearer %s\n' "$GH_WRITE_TOKEN" > "$hdr" )
  printf '%s' "$hdr"
}

# Внутренний вызов: печатает тело ответа, возвращает ненулевой код на HTTP >= 300.
# Все временные файлы удаляются явно (не через `trap RETURN` — он глобален в bash
# и вложенные вызовы затирали бы очистку внешней функции, оставляя файлы в /tmp).
_api() {
  local method="$1" path="$2" data="${3:-}"
  _require curl || return 1
  local out hdr code rc=0
  out=$(mktemp); hdr=$(_auth_file)
  local -a args=(-sS -o "$out" -w '%{http_code}' -X "$method"
                 -H "@$hdr" -H "Accept: application/vnd.github+json")
  [ -n "$data" ] && args+=(--data-binary "$data")
  code=$(curl "${args[@]}" "$API$path") || rc=$?
  rm -f "$hdr"
  cat "$out"
  rm -f "$out"
  if [ "$rc" -ne 0 ] || [ "${code:-0}" -ge 300 ]; then
    echo "HTTP ${code:-error} при $method $path" >&2
    return 1
  fi
}

# create_issue <owner/repo> <title> <body-file> <label[,label...]>
create_issue() {
  _require python3 || return 1
  local repo="$1" title="$2" bodyfile="$3" labels="${4:-}"
  local payload; payload=$(mktemp)
  ( umask 077
    python3 - "$title" "$bodyfile" "$labels" > "$payload" <<'PY'
import sys, json
title, bodyfile, labels = sys.argv[1], sys.argv[2], sys.argv[3]
labs = [x.strip() for x in labels.split(",") if x.strip()]
body = open(bodyfile, encoding="utf-8").read()
print(json.dumps({"title": title, "body": body, "labels": labs}))
PY
  )
  _api POST "/repos/$repo/issues" "@$payload" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("html_url") or d)'
  local rc=$?
  rm -f "$payload"
  return "$rc"
}

# comment_issue <owner/repo> <number> <text>
comment_issue() {
  _require python3 || return 1
  local repo="$1" num="$2" text="$3"
  local payload; payload=$(python3 -c 'import sys,json;print(json.dumps({"body":sys.argv[1]}))' "$text")
  _api POST "/repos/$repo/issues/$num/comments" "$payload" >/dev/null
}

# close_transferred <owner/repo> <number>   (REST: not_planned; duplicate недоступен)
close_transferred() {
  local repo="$1" num="$2"
  _api PATCH "/repos/$repo/issues/$num" '{"state":"closed","state_reason":"not_planned"}' >/dev/null
}

# Пример (запускать только с реальным GH_WRITE_TOKEN):
#   cat > /tmp/body.md <<'EOF'
#   ## Проблема ...
#   ## Источник (обратная связь, приватный репо)
#   - ${FEEDBACK_REPO}#43
#   EOF
#   create_issue      "$PROJECT_REPO"  "Заголовок по сути корня" /tmp/body.md "bug"
#   comment_issue     "$FEEDBACK_REPO" 43 "Перенесено: $PROJECT_REPO#NNN. Закрываю."
#   close_transferred "$FEEDBACK_REPO" 43
#   unset GH_WRITE_TOKEN   # убрать токен из окружения текущей shell-сессии
