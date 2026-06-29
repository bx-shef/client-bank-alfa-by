#!/bin/bash
# Local check pipeline for Linux/macOS: lint → typecheck → test, with a single
# ИТОГ status. Same checks as CI (.github/workflows/ci.yml), minus the build.
# Goal: run one command and get the result — not to type each step by hand.
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

echo ""
if [ "$fail" -eq 0 ]; then
  echo "ИТОГ: всё чисто"
else
  echo "ИТОГ: найдено проблем — $fail"
fi
exit "$fail"
