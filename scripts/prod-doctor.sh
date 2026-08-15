#!/usr/bin/env bash
# Проверка боевого стенда одним прогоном: что запущено, что здорово, что отвечает.
#
# Зачем скрипт, а не набор команд в рантбуке: диагностику зовут в момент аварии, когда собирать
# команды по памяти дороже всего, а пропустить один шаг — легко. Здесь фиксированный порядок и
# читаемый вывод.
#
# ⚠ СЕКРЕТЫ НЕ ПЕЧАТАЕТ. По переменным окружения выводится только «задано / не задано» и длина:
# `docker compose config` печатает значения в открытую, и однажды это уже привело к тому, что
# пароль оператора и ключ подписи уехали в переписку.
#
# Запуск на сервере, из каталога с docker-compose.prod.yml и .env:
#   bash scripts/prod-doctor.sh            # без внешних проверок
#   bash scripts/prod-doctor.sh ВАШ.ДОМЕН  # плюс проверка снаружи по HTTPS
set -uo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
DC="docker compose -f $COMPOSE_FILE"
DOMAIN="${1:-}"
FAILED=0

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mПЛОХО\033[0m %s\n' "$1"; FAILED=$((FAILED+1)); }
warn() { printf '  \033[33m?\033[0m    %s\n' "$1"; }

[ -f "$COMPOSE_FILE" ] || { echo "Нет $COMPOSE_FILE — запускать из каталога развёртывания"; exit 2; }

say "Контейнеры"
$DC ps --format '  {{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || bad "docker compose ps не отработал"

say "Здоровье"
# Читаем состояние у docker, а не глазами по строке Status: healthcheck может «врать» (см.
# OPERATIONS.md, история про localhost/IPv6), поэтому ниже проверяем ещё и сами эндпоинты.
for svc in app backend worker db redis; do
  cid=$($DC ps -q "$svc" 2>/dev/null | head -1)
  if [ -z "$cid" ]; then
    # Отсутствие worker — штатная конфигурация (обработка живёт в backend при scale=0).
    # Отсутствие остальных — авария, и молчать про неё нельзя.
    if [ "$svc" = "worker" ]; then warn "$svc — контейнера нет (нормально при scale=0)"
    else bad "$svc — контейнера НЕТ"; fi
    continue
  fi
  state=$(docker inspect -f '{{.State.Status}}' "$cid" 2>/dev/null)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}—{{end}}' "$cid" 2>/dev/null)
  restarts=$(docker inspect -f '{{.RestartCount}}' "$cid" 2>/dev/null)
  oom=$(docker inspect -f '{{.State.OOMKilled}}' "$cid" 2>/dev/null)
  line="$svc: $state/$health, рестартов $restarts"
  [ "$oom" = "true" ] && line="$line, УБИТ ПО ПАМЯТИ"
  case "$state/$health" in
    running/healthy|running/—) ok "$line" ;;
    running/starting)          warn "$line" ;;
    *)                         bad "$line" ;;
  esac
done

say "Эндпоинты изнутри сети"
if $DC exec -T app wget -qO- http://127.0.0.1:8080/ 2>/dev/null | head -c 15 | grep -q '<!DOCTYPE'; then
  ok "app отдаёт статику на :8080"
else
  bad "app не отвечает на 127.0.0.1:8080 — смотреть '$DC logs app'"
fi

health_json=$($DC exec -T backend wget -qO- http://127.0.0.1:3000/api/health 2>/dev/null)
echo "$health_json" | grep -q '"status":"ok"' && ok "backend /api/health: ok" || bad "backend /api/health не ответил"
printf '       %s\n' "$(echo "$health_json" | head -c 200)"

ready_json=$($DC exec -T backend wget -qO- http://127.0.0.1:3000/api/ready 2>/dev/null)
case "$ready_json" in
  *'"status":"ok"'*)       ok "backend /api/ready: ok (Postgres и Redis живы)" ;;
  *'"status":"degraded"'*) warn "backend /api/ready: degraded — Redis недоступен, очереди стоят" ;;
  *'"status":"down"'*)     bad "backend /api/ready: down — Postgres недоступен" ;;
  *)                       bad "backend /api/ready не ответил (проба сама по себе не должна висеть)" ;;
esac
printf '       %s\n' "$(echo "$ready_json" | head -c 200)"

say "Переменные окружения (только факт и длина — значения не печатаем)"
for var in B24_TOKEN_ENC_KEY DATABASE_URL PUBLIC_PAGE_BASIC_AUTH_PASS SESSION_SECRET B24_CLIENT_ID B24_CLIENT_SECRET; do
  len=$($DC exec -T backend sh -c "printf %s \"\${$var:-}\" | wc -c" 2>/dev/null | tr -d '[:space:]')
  if [ -n "$len" ] && [ "$len" -gt 0 ] 2>/dev/null; then ok "$var задан ($len симв.)"; else bad "$var НЕ задан"; fi
done

