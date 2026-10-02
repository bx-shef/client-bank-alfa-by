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
# Сколько маршрутов открыто в обычной работе. Больше — повод спросить, не забыли ли сузить список
# после разовой регистрации приложения (docs/OPERATIONS.md, «Разовое открытие DCR»).
GW_ROUTES_BASELINE="${GW_ROUTES_BASELINE:-2}"
# Секция целиком необязательная: у большинства развёртываний шлюза нет, и его отсутствие — не
# авария. Но если он поднят, проверить надо ТРИ вещи, и каждая однажды стоила часа.
# ⚠ Смотрим на СОСТОЯНИЕ контейнера, а не на его наличие в списке. `-a` не украшение: без него
# `ps` показывает ТОЛЬКО запущенные, и контейнер в restart-loop (у `crypto-gw` стоит
# `restart: unless-stopped`, а сорванный монтаж корней роняет его в цикл — это описано в
# OPERATIONS.md как типовой сбой) сюда просто не попадёт: мы объявили бы аварию нормой. Но с `-a`
# в списке и остановленный руками шлюз (`make gw-stop` — штатное выключение с #522), и пробы через
# него дали бы сетевую ошибку и ложное «ПЛОХО» про allowlist на исправном сервере, который ходит
# напрямую (#767). Поэтому остановленный — `exited`/`created`/`dead` — идёт в ветку «шлюза нет».
gw_state=$($DC ps -a --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1 == "crypto-gw" { print $2; exit }')
case "$gw_state" in
  '') gw_up=0; gw_word="не развёрнут" ;;
  exited|created|dead) gw_up=0; gw_word="остановлен ($gw_state)" ;;
  *) gw_up=1 ;;
esac
# ⚠ Адресов ДВА — API_BASE (опрос, согласие, счета) и TOKEN_URL (продление токена), и переезд
# между шлюзом и прямым адресом бывает половинчатым: по одному API_BASE мы объявили бы «напрямую»,
# а продление через час упёрлось бы в остановленный шлюз.
# ⚠ Адрес разбирает `URL` внутри backend, а печатаются только схема и хост: значение целиком
# унесло бы в терминал учётные данные, если их вписали в адрес, и управляющие последовательности.
# Разбор — тот же `URL`, что у приложения (`normalizeBankApiBase`): пробелы по краям снимаются,
# `HTTP://` равен `http://`, а не разобранный адрес приложение не примет. Открытый `http://`
# приложение пускает только на внутренний хост — это и есть шлюз; на публичный он не годится, и
# опечатка `http://` вместо `https://` к банку читается как «не примет», а не «нужен шлюз».
# Правило внутреннего хоста — копия `isInternalHost` (bankGatewayUrl.ts): упрощённое дало бы ложное
# «приложение не примет» на адресе, который приложение принимает. Расхождение ловит
# tests/prodDoctorGateway.test.ts — сверкой с `normalizeBankApiBase` и `gatewayOrigin` (по нему же
# решает `/api/ready`) на одних и тех же адресах.
# ⚠ Читаем у работающего процесса, а не в .env: важно, что получил он. Упавший exec (backend
# лежит) — «не проверить», а не «Приорбанк не настроен». `NODE_OPTIONS` пуст — см. пробы шлюза ниже.
prior_route=$($DC exec -T -e NODE_OPTIONS= backend node -e '
const internal = host => {
  const h = host.toLowerCase().replace(/\.$/, "")
  if (h === "localhost") return true
  if (h.startsWith("[") && h.endsWith("]")) {
    const v6 = h.slice(1, -1)
    return v6 === "::1" || v6 === "::" || v6.startsWith("::ffff:")
      || /^f[cd][0-9a-f]{0,2}:/.test(v6) || /^fe[89ab][0-9a-f]?:/.test(v6)
  }
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (m) {
    const a = +m[1], b = +m[2]
    return a === 127 || a === 0 || a === 10 || (a === 192 && b === 168)
      || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  }
  return !h.includes(".") && !h.includes(":")
}
const route = v => {
  v = (v || "").trim()
  if (!v) return "none"
  let u
  try { u = new URL(v) } catch { return "bad" }
  if (u.protocol === "https:") return "direct " + u.host
  if (u.protocol === "http:" && internal(u.hostname)) return "gw " + u.host
  return "bad"
}
process.stdout.write(route(process.env.PRIOR_OAUTH_API_BASE) + "|" + route(process.env.PRIOR_OAUTH_TOKEN_URL))
' 2>/dev/null) || prior_route=""
describe_route() {
  case "$1" in
    none) printf 'не задан' ;;
    bad) printf 'приложение не примет' ;;
    'direct '*) printf 'напрямую %s' "${1#direct }" ;;
    'gw '*) printf 'через шлюз %s' "${1#gw }" ;;
  esac
}
prior_api=""; prior_token=""; prior_routes=""
case "$prior_route" in
  *'|'*)
    prior_api="${prior_route%%|*}"
    prior_token="${prior_route#*|}"
    prior_routes="API_BASE — $(describe_route "$prior_api"), TOKEN_URL — $(describe_route "$prior_token")" ;;
