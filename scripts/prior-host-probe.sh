#!/usr/bin/env bash
# Проба хоста Приорбанка: отвечает ли он серверным вызовам нашими БОЕВЫМИ ключами (#522).
#
# Зачем. Банк написал, что `api.priorbank.by:9344` — промышленный адрес «только для подключения
# без белкриптографии». Наш прод сегодня ходит на `apibel.priorbank.by:9345` через крипто-шлюз, а
# `:9344` мы используем лишь как адрес, который открывает БРАУЗЕР владельца счёта. Вопрос, который
# нельзя решить чтением переписки: принимает ли `:9344` серверные вызовы нашим боевым `client_id`.
#
# ⚠ Что проба НЕ делает и почему. Она не трогает refresh-токены подключённых счетов. Обновление
# РОТИРУЕТ refresh, и проба, выбросившая новый, убила бы живое подключение — лечится только
# повторным входом владельца счёта в интернет-банк (см. #505/#509). Вместо этого действительность
# регистрации проверяется грантом `client_credentials`: он ничего не ротирует и ничего не создаёт.
#
# ⚠ Секреты в вывод не попадают: печатаются только коды ответов, публичные поля discovery и имена
# УЦ из TLS-цепочки. Приватный ключ кладётся во временный файл с правами 600 и удаляется по trap.
#
# Требуется: curl, openssl. Ни node, ни pnpm, ни git на сервере не нужны.
#
# Использование (из /home/bitrix/bank-import, где лежит .env):
#   bash prior-host-probe.sh                       # проба https://api.priorbank.by:9344
#   bash prior-host-probe.sh https://ДРУГОЙ:ПОРТ   # другой адрес
#   bash prior-host-probe.sh --with-consent        # + создать пробное согласие (ЗАПИСЬ в банк)

set -u

TARGET="https://api.priorbank.by:9344"
WITH_CONSENT=0
for a in "$@"; do
  case "$a" in
    --with-consent) WITH_CONSENT=1 ;;
    https://*) TARGET="${a%/}" ;;
    *) echo "не понял аргумент: $a"; exit 2 ;;
  esac
done

AUTH_PREFIX="/open-banking-authorize/v1.0"
DCR_PREFIX="/open-banking-dcr/v1.0"
OB_PREFIX="/open-banking/v1.0"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
# Печать тела ответа при ошибке. ⚠ HTML не дампим: страница-заглушка прокси или балансировщика
# занимает экран и не несёт ничего, кроме факта «это не наш API» — его и говорим одной строкой.
show_body() {
  if head -c 200 "$1" | grep -qi '<html\|<!doctype'; then
    echo "    (ответ — HTML-страница, а не JSON API: адрес отвечает, но это не эндпоинт банка)"
  else
    head -c 400 "$1" | tr -d '\r' | sed 's/^/    /'; echo
  fi
}
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
head_() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

# --- .env ---------------------------------------------------------------------------------------
# Тот же разбор, что у `env-value` в Makefile: снимает `export`, комментарий и кавычки.
envv() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=//p" ./.env 2>/dev/null \
    | head -1 \
    | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]][[:space:]]*#.*$//" -e "s/[[:space:]]*$//" \
          -e "s/^\"\(.*\)\"$/\1/" -e "s/^'\(.*\)'$/\1/"
}

[ -f ./.env ] || { bad "./.env не найден — запускайте из каталога со стеком (/home/bitrix/bank-import)"; exit 1; }

CLIENT_ID="$(envv PRIOR_OAUTH_CLIENT_ID)"
KID="$(envv PRIOR_OAUTH_KID)"
AUDIENCE="$(envv PRIOR_OAUTH_AUDIENCE)"
API_BASE="$(envv PRIOR_OAUTH_API_BASE)"
TOKEN_URL="$(envv PRIOR_OAUTH_TOKEN_URL)"
AUTHORIZE_BASE="$(envv PRIOR_OAUTH_AUTHORIZE_BASE)"
AUTH_METHOD="$(envv PRIOR_OAUTH_AUTH_METHOD)"

