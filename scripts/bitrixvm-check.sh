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
# ⚠ Порт передаёт вызывающий (`make bitrix-check` берёт APP_BIND_PORT из .env). Зашитая
# восьмёрка-тысяча на установке с другим портом давала бы уверенно ЛОЖНЫЕ «контейнер не
# слушает» и «порт в конфиге не совпадает» — то есть диагностика посылала бы чинить исправное.
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
# ⚠ `grep | wc` под `set -e` + `pipefail` умирает, когда grep ничего не нашёл (код 1) или
# каталога нет (код 2) — то есть ровно в тех случаях, ради которых диагностику и запускают:
# домена ещё нет, каталог не создан. Поэтому неудача grep гасится ЯВНО, до конвейера.
# ⚠ `grep -R`, а НЕ `-r`: в site_enabled лежат СИМВОЛИЧЕСКИЕ ССЫЛКИ на site_avaliable, а `-r`
# их не разыменовывает. С `-r` проверка находила ноль блоков на исправном стенде и печатала
# «0 (ожидаемо 2)» со значком OK — то есть молчала бы и при настоящем дубле. Замерено на живой ВМ.
dupes=$({ grep -Rl "server_name .*\b$DOMAIN\b" /etc/nginx/bx/site_enabled/ /etc/nginx/bx/site_ext_enabled/ 2>/dev/null || true; } | wc -l)
# Ноль — это НЕ «дублей нет», а «сайт не найден вовсе»: либо домен опечатан, либо конфиги не
# включены. Разводим три исхода, потому что чинятся они по-разному.
if [ "$dupes" -eq 0 ]; then
  bad "конфигов сайта с этим именем не найдено — проверь домен и содержимое site_enabled"
elif [ "$dupes" -le 2 ]; then
  ok "server-блоков с этим именем: $dupes (ожидаемо 2 — http и https)"
else
  bad "server-блоков с этим именем: $dupes — есть лишний, домен может уйти не туда"
fi

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
  # ⚠ Не `read` из подстановки процесса: curl не печатает перевод строки, поэтому `read`
  # возвращает 1, и при `set -e` скрипт умирает ровно здесь — на своей главной проверке,
  # не напечатав ни вердикта, ни следующего раздела. Замерено запуском.
  probe=$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' --max-time 10 "${h[@]}" "http://127.0.0.1$asset" || echo '000 -')
  code=${probe%% *}; type=${probe#* }
  case "$code:$type" in
    200:*javascript*) ok "статика $asset отдаётся приложением" ;;
    *)                bad "статика $asset: код $code, тип $type"
                      note "перехват не сработал — это страница ошибки BitrixEnv вместо скрипта" ;;
  esac
else
  bad "в HTML не нашлось ссылки на /_nuxt/* — лендинг отдаёт не приложение"
fi

echo "== автообновление =="
# Один вариант — cron под bitrix (docs/DEPLOY_BITRIXVM.md, шаг 6); пути фиксированы.
AD=/home/bitrix/bank-app-deploy
if [ "$(id -un)" = bitrix ]; then ct=$(crontab -l 2>/dev/null); else ct=$(crontab -l -u bitrix 2>/dev/null); fi
if printf '%s\n' "$ct" | grep -v '^[[:space:]]*#' | grep -q 'bank-app-deploy'; then
  ok "строка в crontab bitrix есть"
else
  note "строки в crontab bitrix нет — автообновление не включено (шаг 6)"
fi
[ -e "$AD/state/paused" ] && note "автообновление на паузе (make deploy-resume)"
sha=$(cat "$AD/state/deployed_sha" 2>/dev/null || echo '—')
note "развёрнутый коммит: ${sha:0:12}"