esac
# Вердикт по самим адресам — ОДИН на обе ветки ниже (шлюз жив / шлюза нет): две копии разошлись бы
# молча. Половинчатая настройка — авария, а не повод задуматься: без TOKEN_URL опрос встанет с
# первым истёкшим токеном, без API_BASE Приорбанк не заработает вовсе.
prior_address_problem() {
  case "$prior_api|$prior_token" in
    bad'|'*|*'|bad') bad "адрес Приорбанка приложение не примет ($prior_routes)" ;;
    'none|none') return 1 ;;
    none'|'*|*'|none') bad "Приорбанк настроен наполовину ($prior_routes)" ;;
    *) return 1 ;;
  esac
}

if [ "$gw_up" = 1 ]; then
  gw_log=$($DC logs --tail 40 crypto-gw 2>/dev/null)

  # 1. Понимает ли образ GW_ALLOW вообще. Старый образ переменную ИГНОРИРУЕТ молча: контейнер
  #    стартует, маршруты остаются прежними, в логе ни слова — отличить это от «список неверный»
  #    снаружи нечем. Строка про число маршрутов и есть тот признак.
  routes=$(printf '%s' "$gw_log" | grep -o 'allowlist: разрешено маршрутов — [0-9]*' | tail -1)
  n=$(printf '%s' "$routes" | grep -o '[0-9]*$')
  if [ -z "$routes" ]; then
    bad "образ шлюза не печатает allowlist — он СТАРШЕ поддержки GW_ALLOW, переменная игнорируется"
  elif [ "${n:-0}" -gt "$GW_ROUTES_BASELINE" ] 2>/dev/null; then
    # ⚠ Единственный шаг регистрационного рантбука без своей проверки — возврат списка к узкому.
    # Забыть его легко: всё работает, и ничто не жалуется. Здесь и жалуемся.
    warn "$routes — БОЛЬШЕ базовых $GW_ROUTES_BASELINE: похоже, PRIOR_GW_ALLOW расширяли под разовую регистрацию и не сузили обратно"
  else
    ok "$routes"
  fi


  # 2. Доверяет ли он корням и подтверждают ли они эталонный сертификат банка.
  printf '%s' "$gw_log" | grep -q 'bundle подтверждает эталонный сертификат банка — OK' \
    && ok "корни ГосСУОК подтверждают сертификат банка" \
    || bad "шлюз не подтвердил сертификат банка — смотреть '$DC logs crypto-gw'"

  # 3. Доходит ли трафик ДО БАНКА. Разница читается по `upstream`: прочерк — отказ вынес сам шлюз
  #    (путь вне списка), число — ответил банк. Мы бьём в ресурсный API без токена и ждём 401:
  #    это ответ банка, то есть доказательство, что рукопожатие по СТБ 34.101.65 состоялось.
  # Таймаут обязателен, как и у curl-проверок ниже: шлюз, принявший соединение и замолчавший,
  # иначе подвешивает ВСЮ диагностику — а зовут её в момент аварии, когда это дороже всего.
  # ⚠ `NODE_OPTIONS` у этих node пуст намеренно: образ предзагружает телеметрию, а она печатает
  # свою строку в stdout на каждом старте node — «401» и «404» склеивались бы с ней и не
  # совпадали никогда, то есть исправный шлюз получал бы «ПЛОХО» про allowlist.
  probe=$($DC exec -T -e NODE_OPTIONS= backend node -e "fetch('http://crypto-gw:1080/open-banking/v1.0/accounts',{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status)).catch(e=>console.log('ERR',(e.cause&&e.cause.code)||e.name))" 2>/dev/null | tr -d '[:space:]')
  case "$probe" in
    401)   ok "банк отвечает через шлюз (401 без токена — рукопожатие состоялось)" ;;
    404)   bad "шлюз вернул 404 — ресурсный API вне списка маршрутов, проверить GW_ALLOW" ;;
    "")    bad "проба не дала вывода — контейнер backend запущен? ('$DC ps -a')" ;;
    # ⚠ Забытая строка `- cryptonet` у backend/worker (третье из трёх мест, OPERATIONS.md) даёт
    # именно СЕТЕВУЮ ошибку, а не пустой вывод: имя `crypto-gw` не резолвится. Подсказка висела на
    # пустой ветке, куда этот случай не приходит, — то есть в реальной аварии её никто бы не увидел.
    ERR*)  bad "проба не дошла до шлюза ($probe) — backend в сети cryptonet? (частая забытая строка)" ;;
    *)     warn "проба через шлюз: $probe (ожидался 401)" ;;
  esac

  # Негативная проба. Позитивная не поймала бы молча отключившийся enforcement — а именно так и
  # вёл себя образ, не знавший про GW_ALLOW: маршруты остались прежними, и ни одна проверка «а
  # отвечает ли банк» этого не заметила бы.
  denied=$($DC exec -T -e NODE_OPTIONS= backend node -e "fetch('http://crypto-gw:1080/no-such-route',{signal:AbortSignal.timeout(10000)}).then(r=>console.log(r.status)).catch(e=>console.log('ERR',(e.cause&&e.cause.code)||e.name))" 2>/dev/null | tr -d '[:space:]')
  if [ "$denied" = "404" ]; then ok "неразрешённый путь отбивается шлюзом (404) — список применяется"
  else bad "неразрешённый путь дал «$denied» вместо 404 — allowlist НЕ применяется, шлюз шире, чем задумано"; fi

  # Шлюз жив, но негодный или половинчатый адрес всё равно назвать надо: иначе после
  # `make gw-start` неисправный TOKEN_URL не называл бы никто, а продление встало бы молча.
  prior_address_problem || true
