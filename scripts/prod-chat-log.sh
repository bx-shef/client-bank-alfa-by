#!/usr/bin/env bash
# Why a chat message arrived without its pictures — the portal's own answer, from the backend log
# (#19).
#
# WHY THIS EXISTS. The step-by-step pictures attached to the Alfa API-key invite did not show up in
# the chat, twice, and there was nothing to read: an attachment the portal refuses is dropped and the
# text is re-sent WITHOUT it, deliberately (the instruction must arrive even if the images cannot).
# That safety net swallowed the only evidence — no error on screen, no line in the log — so each
# round of diagnosis was a guess. The refusal is now logged; this script surfaces those lines.
#
# ⚠ TWO MARKERS, and they answer DIFFERENT questions, which is why one script reads both:
#   [chat]         — the portal (or the bot) refused the attachment we sent
#   [bank-connect] — the attachment was never built (the app's own address is unusable as an
#                    image link), i.e. nothing was even offered to the portal
# From the outside both look identical («картинок нет»); they are fixed in different places.
#
# ⚠ READ-ONLY. Touches neither the portal nor the bank, and prints no secrets: these log lines carry
# an error code and a description, never a token (`describeUpstreamError` redacts credentials).
#
#   bash prod-chat-log.sh [SINCE]     # default: 6h
set -u

cd /home/bitrix/bank-import 2>/dev/null || true
SINCE="${1:-6h}"
COMPOSE=docker-compose.prod.yml

echo "== Сообщения в чат: вложения и подпись (за $SINCE) =="
echo

# ⚠ The BACKEND service, not `app`. `make logs` tails nginx, where none of this appears — that
# mistake is exactly what sent someone looking in the wrong place once already.
log=$(docker compose -f "$COMPOSE" logs --since "$SINCE" --no-log-prefix backend 2>/dev/null)

if [ -z "${log:-}" ]; then
  echo "лог пуст за этот срок — увеличьте окно: SINCE=24h make chat-log"
  exit 0
fi

attach=$(printf '%s\n' "$log" | grep -F '[chat]')
build=$(printf '%s\n' "$log" | grep -F '[bank-connect]' | grep -F 'картинки шагов не приложены')

if [ -z "${attach:-}" ] && [ -z "${build:-}" ]; then
  echo "за $SINCE ни одной жалобы на вложение и ни одного отказа бота."
  echo
  echo "⚠ ЭТО НЕ ЗНАЧИТ «картинки дошли». Это значит одно из двух:"
  echo "  • сообщений с картинками за этот срок не отправляли (инструкция по ключу Альфы —"
  echo "    единственное такое сообщение; у Приора картинок нет по замыслу);"
  echo "  • либо портал вложение ПРИНЯЛ — тогда вопрос уже не в отправке, а в отрисовке."
  echo
  echo "Отправляли только что? Увеличьте окно: SINCE=1h make chat-log"
  exit 0
fi

if [ -n "${build:-}" ]; then
  echo "── вложение вообще не собралось ────────────────────────────"
  printf '%s\n' "$build" | tail -n 10
  echo
  echo "Причина ровно одна: адрес приложения непригоден как ссылка на картинку."
  echo "Чинится на СБОРКЕ (NUXT_PUBLIC_SITE_URL), а не в портале и не в банке."
  echo
fi

if [ -n "${attach:-}" ]; then
  echo "── что сказал портал ───────────────────────────────────────"
  printf '%s\n' "$attach" | tail -n 40
  echo
  echo "── как читать ──────────────────────────────────────────────"
  echo "ATTACH_ERROR     — портал счёл форму вложения негодной"
  echo "ATTACH_OVERSIZE  — вложение больше 60 000 символов (у нас столько не бывает)"
  echo "ACCESS_DENIED    — REST-бот недоступен на тарифе портала (сообщение уйдёт от сотрудника)"
  echo "BOT_LIMIT_...    — на портале исчерпан лимит чат-ботов"
  echo "«бот не принял»  — завернул БОТ, дальше пробовали от имени владельца токена"
  echo "«портал не принял вложение» — завернули ОБА маршрута, текст ушёл без картинок"
  echo
fi

echo "⚠ Сообщение задним числом не меняется: чтобы проверить починку, отправьте приглашение ЗАНОВО."
