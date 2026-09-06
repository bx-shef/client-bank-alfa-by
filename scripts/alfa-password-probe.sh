#!/usr/bin/env bash
# Проба: принимает ли НАША промышленная регистрация Альфы авторизацию по ключу API (#488).
#
# ЗАЧЕМ. Замер 2026-09-06 показал, что банк отвергает продление словами
# `invalid_grant: User session not alive`: токен Code Grant выдан ВНУТРИ сессии входа владельца
# счёта, и с её концом грант умирает — задолго до срока refresh-токена. Документация Альфы
# описывает второй тип авторизации, Password Grant: владелец однократно генерирует ключ API в
# кабинете Альфа Бизнес Онлайн, дальше сервер меняет ключ на токены без браузера и без человека.
# Сессии, которая умирает, там просто нет.
#
# ⚠ Один вопрос отделяет находку от починки: примет ли `grant_type=password` наша ПРОМЫШЛЕННАЯ
# регистрация, или нужно отдельное приложение. В гайде тип выбирается при создании приложения, то
# есть похоже на свойство регистрации, — но «похоже» не годится, а один HTTP-запрос отвечает точно.
# Ради этого проба и написана: строить весь поток, не зная ответа, — риск построить второй раз не то.
#
# ⚠ ЧТО ПРОБА НЕ ДЕЛАЕТ. Она не трогает refresh-токены подключённых счетов и ничего не сохраняет в
# базу. Банк ротирует refresh при каждом обновлении, и проба, выбросившая новый, убила бы живое
# подключение — лечится это только повторным входом владельца счёта в интернет-банк (#505/#509).
# Здесь идёт РОВНО ОДИН запрос за новой парой токенов по ключу API; полученные токены печатаются
# только длиной и выбрасываются.
#
# ⚠ СЕКРЕТЫ В ВЫВОД НЕ ПОПАДАЮТ: ни ключ API, ни `client_secret`, ни сами токены. Печатаются код
# ответа, поля ошибки банка и длины. Тело запроса не логируется вовсе.
#
# Использование (из /home/bitrix/bank-import, где лежит .env):
#   ALFA_API_KEY='<ключ из кабинета Альфа Бизнес Онлайн>' bash alfa-password-probe.sh
#
# ⚠ Ключ передаётся ПЕРЕД командой, а не параметром `make`: значение параметра make раскрывается
# до шелла, поэтому попадает в вывод `make -n` и в процесс-лист. Тот же довод, что у `REF`.
set -u

cd /home/bitrix/bank-import 2>/dev/null || true

KEY="${ALFA_API_KEY:-}"
if [ -z "$KEY" ]; then
  echo "Не задан ключ API. Запуск:"
  echo "  ALFA_API_KEY='<ключ из кабинета Альфа Бизнес Онлайн>' make alfa-password-probe"
  echo
  echo "Где взять ключ: Альфа Бизнес Онлайн → личный кабинет → генерация ключа API."
  echo "В ПЕСОЧНИЦЕ вместо ключа документация велит слать буквальное значение API."
  exit 2
fi

envval() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- ; }
CLIENT_ID="$(envval ALFA_OAUTH_CLIENT_ID)"
CLIENT_SECRET="$(envval ALFA_OAUTH_CLIENT_SECRET)"
TOKEN_URL="$(envval ALFA_OAUTH_TOKEN_URL)"
SCOPE="$(envval ALFA_OAUTH_SCOPE)"
[ -n "$SCOPE" ] || SCOPE="accounts"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ] || [ -z "$TOKEN_URL" ]; then
  echo "В .env нет ALFA_OAUTH_CLIENT_ID / _CLIENT_SECRET / _TOKEN_URL — пробовать нечем."
  exit 2
fi

echo "== Проба Password Grant у Альфы (#488) =="
echo "адрес : $TOKEN_URL"
echo "scope : $SCOPE"
echo "ключ  : задан (${#KEY} символов, в вывод не попадает)"
echo

body=$(mktemp) && trap 'rm -f "$body"' EXIT
# ⚠ `--data-urlencode` обязателен: документация Альфы прямо требует URL-кодирования тела по
# RFC 6749 Appendix B, а ключ API может содержать символы, которые сырой `-d` испортит молча.
code=$(curl -sS -o "$body" -w '%{http_code}' -X POST "$TOKEN_URL" \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=password' \
  --data-urlencode "username=$KEY" \
  --data-urlencode "client_id=$CLIENT_ID" \
  --data-urlencode "client_secret=$CLIENT_SECRET" \
  --data-urlencode "scope=$SCOPE" 2>/dev/null) || code="000"

echo "HTTP $code"
case "$code" in
  200)
    # ⚠ Печатаем ДЛИНЫ, а не значения: это рабочие токены к счетам клиента.
    at=$(grep -o '"access_token"[^,}]*' "$body" | head -1 | sed 's/.*: *"//; s/"$//')
    rt=$(grep -o '"refresh_token"[^,}]*' "$body" | head -1 | sed 's/.*: *"//; s/"$//')
    ei=$(grep -o '"expires_in"[^,}]*' "$body" | head -1 | sed 's/[^0-9]//g')
    echo "✅ РЕГИСТРАЦИЯ ПРИНИМАЕТ Password Grant."
    echo "   access_token : получен (${#at} символов)"
    echo "   refresh_token: ${rt:+получен (${#rt} символов)}${rt:-НЕ выдан}"
    echo "   expires_in   : ${ei:-неизвестно} с"
    echo
    echo "Значит починка #488 реализуема на текущей регистрации: ключ API живёт постоянно,"
    echo "и обрыв цепочки refresh больше не стоит похода владельца счёта в интернет-банк."
    ;;
  400|401|403)
    echo "❌ Банк отказал. Что он ответил (секреты вырезаны):"
    sed 's/"client_secret":"[^"]*"/"client_secret":"***"/g' "$body" | head -c 800
    echo
    echo
    echo "Как читать:"
    echo "  • про unsupported_grant_type / grant type            → регистрация НЕ включает Password Grant;"
    echo "     нужен переключатель типа на портале либо отдельное приложение с промышленными ключами;"
    echo "  • про invalid_client                                 → вопрос к client_id/secret, а не к типу;"
    echo "  • про пользователя, username или ключ                → тип принят, а не подошёл сам ключ:"
    echo "     проверьте, что он сгенерирован в кабинете ЭТОГО клиента и не истёк."
    ;;
  000)
    echo "❌ Не достучались до банка вовсе: сеть, TLS или адрес. Проверьте 'make doctor'."
    ;;
  *)
    echo "Неожиданный код. Ответ банка (секреты вырезаны):"
    sed 's/"client_secret":"[^"]*"/"client_secret":"***"/g' "$body" | head -c 800
    echo
    ;;
esac