else
  # ⚠ Нет шлюза — само по себе НЕ авария: с 2026-08-19 прод ходит в Приорбанк напрямую на :9344
  # (#522). Авария — только если backend настроен ходить ЧЕРЕЗ шлюз: внутренний http://-адрес
  # (правило — bankGatewayUrl.ts), за которым никто не слушает. Прежнее безусловное «прод
  # Приорбанка недоступен» было ложью на каждом сервере без шлюза (#767).
  if [ -z "$prior_routes" ]; then
    warn "crypto-gw $gw_word; нужен ли он, не проверить — backend не ответил на exec"
  else
    case "$prior_api|$prior_token" in
      'gw '*|*'|gw '*)
        bad "Приорбанк настроен через шлюз, а crypto-gw $gw_word — Приорбанк стоит ($prior_routes)"
        # Половинчатая настройка — отдельная причина: `make gw-start` её не лечит.
        prior_address_problem || true ;;
      'none|none') ok "crypto-gw не используется — Приорбанк на этом сервере не настроен" ;;
      *) prior_address_problem || ok "crypto-gw не используется — Приорбанк напрямую (${prior_api#direct })" ;;
    esac
  fi
fi

say "Связь с банками изнутри backend"
# WHY (2026-10-01): Alfa dropped the DNS record of `ibapi2.alfabank.by`, and the only symptom was
# «банк не принял ключ API» on the owner's screen — nothing here noticed. Each configured bank
# address is resolved and hit ONCE from inside backend (its DNS, its CA roots — the ones that
# matter). Any HTTP status means «network and TLS fine»; the error CODE says what broke.
# ⚠ Only scheme+host are printed; no credentials are sent (plain GET to the origin). An `http://`
# address is the internal gateway — checked by the gateway section above, skipped here.
bank_net=$($DC exec -T -e NODE_OPTIONS= backend node -e '
// bank-net-probe
const names = ["ALFA_OAUTH_TOKEN_URL", "ALFA_OAUTH_API_BASE", "PRIOR_OAUTH_TOKEN_URL", "PRIOR_OAUTH_API_BASE"]
const seen = new Set()
;(async () => {
  for (const n of names) {
    let u
    try { u = new URL(String(process.env[n] || "").trim()) } catch { continue }
    if (u.protocol !== "https:" || seen.has(u.host)) continue
    seen.add(u.host)
    try {
      const r = await fetch(u.origin + "/", { signal: AbortSignal.timeout(8000) })
      console.log("ok " + u.host + " HTTP " + r.status)
    } catch (e) {
      const c = (e && e.cause && (e.cause.code || e.cause.name)) || (e && e.name) || "error"
      console.log("bad " + u.host + " " + c)
    }
  }
})()' 2>/dev/null) || bank_net="unknown"
if [ "$bank_net" = "unknown" ]; then
  warn "не проверить — backend не ответил на exec"
elif [ -z "$bank_net" ]; then
  ok "банковские адреса (https) не заданы — проверять нечего"
else
  while read -r verdict host rest; do
    [ -n "${verdict:-}" ] || continue
    case "$verdict" in
      ok) ok "$host — отвечает ($rest)" ;;
      *) case "$rest" in
           ENOTFOUND|EAI_AGAIN) bad "$host — не резолвится в DNS ($rest): адрес сменил банк или DNS сервера; nslookup $host 8.8.8.8 (docs/OPERATIONS.md «Частые сбои»)" ;;
           *CERT*|*SELF_SIGNED*|*ISSUER*) bad "$host — не доверяем сертификату ($rest): корни хоста, HOST_CA_BUNDLE" ;;
           *) bad "$host — не достучались ($rest)" ;;
         esac ;;
    esac
  done <<< "$bank_net"
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
