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
# ⚠ Креды НЕ УГАДЫВАЕМ. Первая редакция подставляла `${POSTGRES_USER:-postgres}` — а compose задаёт
# `app`/`app` жёстко, и переменных этих в шелле оператора нет вовсе. Скрипт молча печатал «не смог
# прочитать базу» при полностью здоровом Postgres. Ту же ошибку нёс `prod-reap-status.sh`, то есть
# ВТОРАЯ диагностика была мертва с рождения и никто этого не заметил.
# Правильный способ — спросить у самого контейнера: compose кладёт туда `POSTGRES_USER`/`POSTGRES_DB`,
# и угадывать нечего. SQL едет через stdin, а не через `-c`: внутри него полно одинарных кавычек.
err=/tmp/bank-history-err.$$
trap 'rm -f /tmp/bank-history.$$ "$err"' EXIT
if ! docker compose -f "$COMPOSE" exec -T db \
      sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F"|"' \
      > /tmp/bank-history.$$ 2>"$err" <<'SQL'
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
         THEN to_char(to_timestamp(consent_expires_at / 1000.0), 'YYYY-MM-DD') ELSE '—' END,
    -- ⚠ СОСТОЯНИЕ, и оно решает, произносить ли причину вообще. Зеркало `connectionHealth`
    -- (`app/utils/bankTokenLifetime.ts`); числа сверяет `tests/prodBankHistory.test.ts`.
    -- Порядок веток тот же и он несущий: согласие банка перекрывает всё (это его дата, а не наша
    -- оценка), затем «нечем продлевать», затем сроки. «Истекло» произносим ТОЛЬКО про ИЗМЕРЕННЫЙ
    -- срок: у Приора он догадка, и хоронить по ней значит слать человека в интернет-банк за тем,
    -- что не ломалось.
    CASE
      WHEN consent_expires_at > 0
       AND consent_expires_at <= (extract(epoch FROM now()) * 1000)      THEN 'expired'
      WHEN refresh_token_enc = ''                                        THEN 'no-refresh'
      WHEN provider NOT IN ('alfa-by', 'prior-by')                       THEN 'unknown'
      WHEN extract(epoch FROM (now() - updated_at))
             >= CASE provider WHEN 'alfa-by' THEN 36000 ELSE 43200 END
        THEN CASE provider WHEN 'alfa-by' THEN 'expired' ELSE 'due' END
      WHEN extract(epoch FROM (now() - updated_at))
             >= CASE provider WHEN 'alfa-by' THEN 36000 ELSE 43200 END * 0.5 THEN 'due'
      ELSE 'ok'
    END
  FROM bank_tokens
  ORDER BY updated_at;
SQL
then
  # ⚠ ПРИЧИНУ ПОКАЗЫВАЕМ. Прежняя редакция глушила stderr в /dev/null и печатала только «проверьте
  # make ps» — то есть диагностика прятала собственную ошибку и отправляла оператора смотреть на
  # контейнеры, которые здоровы. Ровно так этот скрипт и провалился на первом же живом запуске.
  echo "не смог прочитать базу. Что ответил Postgres:"
  sed 's/^/  /' "$err"
  exit 0
fi

if [ ! -s /tmp/bank-history.$$ ]; then
  # ⚠ Пустая таблица — САМА ПО СЕБЕ находка, а не «нечего показать»: именно так выглядел простой
  # 2026-08-26, когда подключений не стало и никто этого не заметил четыре дня.
  echo "⚠ В базе НЕТ НИ ОДНОГО банковского подключения."
  echo "  Если вы их подключали — они исчезли, и это авария, а не пустой экран."
  echo "  Кто мог их убрать — 'make poll-check' (секция «КТО ОТКЛЮЧАЛ БАНК»), но лог уносит перевыкат."
  exit 0
fi

n=0
while IFS='|' read -r portal prov acct ok_at ok_h try_at try_h cause paused consent health; do
  n=$((n + 1))
  echo "── портал ${portal}  ${prov}  ${acct}${paused:+  [${paused}]}"
  echo "   последняя УДАЧНАЯ пара : ${ok_at}  (${ok_h} ч назад)"
  if [ "${try_h}" = "-1" ]; then
    echo "   последняя ПОПЫТКА      : не было НИ ОДНОЙ"
  else
    echo "   последняя ПОПЫТКА      : ${try_at}  (${try_h} ч назад)"
  fi
  [ "$consent" != "—" ] && echo "   согласие банка до      : ${consent}"
  # ⚠ ПРИЧИНУ произносим ТОЛЬКО у истёкшего подключения, и это не косметика. Первая редакция
  # печатала её у КАЖДОЙ строки — и на живом прогоне 2026-09-06 посоветовала переподключить
  # Приора, у которого последняя удачная пара была два часа назад, а согласие банка действует до
  # конца ноября. Уверенный неверный совет, стоящий человеку похода в интернет-банк, — ровно тот
  # класс ошибки, ради которого весь этот модуль и написан.
  # В коде так и сделано: `connectionHint` спрашивает `expiredCause` под `if (h === 'expired')`.
  case "$health" in
    expired)
      if [ "$cause" = "bank-refused" ]; then
        echo "   ⇒ ИСТЕКЛО. Продление ХОДИЛО в банк после последнего успеха, и банк отказал."
        echo "     Чинится переподключением: вход владельца счёта в интернет-банк."
      else
        echo "   ⇒ ⚠ ИСТЕКЛО, но с последнего успеха продление НЕ ХОДИЛО в банк ни разу."
        echo "     Значит дело НЕ в банке. Переподключение купит один срок жизни токена"
        echo "     и повторится ровно так же — причину искать у нас (#488)."
      fi
      ;;
    no-refresh)
      echo "   ⇒ Продлевать НЕЧЕМ: банк не выдал refresh-токен."
      echo "     Живёт, пока жив access-токен; лечится только переподключением."
      ;;
    due)
      echo "   ⇒ Пора обновить — приложение попробует само. Действий не требуется."
      ;;
    ok)
      echo "   ⇒ Живо, продление в срок. Действий не требуется."
      ;;
    *)
      echo "   ⇒ Состояние неизвестно (срок жизни токена для этого банка не задан)."
      ;;
  esac
  echo
done < /tmp/bank-history.$$

echo "подключений в базе: ${n}"
echo
echo "⚠ Эти два времени — единственное, что переживает 'make prod-redeploy'."
echo "  Лог после перевыката начинается с нуля, база — нет."