say "Крипто-шлюз Приорбанка (если включён)"
# Секция целиком необязательная: у большинства развёртываний шлюза нет, и его отсутствие — не
# авария. Но если он поднят, проверить надо ТРИ вещи, и каждая однажды стоила часа.
if $DC ps --format '{{.Service}}' 2>/dev/null | grep -q '^crypto-gw$'; then
  gw_log=$($DC logs --tail 40 crypto-gw 2>/dev/null)

  # 1. Понимает ли образ GW_ALLOW вообще. Старый образ переменную ИГНОРИРУЕТ молча: контейнер
  #    стартует, маршруты остаются прежними, в логе ни слова — отличить это от «список неверный»
  #    снаружи нечем. Строка про число маршрутов и есть тот признак.
  routes=$(printf '%s' "$gw_log" | grep -o 'allowlist: разрешено маршрутов — [0-9]*' | tail -1)
  if [ -n "$routes" ]; then ok "$routes"
  else bad "образ шлюза не печатает allowlist — он СТАРШЕ поддержки GW_ALLOW, переменная игнорируется"; fi

  # 2. Доверяет ли он корням и подтверждают ли они эталонный сертификат банка.
  printf '%s' "$gw_log" | grep -q 'bundle подтверждает эталонный сертификат банка — OK' \
    && ok "корни ГосСУОК подтверждают сертификат банка" \
    || bad "шлюз не подтвердил сертификат банка — смотреть '$DC logs crypto-gw'"

  # 3. Доходит ли трафик ДО БАНКА. Разница читается по `upstream`: прочерк — отказ вынес сам шлюз
  #    (путь вне списка), число — ответил банк. Мы бьём в ресурсный API без токена и ждём 401:
  #    это ответ банка, то есть доказательство, что рукопожатие по СТБ 34.101.65 состоялось.
  probe=$($DC exec -T backend node -e "fetch('http://crypto-gw:1080/open-banking/v1.0/accounts').then(r=>console.log(r.status)).catch(e=>console.log('ERR',e.cause&&e.cause.code))" 2>/dev/null | tr -d '[:space:]')
  case "$probe" in
    401) ok "банк отвечает через шлюз (401 без токена — рукопожатие состоялось)" ;;
    404) bad "шлюз вернул 404 — ресурсный API вне списка маршрутов, проверить GW_ALLOW" ;;
    "")  bad "проба через шлюз не отработала — backend в сети cryptonet? (частая забытая строка)" ;;
    *)   warn "проба через шлюз: $probe (ожидался 401)" ;;
  esac
else
  warn "crypto-gw не запущен — прод Приорбанка недоступен (для песочницы это нормально)"
fi

say "Жалобы в логах (последний час)"
# ⚠ Пустой grep сам по себе НЕ означает «всё хорошо»: если контейнеров нет или логи не читаются,
# он тоже пуст. Разводим эти два смысла — иначе тотальная авария выглядела бы зелёной строкой.
raw_logs=$($DC logs --since 1h backend worker 2>/dev/null)
if [ -z "$raw_logs" ]; then
  warn "логи пусты или недоступны — судить не по чему (контейнеры подняты?)"
else
  complaints=$(printf '%s' "$raw_logs" | grep -E '\[env\]|\[auth\]|\[queue-job-failed\].*FINAL' | tail -20)
  if [ -z "$complaints" ]; then ok "ни [env], ни [auth], ни финальных падений задач"
  else bad "есть жалобы:"; printf '       %s\n' "$complaints"; fi
fi

if [ -n "$DOMAIN" ]; then
  say "Снаружи, по HTTPS"
  # `|| code=000` заменяет значение целиком: curl при отказе и сам печатает 000, и выходит с
  # ненулевым кодом, поэтому `|| echo 000` склеивал два в «000000». `--max-time` — чтобы висящий
  # эндпоинт не подвесил всю диагностику.
  http() { local c; c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null) || c=000; echo "${c:-000}"; }
  code=$(http "https://$DOMAIN/")
  [ "$code" = "200" ] && ok "лендинг: $code" || bad "лендинг: $code"

  code=$(http "https://$DOMAIN/api/health")
  [ "$code" = "200" ] && ok "/api/health: $code" || bad "/api/health: $code"

  # Ключевая проверка: служебные данные наружу без сессии отдаваться НЕ должны.
  code=$(http "https://$DOMAIN/api/ops/app-rating")
  case "$code" in
    401) ok "/api/ops/app-rating без cookie: 401 — зона закрыта" ;;
    200) bad "/api/ops/app-rating без cookie: 200 — ЗОНА ОТКРЫТА НАРУЖУ, задать PUBLIC_PAGE_BASIC_AUTH_PASS" ;;
    *)   warn "/api/ops/app-rating без cookie: $code" ;;
  esac

  # Несуществующий адрес обязан быть 404, а не лендингом с кодом 200 (soft-404, #425).
  code=$(http "https://$DOMAIN/no-such-page-$$")
  [ "$code" = "404" ] && ok "несуществующий адрес: 404" || bad "несуществующий адрес: $code (ожидался 404)"
else
  say "Снаружи"
  warn "домен не передан — пропущено. Запуск: bash scripts/prod-doctor.sh ВАШ.ДОМЕН"
fi

say "Итог"
[ "$FAILED" -eq 0 ] && ok "проблем не найдено" || bad "проблем: $FAILED — разбор в docs/OPERATIONS.md «Частые сбои»"
exit 0
