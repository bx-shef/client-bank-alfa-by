#!/usr/bin/env bash
# История банковских подключений ИЗ БАЗЫ — то, что переживает `make prod-redeploy` (#488/#644).
#
# ⚠ ЗАЧЕМ ОТДЕЛЬНО ОТ `poll-check`. Тот читает ЛОГ, а лог живёт внутри контейнера и уходит вместе
# с ним на любом перевыкате. Ровно так вопрос «продлевал ли крон токен» остался без ответа
# 2026-08-26 и повторно 2026-09-06: к моменту, когда стало ясно, что подключение умерло, история
# была уже стёрта, и `poll-check` честно печатал «судить нельзя, повторите через час-другой».
#
# База помнит две вещи, которых нет больше нигде:
#   • `updated_at`      — когда мы последний раз ДЕРЖАЛИ свежую пару (штампуется только на УСПЕХЕ);
#   • `last_attempt_at` — когда продление последний раз ПОШЛО В БАНК (штампуется ДО запроса, #488).
#
# Их порядок и отвечает на вопрос, который иначе не решить (правило — `expiredCause` в
# `app/utils/bankTokenLifetime.ts`, здесь оно ПОВТОРЕНО в SQL и стережётся тестом):
#   попытка ПОЗЖЕ успеха  ⇒ продление ходило, банк отказал   ⇒ лечится переподключением;
#   попытка РАНЬШЕ/нет    ⇒ продление НЕ ходило вовсе        ⇒ это наша поломка, переподключение
#                                                              купит один срок жизни и повторится.
#
# ⚠ Только чтение. Ни одной команды записи здесь нет и быть не должно.
set -euo pipefail

COMPOSE="${1:-docker-compose.prod.yml}"
cd /home/bitrix/bank-import 2>/dev/null || true

echo "== История банковских подключений (из БАЗЫ, переживает перевыкат) =="
echo

# ⚠ Номер счёта маскируется серединой: строку читают с телефона и пересылают в чат, а репозиторий
# публичный. Хвоста и головы хватает, чтобы узнать свой счёт, и не хватает, чтобы его использовать.
docker compose -f "$COMPOSE" exec -T db psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -At -F'|' -c "
  SELECT
    left(md5(member_id), 6),
    provider,
    CASE WHEN account_key LIKE '~pending:%' THEN '(счёт не выбран)'
         WHEN length(account_key) > 12 THEN left(account_key, 6) || '…' || right(account_key, 4)
         ELSE account_key END,
    to_char(updated_at, 'YYYY-MM-DD HH24:MI'),
    round(extract(epoch FROM (now() - updated_at)) / 3600)::int,
    CASE WHEN last_attempt_at > 0
         THEN to_char(to_timestamp(last_attempt_at / 1000.0), 'YYYY-MM-DD HH24:MI') ELSE '—' END,
    CASE WHEN last_attempt_at > 0
         THEN round((extract(epoch FROM now()) - last_attempt_at / 1000.0) / 3600)::int ELSE -1 END,
    CASE WHEN last_attempt_at > 0
          AND last_attempt_at > (extract(epoch FROM updated_at) * 1000)
         THEN 'bank-refused' ELSE 'never-tried' END,
    CASE WHEN poll_paused THEN 'на паузе' ELSE '' END,
    CASE WHEN consent_expires_at > 0
         THEN to_char(to_timestamp(consent_expires_at / 1000.0), 'YYYY-MM-DD') ELSE '—' END
  FROM bank_tokens
  ORDER BY updated_at;" 2>/dev/null > /tmp/bank-history.$$ || {
    echo "не смог прочитать базу — проверьте 'make ps'"; rm -f /tmp/bank-history.$$; exit 0; }

trap 'rm -f /tmp/bank-history.$$' EXIT

if [ ! -s /tmp/bank-history.$$ ]; then
  # ⚠ Пустая таблица — САМА ПО СЕБЕ находка, а не «нечего показать»: именно так выглядел простой
  # 2026-08-26, когда подключений не стало и никто этого не заметил четыре дня.
  echo "⚠ В базе НЕТ НИ ОДНОГО банковского подключения."
  echo "  Если вы их подключали — они исчезли, и это авария, а не пустой экран."
  echo "  Кто мог их убрать — 'make poll-check' (секция «КТО ОТКЛЮЧАЛ БАНК»), но лог уносит перевыкат."
  exit 0
fi

n=0
while IFS='|' read -r portal prov acct ok_at ok_h try_at try_h cause paused consent; do
  n=$((n + 1))
  echo "── портал ${portal}  ${prov}  ${acct}${paused:+  [${paused}]}"
  echo "   последняя УДАЧНАЯ пара : ${ok_at}  (${ok_h} ч назад)"
  if [ "${try_h}" = "-1" ]; then
    echo "   последняя ПОПЫТКА      : не было НИ ОДНОЙ"
  else
    echo "   последняя ПОПЫТКА      : ${try_at}  (${try_h} ч назад)"
  fi
  [ "$consent" != "—" ] && echo "   согласие банка до      : ${consent}"
  if [ "$cause" = "bank-refused" ]; then
    echo "   ⇒ продление ХОДИЛО в банк после последнего успеха, и банк отказал."
    echo "     Чинится переподключением: вход владельца счёта в интернет-банк."
  else
    echo "   ⇒ ⚠ с момента последнего успеха продление НЕ ХОДИЛО в банк ни разу."
    echo "     Значит дело НЕ в банке. Переподключение купит один срок жизни токена"
    echo "     и повторится ровно так же — причину искать у нас (#488)."
  fi
  echo
done < /tmp/bank-history.$$

echo "подключений в базе: ${n}"
echo
echo "⚠ Эти два времени — единственное, что переживает 'make prod-redeploy'."
echo "  Лог после перевыката начинается с нуля, база — нет."