echo "Проба хоста Приорбанка — $TARGET"
echo "Сейчас в .env: API_BASE=${API_BASE:-<пусто>}  TOKEN_URL=${TOKEN_URL:-<пусто>}"
echo "               AUTHORIZE_BASE=${AUTHORIZE_BASE:-<пусто>}  метод=${AUTH_METHOD:-<по умолчанию>}"
[ -n "$CLIENT_ID" ] && ok "client_id прочитан (${#CLIENT_ID} симв.)" || { bad "PRIOR_OAUTH_CLIENT_ID пуст"; exit 1; }
[ -n "$KID" ] || { bad "PRIOR_OAUTH_KID пуст"; exit 1; }

# --- приватный ключ -----------------------------------------------------------------------------
# ⚠ Форм хранения в `.env` несколько, и они несовместимы. Скрипт пробует их по очереди и ГОВОРИТ,
# какая подошла: диагностика важнее краткости, потому что при отказе выбирать не из чего — ключ
# показать нельзя, а «не разбирается» без подробностей не лечится ничем, кроме угадывания.
#
#   A. одна строка с экранированными переносами: PRIOR_OAUTH_PRIVATE_KEY="-----BEGIN...\n...\n-----END..."
#   B. настоящие переносы: значение занимает несколько строк файла (docker compose так не умеет,
#      но человек, правивший .env руками, пишет именно так — и это самая частая причина отказа);
#   C. base64 без PEM-заголовков (иногда так кладут, чтобы уместить в одну строку).
KEYFILE="$(mktemp /tmp/prior-key.XXXXXX)"; chmod 600 "$KEYFILE"
KEYRAW="$(mktemp /tmp/prior-raw.XXXXXX)"; chmod 600 "$KEYRAW"
trap 'rm -f "$KEYFILE" "$KEYRAW"' EXIT

# Забираем значение ЦЕЛИКОМ: от строки с именем до конца значения. Конец — это либо `-----END`,
# либо закрывающая кавычка, либо начало следующей переменной.
awk '
  BEGIN { grabbing = 0 }
  !grabbing && /^[[:space:]]*(export[[:space:]]+)?PRIOR_OAUTH_PRIVATE_KEY[[:space:]]*=/ {
    line = $0
    sub(/^[[:space:]]*(export[[:space:]]+)?PRIOR_OAUTH_PRIVATE_KEY[[:space:]]*=/, "", line)
    print line
    grabbing = 1
    # Значение закрылось на этой же строке — дальше не читаем.
    if (line ~ /-----END/ || line ~ /\\n/) { exit }
    next
  }
  grabbing {
    # Следующая переменная — значит предыдущее значение кончилось.
    if ($0 ~ /^[[:space:]]*(export[[:space:]]+)?[A-Z][A-Z0-9_]*[[:space:]]*=/) exit
    print
    if ($0 ~ /-----END/) exit
  }
' ./.env > "$KEYRAW"

KEY_LINES="$(wc -l < "$KEYRAW" | tr -d ' ')"
KEY_BYTES="$(wc -c < "$KEYRAW" | tr -d ' ')"
[ "$KEY_BYTES" -gt 1 ] || { bad "PRIOR_OAUTH_PRIVATE_KEY в ./.env не найден или пуст"; exit 1; }

# Снимаем обрамляющие кавычки (в многострочном виде они на первой и последней строке).
sed -e '1s/^[[:space:]]*"//' -e '1s/^[[:space:]]*'"'"'//' \
    -e '$s/"[[:space:]]*$//' -e '$s/'"'"'[[:space:]]*$//' "$KEYRAW" > "$KEYRAW.q" && mv "$KEYRAW.q" "$KEYRAW"

parses() { openssl pkey -in "$1" -noout 2>/dev/null || openssl rsa -in "$1" -noout 2>/dev/null; }

SHAPE=""
# A: экранированные переносы.
if grep -q '\\n' "$KEYRAW"; then
  printf '%b\n' "$(cat "$KEYRAW")" > "$KEYFILE"
  parses "$KEYFILE" && SHAPE="одна строка с экранированными переносами (\\n)"
