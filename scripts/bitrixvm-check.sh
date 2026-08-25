#!/usr/bin/env bash
# Диагностика связки «nginx виртуальной машины Битрикс24 → контейнер» (docs/DEPLOY_BITRIXVM.md).
#
# Отвечает на один вопрос: доедет ли запрос с домена до приложения целиком — включая статику,
# которую конфигурация BitrixVM норовит перехватить и отдать из пустого docroot.
#
# Запуск:  make bitrix-check              (домен берётся из ./.env)
#          make bitrix-check DOMAIN=…
set -Eeuo pipefail

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || { echo "не задан домен: make bitrix-check DOMAIN=bank-app.example.by" >&2; exit 1; }
PORT="${2:-8080}"

ok()   { printf '  \033[32mOK\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mНЕТ\033[0m  %s\n' "$*"; }
note() { printf '       %s\n' "$*"; }

echo "== конфигурация nginx =="
conf="/etc/nginx/bx/site_settings/$DOMAIN/00-app-proxy.conf"
if [ -f "$conf" ]; then
  ok "конфиг проксирования на месте"
  grep -q "127.0.0.1:$PORT" "$conf" && ok "\$proxyserver указывает на 127.0.0.1:$PORT" \
    || bad "\$proxyserver в конфиге не совпадает с портом $PORT"
else
  bad "нет $conf — домен отдаёт Apache, а не приложение"
fi
nginx -t >/dev/null 2>&1 && ok "nginx -t проходит" || bad "nginx -t падает — смотри 'nginx -t'"

# ⚠ Свой server-блок с тем же именем — самая дорогая ошибка этой площадки: nginx берёт первый по
# порядку инклюда (блок BitrixVM), домен молча отдаёт портал, и снаружи это неотличимо от
# «приложение не поднялось». Ищем именно дубль имени, а не наличие файлов.
dupes=$(grep -rl "server_name .*\b$DOMAIN\b" /etc/nginx/bx/site_enabled/ /etc/nginx/bx/site_ext_enabled/ 2>/dev/null | wc -l)
[ "$dupes" -le 2 ] && ok "server-блоков с этим именем: $dupes (ожидаемо 2 — http и https)" \
  || bad "server-блоков с этим именем: $dupes — есть лишний, домен может уйти не туда"

echo "== контейнер напрямую =="
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/api/health" || echo 000)
[ "$code" = 200 ] && ok "health = 200" || bad "health = $code — контейнер не слушает 127.0.0.1:$PORT"
ready=$(curl -sS --max-time 10 "http://127.0.0.1:$PORT/api/ready" || echo '')
case "$ready" in
  *'"ready":true'*) ok "ready: зависимости живы" ;;
  '')               bad "ready не ответил" ;;
  *)                bad "ready: $ready" ;;
esac

echo "== через nginx (по Host, без TLS — работает и до появления домена) =="
h=(-H "Host: $DOMAIN")
code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${h[@]}" http://127.0.0.1/ || echo 000)
[ "$code" = 200 ] && ok "лендинг = 200" || bad "лендинг = $code"

# ⚠ Главная проверка файла. bitrix_general.conf ловит .css/.js БЕЗ proxy_pass и отдаёт их из
# docroot, подменяя 404 страницей BitrixEnv. Тогда HTML приходит, а скрипты нет — снаружи это
# выглядит как «открылось, но не работает», и причину ищут в приложении.
asset=$(curl -sS --max-time 10 "${h[@]}" http://127.0.0.1/ | grep -o '/_nuxt/[^"]*\.js' | head -1 || true)
if [ -n "$asset" ]; then
  read -r code type < <(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "${h[@]}" "http://127.0.0.1$asset")
  case "$code:$type" in
    200:*javascript*) ok "статика $asset отдаётся приложением" ;;
    *)                bad "статика $asset: код $code, тип $type"
                      note "перехват не сработал — это страница ошибки BitrixEnv вместо скрипта" ;;
  esac
else
  bad "в HTML не нашлось ссылки на /_nuxt/* — лендинг отдаёт не приложение"
fi

echo "== автообновление =="
if systemctl is-enabled --quiet bank-app-deploy.timer 2>/dev/null; then
  ok "таймер включён; следующий запуск: $(systemctl show -p NextElapseUSecRealtime --value bank-app-deploy.timer 2>/dev/null)"
  sha=$(cat /var/lib/bank-app-deploy/deployed_sha 2>/dev/null || echo '—')
  note "развёрнутый коммит: ${sha:0:12}"
else
  note "таймер не включён (ещё не настроен либо приостановлен)"
fi
