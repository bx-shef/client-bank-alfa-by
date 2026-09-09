#!/usr/bin/env bash
# Why did connecting a bank fail — the bank's own answer, from the backend log (#488).
#
# WHY THIS EXISTS. On 2026-09-09 an admin pasted an Alfa API key, got «банк не принял ключ API»,
# and there was nothing to read: the handler logged only the exception class name. Four causes look
# identical from the browser — a bad key, the wrong client_id, the wrong host (sandbox instead of
# production) and a network/TLS failure — and each is fixed somewhere else. The handler now logs the
# bank's status and error code (with the key and client_secret cut out); this script surfaces those
# lines without asking anyone to follow `docker logs`.
#
# ⚠ READ-ONLY. It touches neither the portal nor the bank, and it never prints a secret: the log
# lines it shows are already redacted at the source (`redactValues` + `redactCredentials`).
#
#   bash prod-connect-log.sh [SINCE]     # default: 6h
set -u

cd /home/bitrix/bank-import 2>/dev/null || true
SINCE="${1:-6h}"
COMPOSE=docker-compose.prod.yml

echo "== Подключение банка: что ответил банк (за $SINCE) =="
echo

# WHICH STAND ARE WE TALKING TO. The top suspect when a freshly issued API key is refused is a
# mismatched environment: a key minted in the production cabinet cannot work against the sandbox
# host, and the bank's answer for that ("invalid_client") reads exactly like a wrong client_id.
# Checking it used to mean opening `.env` by hand next to the client secret, so nobody did.
#
# ⚠ ONLY non-secret values. `CLIENT_ID` travels in every request to the bank and is printed on the
# settings screen anyway; the token URL and API base are addresses. `CLIENT_SECRET` is never read.
if [ -f .env ]; then
  echo "── чем настроена Альфа (секретов здесь нет) ────────────────"
  url=$(grep -E '^ALFA_OAUTH_TOKEN_URL=' .env | cut -d= -f2-)
  api=$(grep -E '^ALFA_OAUTH_API_BASE=' .env | cut -d= -f2-)
  cid=$(grep -E '^ALFA_OAUTH_CLIENT_ID=' .env | cut -d= -f2-)
  echo "  token_url : ${url:-НЕ ЗАДАН}"
  echo "  api_base  : ${api:-не задан (берётся из token_url)}"
  echo "  client_id : ${cid:-НЕ ЗАДАН}"
  case "${url:-}" in
    *developerhub.alfabank.by*)
      echo "  ⚠ ЭТО ПЕСОЧНИЦА. Ключ из боевого кабинета здесь не примут никогда."
      echo "    В песочнице вместо ключа API подставляется буквальное значение «API»."
      ;;
    *ibapi2.alfabank.by*) echo "  ✓ боевой хост" ;;
    '') echo "  ⚠ без token_url подключение по ключу не заработает вовсе" ;;
    *) echo "  ⚠ хост незнакомый — сверьте с docs/ALFA_API.md" ;;
  esac
  # ⚠ Секрет НЕ печатаем, но его ОТСУТСТВИЕ назвать обязаны: без него роут отвечает 503, а не
  # «банк не принял ключ», — то есть симптом другой, и путать их нельзя.
  grep -qE '^ALFA_OAUTH_CLIENT_SECRET=.+' .env \
    && echo "  client_secret : задан (значение не печатаем)" \
    || echo "  ⚠ client_secret НЕ ЗАДАН — обмен невозможен, роут ответит 503"
  echo
fi

# Both roles can serve the route, so read the backend service. `--since` is docker's own filter —
# grepping a full log on a mobile terminal is what this script exists to avoid.
log=$(docker compose -f "$COMPOSE" logs --since "$SINCE" --no-log-prefix backend 2>/dev/null)

if [ -z "${log:-}" ]; then
  echo "лог пуст за этот срок — увеличьте окно: make bank-connect-log SINCE=24h"
  exit 0
fi

lines=$(printf '%s\n' "$log" | grep -F '[bank-connect]')
if [ -z "${lines:-}" ]; then
  echo "за $SINCE попыток подключения не было."
  echo "⚠ Если вы только что нажимали «Подключить», а строк нет — запрос не дошёл до backend."
  echo "  Смотрите nginx: `make doctor` покажет контейнеры и HTTPS."
  exit 0
fi

printf '%s\n' "$lines" | tail -n 60
echo
echo "── как читать ──────────────────────────────────────────────"
echo "invalid_client   — банк не узнал наш client_id (или не тот стенд: песочница против боевого)"
echo "invalid_grant    — банк не принял САМ КЛЮЧ (отозван, заблокирован, выпущен под другой client_id)"
echo "invalid_scope    — банк не даёт запрошенный scope этому приложению"
echo "401/403          — приложение не авторизовано на этом хосте"
echo "ENOTFOUND/ECONN  — до банка не достучались (адрес, сеть, шлюз)"
echo "CERT/SELF_SIGNED — не доверяем сертификату банка (NODE_EXTRA_CA_CERTS, см. docs/ALFA_API.md)"
echo
echo "⚠ Ключ и client_secret из этих строк вырезаны на стороне приложения."