fi
# B: настоящие переносы — содержимое уже готовый PEM.
if [ -z "$SHAPE" ] && grep -q -- '-----BEGIN' "$KEYRAW"; then
  cp "$KEYRAW" "$KEYFILE"
  parses "$KEYFILE" && SHAPE="настоящие переносы строк ($KEY_LINES строк)"
fi
# C: голый base64 без заголовков — обрамляем сами, пробуя оба типа PEM.
if [ -z "$SHAPE" ] && ! grep -q -- '-----BEGIN' "$KEYRAW"; then
  B64="$(tr -d ' \n\r' < "$KEYRAW")"
  for T in "PRIVATE KEY" "RSA PRIVATE KEY"; do
    { echo "-----BEGIN $T-----"; echo "$B64" | fold -w 64; echo "-----END $T-----"; } > "$KEYFILE"
    if parses "$KEYFILE"; then SHAPE="base64 без PEM-заголовков (подставили $T)"; break; fi
  done
fi

if [ -n "$SHAPE" ]; then
  ok "приватный ключ разобран — форма: $SHAPE"
else
  bad "приватный ключ не разбирается ни в одной из известных форм"
  # ⚠ Печатаем ТОЛЬКО безопасные признаки: количество строк, длину и первые 30 символов ПЕРВОЙ
  # строки. У PEM это заголовок `-----BEGIN …-----`, секрета в нём нет; если там окажется что-то
  # другое — это и есть ответ, почему не разбирается.
  echo "    строк в значении: $KEY_LINES, байт: $KEY_BYTES"
  echo "    начало значения:  $(head -1 "$KEYRAW" | cut -c1-30)"
  echo "    последняя строка: $(tail -1 "$KEYRAW" | cut -c1-30)"
  echo "    содержит '-----BEGIN': $(grep -c -- '-----BEGIN' "$KEYRAW"), '-----END': $(grep -c -- '-----END' "$KEYRAW")"
  echo "    содержит литеральные \\n: $(grep -c '\\n' "$KEYRAW")"
  echo "    ошибка openssl: $(openssl pkey -in "$KEYFILE" -noout 2>&1 | head -1)"
  exit 1
fi

HOSTPORT="${TARGET#https://}"

# --- 1. TLS -------------------------------------------------------------------------------------
head_ "1. TLS: чем подписан хост и доверяем ли мы ему"
# ⚠ Спрашиваем ИМЕННО про корень цепочки. На Альфе мы уже обожглись: у Node свой список корней, он
# УЖЕ системного, и боевой хост выстраивал цепочку до корня, которого во встроенном списке нет —
# снаружи это выглядело как «банк не отвечает», а было вопросом доверия (см. NODE_EXTRA_CA_CERTS).
TLS_OUT="$(echo | timeout 20 openssl s_client -connect "$HOSTPORT" -servername "${HOSTPORT%%:*}" 2>&1)"
if echo "$TLS_OUT" | grep -q "CONNECTED"; then
  ok "TCP+TLS соединение установлено"
  echo "$TLS_OUT" | sed -n 's/^ *[0-9] s:/    цепочка: /p'
  echo "$TLS_OUT" | sed -n 's/^ *[0-9] i:/    выдан:   /p' | tail -1
  V="$(echo "$TLS_OUT" | sed -n 's/^ *Verify return code: //p' | tail -1)"
  case "$V" in
    "0 (ok)") ok "сертификат проверен системным хранилищем: $V" ;;
    "") warn "код проверки не найден в выводе openssl" ;;
    *) warn "системное хранилище НЕ подтверждает цепочку: $V" ;;
  esac
else
  # ⚠ НЕ выходим. Этот шаг диагностический: `openssl s_client` ходит напрямую и не знает про
  # исходящий HTTP-прокси, поэтому на сервере с прокси он падает там, где `curl` работает
  # прекрасно. Оборвать пробу здесь значило бы отказать в ответе из-за инструмента, а не из-за
  # банка. Настоящий гейт достижимости — шаг 2 ниже, он на curl.
  warn "openssl не установил соединение (это НЕ приговор: у него нет прокси, у curl есть)"
  echo "$TLS_OUT" | head -3 | sed 's/^/    /'
