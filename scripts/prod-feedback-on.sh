#!/usr/bin/env bash
# Включить канал обратной связи на сервере (#499): записать в ./.env репозиторий-приёмник и токен —
# ТОЛЬКО после того, как проверено, что с ними канал действительно работает.
#
# ⚠ Проверки до записи — несущая часть, а не вежливость. Канал fail-closed: без переменных виджет
# скрыт, и это видно. С НЕВЕРНЫМИ переменными канал выглядит включённым: виджет появляется,
# сотрудник жмёт 👎, GitHub отвечает 4xx — а outbox считает такой отказ окончательным, и отзыв
# теряется молча (`handleFeedbackPostJob`). Поэтому до записи проверяется ровно то, на чём он
# ломается:
#   1. токен принят и видит репозиторий;
#   2. репозиторий ПРИВАТНЫЙ — в отзывы уходят назначение платежа, контрагент, суммы, а по галке
#      файл выписки целиком;
#   3. токен может ЗАВОДИТЬ задачи — настоящей задачей, которую скрипт тут же закрывает. Права
#      токена иначе не узнать: чтение репозитория проходит и у токена без права записи.
#
# ⚠ Токен — только fine-grained (`github_pat_…`). Классический `ghp_…` выпускается на весь аккаунт,
# а лежит он в `.env` сервера, который ходит в интернет: радиус утечки обязан быть одним приватным
# репозиторием (docs/FEEDBACK.md). Что у fine-grained токена доступ ровно к одному репозиторию,
# отсюда не проверить — это на совести выпускающего; проверяется то, что проверяемо.
#
# ⚠ Токен вводится с клавиатуры: аргумент и переменная перед make оседают в истории оболочки, а
# аргумент ещё и виден в `ps`. В `curl` он тоже не уходит аргументом — заголовок идёт конфигом через
# stdin (`-K -`), как в prod-alfa-page-probe.sh: аргументы видны любому процессу через
# /proc/<pid>/cmdline.
#
# ⚠ Серверу КЛИЕНТА — свой репозиторий-приёмник и свой токен. Право писать задачи у GitHub
# включает право их читать, и общий токен на чужом сервере читал бы отзывы всех остальных.
#
# Использование (из каталога со стеком; обычно через `make feedback-on`):
#   bash prod-feedback-on.sh                              # репозиторий bx-shef/client-bank-feedback
#   REPO=bx-shef/client-bank-feedback-x bash prod-feedback-on.sh
#   bash prod-feedback-on.sh --verify "docker compose"    # после перезапуска: дошло ли до контейнеров

set -u

DEFAULT_REPO="bx-shef/client-bank-feedback"

# ── Чистые функции (их грузит tests/prodFeedbackOn.test.ts через sed-вырезку) ──────────────────

# Тот же разбор `.env`, что у `env-value` в Makefile и `envv` в prod-alfa-page-probe.sh: снимает
# `export`, хвостовой комментарий и обрамляющие кавычки, берёт ПЕРВОЕ вхождение.
envv() {
  sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=//p" ./.env 2>/dev/null \
    | head -1 \
    | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]][[:space:]]*#.*$//" -e "s/[[:space:]]*$//" \
          -e "s/^\"\(.*\)\"$/\1/" -e "s/^'\(.*\)'$/\1/"
}

