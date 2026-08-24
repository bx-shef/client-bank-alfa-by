#!/usr/bin/env bash
# Что уборщик мёртвых грантов (#574) видит и делает — read-only.
#
# ⚠ Ничего не стирает и стирать не умеет: у него нет ни одной команды удаления. Это осознанно —
# «сухой прогон» флагом означал бы, что один неверный булев превращает показ в удаление (тот же
# довод, что у `erasable`/`erase`).
set -euo pipefail

COMPOSE="${1:-docker-compose.prod.yml}"
cd /home/bitrix/bank-import 2>/dev/null || true

echo "== Уборщик мёртвых грантов (#574) =="
echo

armed="$(grep -E '^PORTAL_REAP_ENABLED=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
days="$(grep -E '^PORTAL_REAP_DAYS=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)"
case "${armed:-}" in
  1|true|yes|on) echo "Стирание:  ВКЛЮЧЕНО — порталы удаляются необратимо" ;;
  '')            echo "Стирание:  выключено (по умолчанию) — только наблюдение" ;;
  *)             echo "Стирание:  выключено (PORTAL_REAP_ENABLED=${armed})" ;;
esac
echo "Порог:     ${days:-30} дн. (пол 14, занизить нельзя)"
echo

echo "-- помеченные порталы (метка ставится при ответе банка 'грант мёртв') --"
docker compose -f "$COMPOSE" exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -At -c "
  SELECT
    count(*) FILTER (WHERE grant_revoked_at > 0)                                        AS marked,
    count(*)                                                                            AS total,
    coalesce(to_char(to_timestamp(min(NULLIF(grant_revoked_at,0))/1000),'YYYY-MM-DD'),'—') AS oldest
  FROM portal_tokens;" 2>/dev/null \
  | awk -F'|' '{printf "помечено:  %s из %s порталов\nсамая старая метка: %s\n", $1, $2, $3}' \
  || echo "не смог прочитать базу — смотреть 'make logs'"
echo

echo "-- последние строки уборщика в логе --"
docker compose -f "$COMPOSE" logs --since 48h backend 2>/dev/null \
  | grep -F '[retention]' | grep -Ei 'порог|уборщик|кандидат|стёрт' | tail -20 \
  || echo "строк нет: уборщик не отрабатывал за 48ч (он ходит раз в сутки и сидит под STATEMENT_SWEEP + Redis)"
