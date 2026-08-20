#!/usr/bin/env bash
# Переключение Приорбанка между крипто-шлюзом и прямым адресом (#522).
#
# Меняет РОВНО ДВЕ переменные в ./.env и перезапускает backend и worker. Ничего больше не трогает.
#
#   bash prior-switch-host.sh --to-direct    # напрямую на api.priorbank.by:9344 (без BY-крипто)
#   bash prior-switch-host.sh --to-gateway   # обратно через crypto-gw (BY-крипто)
#   bash prior-switch-host.sh --show         # только показать текущее состояние
#
# ⚠ Почему скриптом, а не `sed` руками. Половинчатый переезд — самый неприятный исход: подключение
# и первая выписка строят адрес из `API_BASE`, а обновление токена читает ТОЛЬКО `TOKEN_URL`.
# Поменяв одну переменную, вы получите полностью рабочий на вид стенд, который встанет через час,
# когда истечёт первый токен, — и ошибка будет выглядеть обычным сбоем рефреша. Здесь они всегда
# меняются вместе.
#
# ⚠ Что НЕ трогается намеренно:
#   PRIOR_OAUTH_AUTHORIZE_BASE — адрес, который открывает БРАУЗЕР владельца счёта. Он публичный и
#     остаётся `:9344` в обоих режимах: через шлюз браузеру не пройти.
#   PRIOR_OAUTH_AUDIENCE — не адрес транспорта, а claim `aud` в подписанном JWT. Он равен `issuer`
#     из `/oidcdiscovery` и при смене двери не меняется. Поменять «за компанию» — получить
#     `invalid_client`, сообщение о котором укажет на ключ, а не на конфигурацию.

set -u

GW_BASE="http://crypto-gw:1080"
DIRECT_BASE="https://api.priorbank.by:9344"
TOKEN_PATH="/open-banking-authorize/v1.0/oauth2/token"

MODE=""
for a in "$@"; do
  case "$a" in
    --to-direct)  MODE="direct" ;;
    --to-gateway) MODE="gateway" ;;
    --show)       MODE="show" ;;
    *) echo "не понял аргумент: $a"; exit 2 ;;
  esac
done
[ -n "$MODE" ] || { sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }

ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }

[ -f ./.env ] || { bad "./.env не найден — запускайте из каталога со стеком"; exit 1; }
COMPOSE="docker-compose.prod.yml"
[ -f "$COMPOSE" ] || { bad "$COMPOSE не найден"; exit 1; }

envv() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=//p" ./.env 2>/dev/null \
    | head -1 | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]][[:space:]]*#.*$//" -e "s/[[:space:]]*$//" \
                    -e "s/^\"\(.*\)\"$/\1/" -e "s/^'\(.*\)'$/\1/"
}

show_state() {
  echo "  PRIOR_OAUTH_API_BASE        = $(envv PRIOR_OAUTH_API_BASE)"
  echo "  PRIOR_OAUTH_TOKEN_URL       = $(envv PRIOR_OAUTH_TOKEN_URL)"
  echo "  PRIOR_OAUTH_AUTHORIZE_BASE  = $(envv PRIOR_OAUTH_AUTHORIZE_BASE)   (не меняем)"
  echo "  PRIOR_OAUTH_AUDIENCE        = $(envv PRIOR_OAUTH_AUDIENCE)   (не меняем)"
}

echo "Сейчас:"; show_state
[ "$MODE" = "show" ] && exit 0

if [ "$MODE" = "direct" ]; then
  NEW_BASE="$DIRECT_BASE"
  LABEL="НАПРЯМУЮ (без белорусской криптографии)"
else
  NEW_BASE="$GW_BASE"
  LABEL="ЧЕРЕЗ КРИПТО-ШЛЮЗ"
  # ⚠ Шлюз в compose закомментирован по умолчанию. Переключить переменные на несуществующий
  # сервис значит уронить опрос до состояния «имя не резолвится», и выглядеть это будет как
  # сетевой сбой банка, а не как незаконченная настройка.
  if ! grep -qE '^[[:space:]]{2}crypto-gw:' "$COMPOSE"; then
    bad "сервис crypto-gw в $COMPOSE закомментирован — сначала раскомментируйте его, cryptonet"
    bad "и строки '- cryptonet' у backend и worker, иначе адрес $GW_BASE не резолвится"
    exit 1
  fi
fi
NEW_TOKEN="$NEW_BASE$TOKEN_PATH"

BACKUP="./.env.bak-$(date +%Y%m%d-%H%M%S)"
cp ./.env "$BACKUP" && ok "резервная копия: $BACKUP"

# Заменяем строку, если она есть; дописываем, если нет. ⚠ Обе переменные — всегда вместе.
set_var() {
  local name="$1" value="$2"
  if grep -qE "^[[:space:]]*(export[[:space:]]+)?$name[[:space:]]*=" ./.env; then
    # Разделитель `|` — в значениях есть `/`, но `|` в URL не встречается.
    sed -i "s|^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$name[[:space:]]*=.*|$name=$value|" ./.env
  else
    printf '%s=%s\n' "$name" "$value" >> ./.env
  fi
}
set_var PRIOR_OAUTH_API_BASE "$NEW_BASE"
set_var PRIOR_OAUTH_TOKEN_URL "$NEW_TOKEN"

echo
echo "Стало ($LABEL):"; show_state

# Сверяем, что записалось именно то, что хотели: `sed` мог не сработать на неожиданном форматировании.
[ "$(envv PRIOR_OAUTH_API_BASE)" = "$NEW_BASE" ] || { bad "API_BASE записался не так — откат: cp $BACKUP ./.env"; exit 1; }
[ "$(envv PRIOR_OAUTH_TOKEN_URL)" = "$NEW_TOKEN" ] || { bad "TOKEN_URL записался не так — откат: cp $BACKUP ./.env"; exit 1; }
ok "обе переменные записаны согласованно"

echo
echo "Перезапускаю backend и worker…"
# ⚠ Оба: подключение живёт на backend, опрос — на worker. Перезапустить один значит получить
# рабочую настройку при неработающем опросе (или наоборот), и разойдутся они молча.
if docker compose -f "$COMPOSE" up -d backend worker; then
  ok "сервисы подняты"
else
  bad "перезапуск не удался — откат: cp $BACKUP ./.env && docker compose -f $COMPOSE up -d backend worker"
  exit 1
fi

echo
echo "Проверка (переменные читаются один раз при старте, поэтому смотрим уже поднятые):"
docker compose -f "$COMPOSE" exec -T backend printenv PRIOR_OAUTH_API_BASE 2>/dev/null | sed 's/^/  backend API_BASE = /' || warn "не смог прочитать окружение backend"
docker compose -f "$COMPOSE" exec -T worker printenv PRIOR_OAUTH_TOKEN_URL 2>/dev/null | sed 's/^/  worker TOKEN_URL = /' || warn "не смог прочитать окружение worker"

echo
echo "Откат одной командой:"
echo "  cp $BACKUP ./.env && docker compose -f $COMPOSE up -d backend worker"
