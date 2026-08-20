#!/bin/bash
# Local check pipeline for Linux/macOS: lint → typecheck → test → build, with a single
# ИТОГ status. The same checks CI runs (.github/workflows/ci.yml).
#
# ⚠ Сборка входит сюда с 2026-08-20, и не для симметрии. До этого скрипт заявлял «same checks as
# CI, minus the build» — и этот «minus» пропустил на ревью правку, которая ломала `nuxt generate`:
# плагин заводил `setInterval`, живой таймер не давал процессу завершиться, и сборка ВИСЛА уже
# после того, как напечатала «Generated public .output/public». То есть выглядела успешной и не
# заканчивалась. Локально всё было зелено, CI встал.
#
# ⚠ Сборка ловит целый класс, недостижимый для lint/typecheck/test: пререндер РЕАЛЬНО ЗАПУСКАЕТ
# серверные плагины. Таймеры, открытые соединения, чтение env — всё это проявляется только здесь.
#
# Быстрый прогон без сборки (когда правишь только тесты): SKIP_BUILD=1 bash scripts/check-app.sh
# Usage: bash scripts/check-app.sh
set -uo pipefail
cd "$(dirname "$0")/.."

fail=0
run() {
  echo ""
  echo "=== $1 ==="
  if eval "$2"; then
    echo "OK: $1"
  else
    echo "ОШИБКА: $1"
    fail=$((fail + 1))
  fi
}

run "lint" "pnpm lint"
run "typecheck" "pnpm typecheck"
run "test" "pnpm test"
# ⚠ ТАЙМАУТ обязателен, а не украшение: сломанная сборка тут именно ВИСНЕТ, а не падает, и без
# ограничения скрипт молча ждал бы вечно — ровно тот отказ, который он призван поймать.
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo ""
  echo "=== build === (пропущена: SKIP_BUILD=1)"
else
  run "build (nuxt generate)" "timeout 420 pnpm generate"
fi

echo ""
if [ "$fail" -eq 0 ]; then
  echo "ИТОГ: всё чисто"
else
  echo "ИТОГ: найдено проблем — $fail"
fi
exit "$fail"