fi

# --- 2. discovery -------------------------------------------------------------------------------
head_ "2. Конфигурация сервера авторизации (/oidcdiscovery)"
DISC_FILE="$(mktemp /tmp/prior-disc.XXXXXX)"
DISC_CODE="$(curl -sS -o "$DISC_FILE" -w '%{http_code}' --max-time 30 "$TARGET$DCR_PREFIX/oidcdiscovery" 2>/dev/null || echo 000)"
echo "  HTTP $DISC_CODE  $TARGET$DCR_PREFIX/oidcdiscovery"
if [ "$DISC_CODE" = "200" ]; then
  ok "discovery отвечает"
  ISSUER="$(sed -n 's/.*"issuer"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DISC_FILE" | head -1)"
  TOKEP="$(sed -n 's/.*"token_endpoint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DISC_FILE" | head -1)"
  AUTHEP="$(sed -n 's/.*"authorization_endpoint"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DISC_FILE" | head -1)"
  echo "    issuer:                 ${ISSUER:-<не найден>}"
  echo "    token_endpoint:         ${TOKEP:-<не найден>}"
  echo "    authorization_endpoint: ${AUTHEP:-<не найден>}"
  # ⚠ Это и есть `aud` подписанных нами JWT. Разойдись он с тем, что в .env, — банк отвергнет
  # ассерцию, и снаружи это выглядит как «не тот ключ», а не «не тот хост».
  if [ -n "$ISSUER" ] && [ -n "$AUDIENCE" ]; then
    if [ "$ISSUER" = "$AUDIENCE" ]; then ok "issuer СОВПАДАЕТ с PRIOR_OAUTH_AUDIENCE — менять не нужно"
    else warn "issuer ОТЛИЧАЕТСЯ от PRIOR_OAUTH_AUDIENCE (${AUDIENCE}) — при переключении заменить"; fi
  fi
elif [ "$DISC_CODE" = "000" ]; then
  bad "хост не отвечает вовсе (curl не смог соединиться) — дальше идти некуда"
  rm -f "$DISC_FILE"
  exit 1
else
  warn "discovery не ответил 200 — это уже ответ: сервера авторизации по этому адресу нет"
  show_body "$DISC_FILE"
fi
rm -f "$DISC_FILE"

# --- 3. токен -----------------------------------------------------------------------------------
head_ "3. Действует ли наш БОЕВОЙ client_id на этом хосте"
# ⚠ `client_credentials` выбран намеренно: он ничего не ротирует и ничего не создаёт. Успех
# означает, что регистрация приложения на этом хосте ДЕЙСТВИТЕЛЬНА, то есть подключённые счета
# при переключении не осиротеют.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
NOW="$(date +%s)"
JTI="$(openssl rand -hex 16)"
AUD_FOR_JWT="${ISSUER:-$AUDIENCE}"
HDR="$(printf '{"alg":"RS256","typ":"JWT","kid":"%s"}' "$KID" | b64url)"
PAY="$(printf '{"iss":"%s","sub":"%s","aud":["%s"],"iat":%s,"exp":%s,"jti":"%s"}' \
        "$CLIENT_ID" "$CLIENT_ID" "$AUD_FOR_JWT" "$NOW" "$((NOW+300))" "$JTI" | b64url)"
SIG="$(printf '%s' "$HDR.$PAY" | openssl dgst -sha256 -sign "$KEYFILE" -binary | b64url)"
ASSERTION="$HDR.$PAY.$SIG"
echo "  client_assertion подписан, aud=${AUD_FOR_JWT}"

TOK_FILE="$(mktemp /tmp/prior-tok.XXXXXX)"
TOK_CODE="$(curl -sS -o "$TOK_FILE" -w '%{http_code}' --max-time 45 \
  -X POST "$TARGET$AUTH_PREFIX/oauth2/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=client_credentials' \
  --data-urlencode 'scope=accounts' \
  --data-urlencode 'client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer' \
  --data-urlencode "client_assertion=$ASSERTION" 2>/dev/null || echo 000)"