# Вид «владелец/репозиторий» из символов, которые GitHub допускает в именах.
# ⚠ `..` отвергается отдельно: имя уходит в путь запроса, а curl схлопывает `/../` САМ, до отправки,
# то есть токен ушёл бы на другой адрес API.
# ⚠ Сверка — `[[ =~ ]]`, а НЕ grep: grep построчный, и значение с переводом строки проходило бы
# проверку своей первой строкой. А имя уходит и в конфиг curl, и в .env — там перевод строки
# начинает новую директиву (второй `url`, куда уехал бы тот же заголовок с токеном).
valid_repo() {
  local LC_ALL=C r="${1:-}"
  [[ "$r" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  case "$r" in *..*|*/.|./*) return 1;; esac
  return 0
}

# Вид токена: fine | classic | bad.
# ⚠ Алфавит проверяется ЯВНО, а не только префикс: токен уходит в строку конфига curl и в `.env`,
# и кавычка или перевод строки внутри значения меняли бы смысл обоих файлов. Сверка — `[[ =~ ]]`
# по той же причине, что в valid_repo: grep пропустил бы перевод строки.
token_kind() {
  local LC_ALL=C t="${1:-}"
  [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || { printf 'bad'; return; }
  case "$t" in
    github_pat_?????????????????????*) printf 'fine' ;;
    ghp_*|gho_*|ghu_*|ghs_*|ghr_*)      printf 'classic' ;;
    *)                                  printf 'bad' ;;
  esac
}

# Ответ на GET /repos/<repo> → ok | public | unauthorized | forbidden | notfound | unreachable | unexpected.
# ⚠ `ok` — только при ЯВНОМ `"private":true`. Нечитаемое тело не повод считать репозиторий
# приватным: цена ошибки в эту сторону — финансовые данные клиентов в публичных задачах.
repo_verdict() {
  local code="${1:-}" flat
  flat="$(printf '%s' "${2:-}" | tr -d ' \n\t\r')"
  case "$code" in
    200)
      case "$flat" in
        *'"private":true'*)  printf 'ok' ;;
        *'"private":false'*) printf 'public' ;;
        *)                   printf 'unexpected' ;;
      esac ;;
    401) printf 'unauthorized' ;;
    403) printf 'forbidden' ;;
    404) printf 'notfound' ;;
    ''|000) printf 'unreachable' ;;
    *) printf 'unexpected' ;;
  esac
}

# Ответ на POST /repos/<repo>/issues → ok | noperm | disabled | notfound | unreachable | unexpected.
issue_verdict() {
  case "${1:-}" in
    201) printf 'ok' ;;
    403) printf 'noperm' ;;
    410) printf 'disabled' ;;
    404) printf 'notfound' ;;
    ''|000) printf 'unreachable' ;;
    *) printf 'unexpected' ;;
  esac
}

# Номер задачи из тела ответа GitHub (первое поле `"number"`).
issue_number() {
  printf '%s' "${1:-}" | tr -d ' \n\t\r' | grep -o '"number":[0-9][0-9]*' | head -1 | cut -d: -f2
}

# Тело проверочной задачи. Домен в текст — только из безопасного алфавита: он приходит из `.env`,
# а попадает внутрь JSON.
issue_json() {
  local host="${1:-}"
  [[ "$host" =~ ^[A-Za-z0-9.-]{1,253}$ ]] || host="сервер без DOMAIN в .env"
  printf '{"title":"Проверка канала обратной связи (make feedback-on)","body":"Задача заведена командой make feedback-on на %s при включении канала и сразу закрыта: так проверяется, что токен может заводить задачи. Делать ничего не нужно."}' "$host"
}

# Конфиг curl для одного запроса к GitHub. Токен живёт только в заголовке Authorization.
gh_config() {
  local method="$1" path="$2" token="$3" out="$4" data="${5:-}"
  printf 'url = "https://api.github.com%s"\n' "$path"
  printf 'request = "%s"\n' "$method"
  printf 'header = "Authorization: Bearer %s"\n' "$token"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  if [ -n "$data" ]; then
    printf 'header = "Content-Type: application/json"\n'
    printf 'data-binary = "@%s"\n' "$data"
  fi
  printf 'output = "%s"\n' "$out"
  printf 'write-out = "%%{http_code}"\n'
  printf 'silent\nshow-error\nmax-time = 20\n'
}

# Заменить в .env обе переменные канала: старые строки убрать, новые дописать в конец.
# ⚠ Через временный файл рядом и `mv`: оборванная посреди записи `sed -i` оставила бы .env без
# половины строк, а без него стек не поднимется вовсе.
rewrite_env() {
  local f="$1" repo="$2" token="$3" tmp
  tmp="$(mktemp "${f}.XXXXXX")" || return 1
  if ! sed -E '/^[[:space:]]*(export[[:space:]]+)?GITHUB_FEEDBACK_(TOKEN|REPO)[[:space:]]*=/d' "$f" > "$tmp"; then
    rm -f "$tmp"; return 1
  fi
  # ⚠ Последняя строка без перевода строки склеилась бы с первой добавленной.
  if [ -s "$tmp" ] && [ -n "$(tail -c1 "$tmp")" ]; then printf '\n' >> "$tmp"; fi
  printf 'GITHUB_FEEDBACK_REPO=%s\nGITHUB_FEEDBACK_TOKEN=%s\n' "$repo" "$token" >> "$tmp"
  chmod --reference="$f" "$tmp" 2>/dev/null || chmod 600 "$tmp"
  mv "$tmp" "$f"
}

# ── Проверка после перезапуска: дошло ли до контейнеров ─────────────────────────────────────────
# ⚠ Проверяются ОБА: backend принимает отзывы сотрудников, worker заводит задачи от программы.
# Включённый наполовину канал снаружи выглядит включённым.
verify() {
  local dc="${1:-docker compose}" out="" i tries="${VERIFY_TRIES:-30}" ok=""
  printf '\n── Проверка: дошло ли до контейнеров ──\n'
  for i in $(seq 1 "$tries"); do
    out="$($dc exec -T backend node -e \
      "fetch('http://127.0.0.1:3000/api/feedback').then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>process.exit(1))" \
      2>/dev/null)"
    [ -n "$out" ] && break
    sleep 2
  done
  case "$(printf '%s' "$out" | tr -d ' \n\t\r')" in
    *'"enabled":true'*)  echo "  ✓ backend: канал включён — виджет 👍/👎 появится на экранах приложения" ;;
    *'"enabled":false'*) echo "  ✗ backend: канал ВЫКЛЮЧЕН — переменные до контейнера не дошли"; return 1 ;;
    *)                   echo "  ✗ backend не ответил за минуту — смотрите make ps и make logs"; return 1 ;;
  esac
  # ⚠ Повтор и здесь: воркер пересоздаётся той же командой и может ещё подниматься.
  for i in $(seq 1 "$tries"); do
    if $dc exec -T worker sh -c '[ -n "$GITHUB_FEEDBACK_TOKEN" ] && [ -n "$GITHUB_FEEDBACK_REPO" ]' 2>/dev/null; then
      ok=1; break
    fi
    sleep 2
  done
  if [ -n "$ok" ]; then
    echo "  ✓ worker: переменные на месте — отзывы программы тоже заведутся"
  else
    echo "  ✗ worker: переменных нет — отзывы программы не заведутся"; return 1
  fi
  echo
  echo "Дальше: откройте «Загрузить выписку» в портале — виджет 👍/👎 должен быть виден; нажмите 👍,"
  echo "и в репозитории-приёмнике появится задача."
}

# ── Дальше — ввод-вывод ─────────────────────────────────────────────────────────────────────────

if [ "${1:-}" = "--verify" ]; then
  verify "${2:-docker compose}"
  exit $?
fi

[ -f ./.env ] || { echo "✗ ./.env не найден — запускайте из каталога со стеком"; exit 1; }

REPO="${REPO:-$DEFAULT_REPO}"
valid_repo "$REPO" || { echo "✗ REPO «$REPO» — нужен вид владелец/репозиторий"; exit 2; }

# ⚠ Сервер клиента узнаётся по копии КЛИЕНТСКОГО репозитория рядом со стеком (docs/DEPLOY_BITRIXVM.md,
# шаг 1b). Общий репозиторий-приёмник туда нельзя: токен с правом писать задачи читает их все, то
# есть отзывы остальных клиентов оказались бы на чужом сервере.
if [ -d ./src/.git ] && [ "$REPO" = "$DEFAULT_REPO" ]; then
  echo "✗ это сервер клиента — ему нужен СВОЙ приватный репозиторий-приёмник и свой токен:"
  echo "  токен с правом писать задачи читает их все, включая отзывы остальных клиентов."
  echo "  Заведите отдельный репозиторий и задайте его перед make:"
  echo "    REPO=$DEFAULT_REPO-имя make feedback-on"
  exit 2
fi

# ⚠ Без терминала токен пришлось бы подать через пайп или файл, то есть снова через историю.
[ -t 0 ] || { echo "✗ токен вводится с клавиатуры — запустите команду в терминале"; exit 2; }

echo "Репозиторий-приёмник: $REPO"
printf 'Токен GitHub (fine-grained, ввод не отображается): '
IFS= read -r -s TOKEN
echo

case "$(token_kind "$TOKEN")" in
  fine) ;;
  classic)
    echo "✗ это классический токен (ghp_…) — он действует на весь аккаунт."
    echo "  Нужен fine-grained токен ровно на $REPO с правом Issues: Read and write."
    exit 2 ;;
  *)
    echo "✗ не похоже на токен GitHub: ожидается github_pat_… (буквы, цифры, подчёркивание)."
    exit 2 ;;
esac

BODY_FILE="$(mktemp /tmp/feedback-on-body.XXXXXX)"
CURL_ERR="$(mktemp /tmp/feedback-on-err.XXXXXX)"
DATA_FILE="$(mktemp /tmp/feedback-on-data.XXXXXX)"
cleanup() { rm -f "$BODY_FILE" "$CURL_ERR" "$DATA_FILE"; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

# gh МЕТОД ПУТЬ [ФАЙЛ_JSON] → код ответа; тело — в $BODY_FILE.
gh() {
  : > "$BODY_FILE"
  gh_config "$1" "$2" "$TOKEN" "$BODY_FILE" "${3:-}" | curl -K - 2>"$CURL_ERR"
}

printf '\n── 1. Репозиторий ──\n'
CODE="$(gh GET "/repos/$REPO")"
case "$(repo_verdict "$CODE" "$(cat "$BODY_FILE")")" in
  ok) echo "  ✓ токен принят, репозиторий приватный" ;;
  public)
    echo "  ✗ репозиторий ПУБЛИЧНЫЙ — канал не включаю."
    echo "    В отзывы уходят назначение платежа, контрагент, суммы и по галке файл выписки."
    echo "    Сделайте репозиторий приватным (Settings → Danger Zone → Change visibility) и повторите."
    exit 1 ;;
  unauthorized) echo "  ✗ GitHub не принял токен — опечатка при вставке, отозван или истёк"; exit 1 ;;
  forbidden)
    echo "  ✗ GitHub отказал токену в доступе (403) — если репозиторий в организации, проверьте, что"
    echo "    организация разрешает fine-grained токены и одобрила этот"
    exit 1 ;;
  notfound)
    echo "  ✗ репозиторий $REPO не найден или токен его не видит —"
    echo "    при выпуске токена выберите именно этот репозиторий (Only select repositories)"
    exit 1 ;;
  unreachable)
    echo "  ✗ не достучался до api.github.com:"
    sed 's/^/    /' "$CURL_ERR" | head -3
    exit 1 ;;
  *) echo "  ✗ неожиданный ответ GitHub (код ${CODE:-нет}) — канал не включаю"; exit 1 ;;
esac

printf '\n── 2. Право заводить задачи ──\n'
issue_json "$(envv DOMAIN)" > "$DATA_FILE"
CODE="$(gh POST "/repos/$REPO/issues" "$DATA_FILE")"
case "$(issue_verdict "$CODE")" in
  ok)
    NUM="$(issue_number "$(cat "$BODY_FILE")")"
    echo "  ✓ проверочная задача заведена${NUM:+ (#$NUM)}"
    if [ -n "$NUM" ]; then
      printf '{"state":"closed","state_reason":"completed"}' > "$DATA_FILE"
      CLOSE="$(gh PATCH "/repos/$REPO/issues/$NUM" "$DATA_FILE")"
      if [ "$CLOSE" = "200" ]; then echo "  ✓ и закрыта"
      else echo "  ⚠ закрыть её не удалось (код ${CLOSE:-нет}) — закройте #$NUM руками, на канал это не влияет"; fi
    fi ;;
  noperm)
    echo "  ✗ у токена нет права заводить задачи — при выпуске дайте Issues: Read and write"
    exit 1 ;;
  disabled)
    echo "  ✗ в репозитории выключены задачи — включите: Settings → General → Features → Issues"
    exit 1 ;;
  notfound) echo "  ✗ GitHub не нашёл репозиторий при записи — токену не хватает доступа"; exit 1 ;;
  unreachable)
    echo "  ✗ не достучался до api.github.com:"
    sed 's/^/    /' "$CURL_ERR" | head -3
    exit 1 ;;
  *) echo "  ✗ неожиданный ответ GitHub на создание задачи (код ${CODE:-нет}) — канал не включаю"; exit 1 ;;
esac

printf '\n── 3. Запись в .env ──\n'
BACKUP=".env.bak.$(date +%Y%m%d%H%M%S)"
cp -p ./.env "$BACKUP" || { echo "  ✗ не смог сделать копию .env — ничего не меняю"; exit 1; }
rewrite_env ./.env "$REPO" "$TOKEN" || { echo "  ✗ не смог записать .env (копия: $BACKUP)"; exit 1; }
echo "  ✓ GITHUB_FEEDBACK_REPO=$REPO"
echo "  ✓ GITHUB_FEEDBACK_TOKEN записан (длина ${#TOKEN}), прежний .env — в $BACKUP"
