#!/usr/bin/env bash
# `make alert-test` — send ONE test message through the operator alert channel (Telegram, #426)
# and say plainly whether it arrived.
#
# WHY THIS EXISTS. The alert channel is silent in three opposite situations — «all is well»,
# «alerting is switched off» and «switched on but not delivered» (revoked bot, wrong chat id). The
# app never sends a trial alert (its rules read the real queues), so after filling the two
# variables in .env there was nothing to check them with except a raw `curl` with the token typed
# into a shell — and on the server only `make` targets are allowed.
#
# ⚠ SENT FROM INSIDE THE BACKEND CONTAINER, with the container's own environment — not from the
# host with values read out of .env. That is the whole point: it proves the variables actually
# reached the process that sends alerts (a typo in the name, a half-filled pair or a stack not
# restarted after editing .env all look fine in .env) and that the container can reach Telegram.
# Only `backend` carries the pair (docker-compose.prod.yml: the health check runs on the cron
# instance), so only `backend` is asked.
#
# ⚠ THE TOKEN NEVER LEAVES THE CONTAINER: it is read by node from process.env and goes into the
# request URL there. Nothing is printed but the HTTP status and Telegram's fixed error text (with
# the token stripped from it anyway); a network error prints its code, never its message. Measured:
# Node's fetch does NOT put the URL into connection errors («fetch failed», ECONNREFUSED), so this is
# a cheap precaution rather than a proven leak — the same rule server/utils/telegramAlert.ts follows,
# and no test can go red on it.
#
#   bash prod-alert-test.sh "<docker compose command>"
set -u

DC="${1:-docker compose -f docker-compose.prod.yml}"
# Test-only override of the Telegram base address (a fake server in tests/prodAlertTest.test.ts).
# ⚠ Loopback ONLY: the token rides in the request URL, so an override pointing anywhere else would
# hand the bot token to that host.
API="https://api.telegram.org"
if [ -n "${ALERT_TEST_API:-}" ]; then
  [[ "$ALERT_TEST_API" =~ ^http://127\.0\.0\.1:[0-9]{1,5}$ ]] \
    || { echo "✗ ALERT_TEST_API — только http://127.0.0.1:<порт> (это переменная тестов); ничего не отправлено"; exit 2; }
  API="$ALERT_TEST_API"
fi

cd /home/bitrix/bank-import 2>/dev/null || true

JS='
const [, api] = process.argv;
const token = (process.env.TELEGRAM_ALERT_BOT_TOKEN || "").trim();
const chat = (process.env.TELEGRAM_ALERT_CHAT_ID || "").trim();
// Line breaks are flattened so a Telegram description cannot inject an ALERT_* line. A second
// layer makes it untestable: DESC is printed after STATE/STATUS, and the shell reads the FIRST match.
const say = (k, v) => console.log("ALERT_" + k + "=" + String(v).replace(/[\r\n]/g, " "));
if (!token && !chat) { say("STATE", "off"); process.exit(0); }
if (!token || !chat) { say("STATE", "half"); say("MISSING", token ? "chat" : "token"); process.exit(0); }
const clean = s => String(s || "").split(token).join("<token>").replace(/[^\x20-\x7eЀ-ӿ]/g, "").slice(0, 160);
(async () => {
  let res;
  try {
    res = await fetch(api + "/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: "Проверка канала оповещений (make alert-test): если вы это читаете, оповещения о сбоях сюда дойдут.", disable_web_page_preview: true }),
      redirect: "error",
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    say("STATE", "neterr");
    say("CODE", clean((e && e.cause && e.cause.code) || (e && e.name) || "unknown"));
    return;
  }
  const j = await res.json().catch(() => null);
  say("STATE", "http");
  say("STATUS", res.status);
  say("DESC", clean(j && j.description));
})().finally(() => process.exit(0));
'

echo "== Оповещения оператору: пробное сообщение в Telegram =="
# ⚠ A host-side timeout as well: the 15 s inside node do not cover a hung `docker compose exec`
# (daemon stuck, container restarting). Its stderr is kept to explain an empty answer — it cannot
# carry the token: the token is in no argument and node prints nothing about the request.
ERR="$(mktemp /tmp/alert-test-err.XXXXXX)"
trap 'rm -f "$ERR"' EXIT
# ⚠ stdin is /dev/null, and this is load-bearing (live run 2026-09-29): without it `docker compose
# exec` inherits the TERMINAL as stdin. `timeout` runs it in a background process group, a read from
# the terminal stops it (SIGTTIN), and the command hung after the message had already been sent —
# Ctrl+C did not reach it. `-k 5` kills it outright if it outlives the timeout anyway.
OUT="$(timeout -k 5 45 $DC exec -T backend node -e "$JS" "$API" </dev/null 2>"$ERR")"
RC=$?
field() { printf '%s\n' "$OUT" | sed -n "s/^ALERT_$1=//p" | head -1; }
STATE="$(field STATE)"

case "$STATE" in
  off)
    echo "  ✗ канал выключен: backend не видит ни TELEGRAM_ALERT_BOT_TOKEN, ни TELEGRAM_ALERT_CHAT_ID."
    echo "    Впишите обе в .env и перезапустите стек: make prod-up"
    exit 1 ;;
  half)
    case "$(field MISSING)" in
      chat) miss=TELEGRAM_ALERT_CHAT_ID ;;
      *) miss=TELEGRAM_ALERT_BOT_TOKEN ;;
    esac
    echo "  ✗ задана только одна переменная из двух — не хватает $miss. С половиной пары канал выключен."
    echo "    Впишите её в .env и перезапустите стек: make prod-up"
    exit 1 ;;
  neterr)
    echo "  ✗ Telegram недоступен из контейнера backend (ошибка: $(field CODE))."
    echo "    Проверьте выход сервера в интернет до api.telegram.org."
    exit 1 ;;
  http)
    status="$(field STATUS)"; desc="$(field DESC)"
    case "$status" in
      200)
        echo "  ✓ сообщение отправлено — проверьте чат: там должно быть «Проверка канала оповещений»."
        exit 0 ;;
      401) echo "  ✗ Telegram не принял токен бота (HTTP 401) — проверьте TELEGRAM_ALERT_BOT_TOKEN." ;;
      403) echo "  ✗ бот не может писать в этот чат (HTTP 403) — добавьте бота в чат или разблокируйте его." ;;
      400) echo "  ✗ Telegram отклонил запрос (HTTP 400) — чаще всего неверный TELEGRAM_ALERT_CHAT_ID." ;;
      429) echo "  ✗ Telegram ограничил частоту (HTTP 429) — повторите через минуту." ;;
      *) echo "  ✗ Telegram ответил HTTP $status." ;;
    esac
    [ -n "$desc" ] && echo "    ответ Telegram: $desc"
    echo "    После правки .env — make prod-up и снова make alert-test."
    exit 1 ;;
  *)
    if [ "$RC" -eq 124 ] || [ "$RC" -eq 137 ]; then
      echo "  ✗ контейнер backend не ответил за 45 секунд — проверка прервана."
    fi
    echo "  ✗ не удалось выполнить проверку в контейнере backend — он запущен? (make ps)"
    if [ -s "$ERR" ]; then echo "    ответ docker:"; tail -n 5 "$ERR" | sed 's/^/      /'; fi
    exit 1 ;;
esac