echo "  HTTP $TOK_CODE  POST $TARGET$AUTH_PREFIX/oauth2/token"
ACCESS=""
if [ "$TOK_CODE" = "200" ]; then
  ACCESS="$(sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$TOK_FILE" | head -1)"
  if [ -n "$ACCESS" ]; then
    ok "ТОКЕН ПОЛУЧЕН — боевой client_id на этом хосте ДЕЙСТВУЕТ (длина ${#ACCESS}, значение не печатаем)"
  else
    warn "200, но access_token в ответе не нашёлся"
  fi
else
  bad "токен не выдан — регистрация на этом хосте не действует ЛИБО метод аутентификации другой"
  # ⚠ Тело ошибки печатаем: там `error`/`error_description` банка, секретов в нём нет.
  show_body "$TOK_FILE"
fi
rm -f "$TOK_FILE"

# --- 4. ресурсный API ---------------------------------------------------------------------------
head_ "4. Отвечает ли ресурсный API (Open-banking)"
if [ -z "$ACCESS" ]; then
  warn "пропускаю — нет токена"
elif [ "$WITH_CONSENT" != "1" ]; then
  echo "  пропускаю: создание согласия — ЗАПИСЬ в банк. Повторите с --with-consent, если нужно."
else
  EXP="$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v+1d +%Y-%m-%dT%H:%M:%SZ)"
  CONS_FILE="$(mktemp /tmp/prior-cons.XXXXXX)"
  # ⚠ Банк проверяет эти два заголовка ДО тела: `x-fapi-interaction-id` на любом вызове,
  # `x-idempotency-key` на записи (#461). Без них — 400 про заголовок, а не про суть.
  CONS_CODE="$(curl -sS -o "$CONS_FILE" -w '%{http_code}' --max-time 45 \
    -X POST "$TARGET$OB_PREFIX/accountConsents" \
    -H "authorization: Bearer $ACCESS" \
    -H "x-fapi-interaction-id: $(openssl rand -hex 16)" \
    -H "x-idempotency-key: $(openssl rand -hex 16)" \
    -H 'content-type: application/json' \
    --data "{\"data\":{\"permissions\":[\"ReadAccountsDetail\",\"ReadStatementsDetail\",\"ReadTransactionsDetail\",\"ReadTransactionsCredits\",\"ReadTransactionsDebits\"],\"expirationDate\":\"$EXP\"}}" \
    2>/dev/null || echo 000)"
  echo "  HTTP $CONS_CODE  POST $TARGET$OB_PREFIX/accountConsents"
  if [ "$CONS_CODE" = "201" ] || [ "$CONS_CODE" = "200" ]; then
    ok "РЕСУРСНЫЙ API РАБОТАЕТ на этом хосте (создано пробное согласие — оно не используется и истечёт)"
  else
    bad "ресурсный API не принял запрос"
    show_body "$CONS_FILE"
  fi
  rm -f "$CONS_FILE"
fi

# --- итог ---------------------------------------------------------------------------------------
head_ "Что это означает"
if [ -n "$ACCESS" ]; then
  echo "  Хост принимает СЕРВЕРНЫЕ вызовы нашим боевым client_id."
  echo "  Значит крипто-шлюз для этих вызовов не обязателен, и подключённые счета"
  echo "  переключение переживут: гранты выданы тем же сервером авторизации."
  echo "  ⚠ Проверить перед переключением: issuer выше должен совпасть с PRIOR_OAUTH_AUDIENCE."
else
  echo "  Хост НЕ принял наш боевой client_id. Переключать прод нельзя:"
  echo "  либо это другой реестр приложений, либо другой метод аутентификации,"
  echo "  либо серверная роль у этого адреса отсутствует и он только для браузера."
fi
echo
echo "  Порядок переключения и обратного отката — docs/OPERATIONS.md, раздел про Приор."
