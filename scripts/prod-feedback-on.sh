#!/usr/bin/env bash
# Enable the feedback channel on a server (#499): write the receiving repository and the token
# into ./.env — ONLY after checking that the channel actually works with them.
#
# ⚠ The checks before writing are the point, not politeness. The channel is fail-closed: with no
# variables the widget is hidden, and that is visible. With WRONG variables the channel looks
# enabled: the widget shows up, every employee report ends in «Не удалось отправить отзыв», and
# the program's own reports (the worker files them without looking at the result) are lost
# without a trace. So before writing we check exactly what breaks it:
#   1. the token is accepted and sees the repository;
#   2. the repository is PRIVATE (not public, not `internal`) and not archived — reports carry the
#      payment purpose, the counterparty, sums and, when the employee ticks the box, the whole
#      statement file;
#   3. the token can CREATE issues — with a real issue that is closed right away. There is no
#      other way to learn a token's rights: reading the repository works without write access.
# After the Makefile recreates the containers, `--verify` repeats the GitHub check from INSIDE
# both of them: the host reaching api.github.com proves nothing about the containers.
#
# ⚠ Fine-grained tokens only (`github_pat_…`). A classic `ghp_…` token covers the whole account,
# and it would live in the .env of a server that talks to the internet: the blast radius must be
# one private repository (docs/FEEDBACK.md). That a fine-grained token is limited to ONE
# repository cannot be checked from here — that is on whoever issues it.
#
# ⚠ The repository name and the token are typed at the keyboard: an argument or a variable
# before make ends up in the shell history, and an argument is also visible in `ps`. curl gets the
# token as a header through a config on stdin (`-K -`), never as an argument — arguments of any
# process are readable through /proc/<pid>/cmdline.
#
# ⚠ The name of the receiving repository is not in this file on purpose: this repository is
# public, and the real name stays out of it (docs/FEEDBACK.md).
#
# ⚠ A CLIENT's server needs its own receiving repository and its own token: a token that can
# create issues can also read them, so a shared token on someone else's server would read every
# other client's reports.
#
# Usage (from the stack directory; normally through `make feedback-on`):
#   bash prod-feedback-on.sh                              # asks for the repository and the token
#   bash prod-feedback-on.sh --verify "docker compose"    # after the restart: did it reach the containers

set -u

# ── Pure functions (tests/prodFeedbackOn.test.ts loads them with a sed range) ──────────────────

# Strip CR and surrounding whitespace: pasting from a phone brings them, and neither a repository
# name nor a token ever contains them.
trim() {
  local s="${1//$'\r'/}"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# `owner/repository` from the characters GitHub allows in names.
# ⚠ `..` is rejected separately: the name goes into the request path, and curl collapses `/../`
# ITSELF before sending, so the token would go to another API address.
# ⚠ Matched with `[[ =~ ]]`, NOT grep: grep works line by line, and a value with a newline would
# pass on its first line. The name goes into the curl config and into .env, where a newline starts
# a new directive (a second `url` receiving the same token header).
valid_repo() {
  local LC_ALL=C r="${1:-}"
  [[ "$r" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || return 1
  case "$r" in *..*|*/.|./*) return 1;; esac
  return 0
}

# Token kind: fine | classic | bad.
# ⚠ The alphabet is checked EXPLICITLY, not just the prefix: the token goes into a curl config line
# and into .env, and a quote or a newline inside it would change the meaning of both. `[[ =~ ]]`
# for the same reason as in valid_repo.
token_kind() {
  local LC_ALL=C t="${1:-}"
  [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || { printf 'bad'; return; }
  case "$t" in
    github_pat_?????????????????????*) printf 'fine' ;;
    ghp_*|gho_*|ghu_*|ghs_*|ghr_*)      printf 'classic' ;;
    *)                                  printf 'bad' ;;
  esac
}

# GET /repos/<repo> →
#   ok | public | internal | archived | unauthorized | forbidden | notfound | unreachable | unexpected.
# ⚠ `ok` only for an EXPLICIT `"private":true`. An unreadable body is no reason to call the
# repository private: the price of that mistake is clients' financial data in public issues.
# ⚠ The FIRST occurrence of each field is taken, not any: nested objects (`template_repository`,
# `parent`, `source`) carry their own copies, and a public repository created from a private
# template does contain `"private":true`. GitHub sends the top-level fields before the nested
# objects, and `owner`, which precedes them, has none of these fields.
# ⚠ `internal` repositories report `"private":true` too, yet every member of the enterprise reads
# them — hence the separate `visibility` check.
repo_verdict() {
  local code="${1:-}" flat priv vis arch
  flat="$(printf '%s' "${2:-}" | tr -d ' \n\t\r')"
  priv="$(printf '%s' "$flat" | grep -o '"private":[a-z]*' | head -1)"
  vis="$(printf '%s' "$flat" | grep -o '"visibility":"[a-z]*"' | head -1)"
  arch="$(printf '%s' "$flat" | grep -o '"archived":[a-z]*' | head -1)"
  case "$code" in
    200)
      if   [ "$priv" = '"private":false' ];           then printf 'public'
      elif [ "$priv" != '"private":true' ];           then printf 'unexpected'
      elif [ "$vis" = '"visibility":"internal"' ];    then printf 'internal'
      elif [ "$arch" = '"archived":true' ];           then printf 'archived'
      else printf 'ok'
      fi ;;
    401) printf 'unauthorized' ;;
    403) printf 'forbidden' ;;
    404) printf 'notfound' ;;
    ''|000) printf 'unreachable' ;;
    *) printf 'unexpected' ;;
  esac
}

# POST /repos/<repo>/issues → ok | noperm | disabled | notfound | unreachable | unexpected.
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

# Issue number from a GitHub response body (the first `"number"` field).
issue_number() {
  printf '%s' "${1:-}" | tr -d ' \n\t\r' | grep -o '"number":[0-9][0-9]*' | head -1 | cut -d: -f2
}

# Body of the test issue. Constant on purpose: nothing from .env goes into it.
issue_json() {
  printf '{"title":"Проверка канала обратной связи (make feedback-on)","body":"Задача заведена командой make feedback-on при включении канала и сразу закрыта: так проверяется, что токен может заводить задачи. Делать ничего не нужно."}'
}

# curl config for one GitHub request. The token lives only in the Authorization header.
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

# Replace both channel variables in .env: drop the old lines, append the new ones.
# ⚠ Through a temporary file next to it and `mv`: an interrupted `sed -i` could leave .env without
# half of its lines, and without it the stack does not start at all.
# ⚠ The OWNER is copied from the old file: run as root, a bitrix-owned .env would otherwise become
# root-only, and everything running as bitrix (make, the cron autodeploy) would lose it. The mode
# is always 600 — the file now holds one more secret, so it is never inherited wider.
# ⚠ The temporary file is published in ENV_TMP so the EXIT trap removes it if we are interrupted:
# it holds the new token.
ENV_TMP=""
rewrite_env() {
  local f="$1" repo="$2" token="$3" tmp
  tmp="$(mktemp "${f}.XXXXXX")" || return 1
  ENV_TMP="$tmp"
  if ! sed -E '/^[[:space:]]*(export[[:space:]]+)?GITHUB_FEEDBACK_(TOKEN|REPO)[[:space:]]*=/d' "$f" > "$tmp"; then
    rm -f "$tmp"; ENV_TMP=""; return 1
  fi
  # ⚠ A last line without a newline would be glued to the first appended one.
  if [ -s "$tmp" ] && [ -n "$(tail -c1 "$tmp")" ]; then printf '\n' >> "$tmp"; fi
  printf 'GITHUB_FEEDBACK_REPO=%s\nGITHUB_FEEDBACK_TOKEN=%s\n' "$repo" "$token" >> "$tmp"
  chown --reference="$f" "$tmp" 2>/dev/null \
    || echo "  ⚠ не удалось сохранить владельца .env — файл теперь принадлежит $(id -un); проверьте права" >&2
  if ! chmod 600 "$tmp" || ! mv "$tmp" "$f"; then
    rm -f "$tmp"; ENV_TMP=""; return 1
  fi
  ENV_TMP=""
}

# Code run by `node -e` INSIDE a container. The token stays in the container's environment: the
# code refers to process.env and never contains the value, so it is in no argv.
# ⚠ The output is searched for the PROBE line, never taken as a whole: the image preloads
# /app/otel.instrument.mjs through NODE_OPTIONS, and that prints its own banner to stdout on every
# start — «any output» would read as «the backend answered» while it is still starting.
# ⚠ Both requests are time-bounded: a backend that accepts the connection and never answers would
# otherwise hang the whole command without a word.
PROBE_JS="const s=AbortSignal.timeout(8000),e=process.env,tok=e.GITHUB_FEEDBACK_TOKEN||'',repo=e.GITHUB_FEEDBACK_REPO||'';
const h={Authorization:'Bearer '+tok,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'client-bank-alfa-feedback'};
Promise.all([
fetch('http://127.0.0.1:3000/api/feedback',{signal:s}).then(r=>r.text()).catch(()=>''),
tok&&repo?fetch('https://api.github.com/repos/'+repo,{headers:h,signal:s}).then(r=>String(r.status)).catch(()=>'000'):Promise.resolve('-')
]).then(([f,g])=>process.stdout.write('\nPROBE env='+(tok&&repo?'ok':'missing')+' github='+g+' feedback='+f.replace(/\s/g,'')+'\n'));"

# One field of a PROBE line: probe_field "<line>" github → 200.
probe_field() {
  printf '%s\n' "${1:-}" | tr ' ' '\n' | sed -n "s/^$2=//p" | head -1
}

# ── Check after the restart: did it reach the containers ────────────────────────────────────────
# ⚠ BOTH are checked: the backend takes employee reports, the worker files the program's. A
# half-enabled channel looks enabled from the outside.
verify() {
  local dc="${1:-docker compose}" svc out line i tries="${VERIFY_TRIES:-30}" rc=0 env gh fb
  printf '\n── Проверка: дошло ли до контейнеров ──\n'
  for svc in backend worker; do
    line=""
    for i in $(seq 1 "$tries"); do
      out="$($dc exec -T "$svc" node -e "$PROBE_JS" 2>/dev/null)"
      line="$(printf '%s\n' "$out" | grep '^PROBE ' | tail -1)"
      # The container is up when its own HTTP server answers: until then the process is starting.
      [ -n "$(probe_field "$line" feedback)" ] && break
      sleep 2
    done
    env="$(probe_field "$line" env)"; gh="$(probe_field "$line" github)"; fb="$(probe_field "$line" feedback)"
    if [ -z "$fb" ]; then
      echo "  ✗ $svc не ответил — смотрите make ps и make logs"; rc=1; continue
    fi
    if [ "$env" != "ok" ]; then
      echo "  ✗ $svc: переменных канала нет — до контейнера они не дошли"; rc=1; continue
    fi
    if [ "$svc" = backend ]; then
      case "$fb" in
        *'"enabled":true'*) ;;
        *) echo "  ✗ backend: канал выключен — переменные до контейнера не дошли"; rc=1; continue ;;
      esac
    fi
    if [ "$gh" != "200" ]; then
      echo "  ✗ $svc: GitHub из контейнера ответил ${gh:-нет ответа} (000 — нет связи) — отзывы из него не уйдут"
      rc=1; continue
    fi
    echo "  ✓ $svc: канал включён, GitHub из контейнера отвечает"
  done
  [ "$rc" -eq 0 ] || return 1
  echo
  echo "Дальше: откройте настройки приложения в портале — над кнопками «Сохранить»/«Отмена» будет"
  echo "виджет 👍/👎. Нажмите 👍, и в репозитории-приёмнике появится задача."
}

# ── Input and output from here on ──────────────────────────────────────────────────────────────

if [ "${1:-}" = "--verify" ]; then
  verify "${2:-docker compose}"
  exit $?
fi

[ -f ./.env ] || { echo "✗ ./.env не найден — запускайте из каталога со стеком"; exit 1; }

# ⚠ Without a terminal the token would have to come through a pipe or a file — the history again.
[ -t 0 ] || { echo "✗ репозиторий и токен вводятся с клавиатуры — запустите команду в терминале"; exit 2; }

# ⚠ A client's server is recognised by the copy of the CLIENT repository next to the stack
# (docs/DEPLOY_BITRIXVM.md, step 1b).
if [ -d ./src/.git ]; then
  echo "⚠ Это сервер клиента: нужен ОТДЕЛЬНЫЙ приватный репозиторий-приёмник под этого клиента"
  echo "  и токен только на него. Общий токен читал бы отзывы остальных клиентов."
  echo
fi

printf 'Репозиторий-приёмник (владелец/имя): '
IFS= read -r REPO
REPO="$(trim "$REPO")"
valid_repo "$REPO" || { echo "✗ нужен вид владелец/имя: латиница, цифры, «-», «_», «.»"; exit 2; }

printf 'Токен GitHub (fine-grained, ввод не отображается): '
IFS= read -r -s TOKEN
echo
TOKEN="$(trim "$TOKEN")"

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

BODY_FILE="$(mktemp /tmp/feedback-on-body.XXXXXX)" \
  && CURL_ERR="$(mktemp /tmp/feedback-on-err.XXXXXX)" \
  && DATA_FILE="$(mktemp /tmp/feedback-on-data.XXXXXX)" \
  || { echo "✗ не смог создать временные файлы в /tmp"; exit 1; }
cleanup() { rm -f "$BODY_FILE" "$CURL_ERR" "$DATA_FILE" ${ENV_TMP:+"$ENV_TMP"}; }
trap cleanup EXIT
trap 'cleanup; exit 130' INT TERM HUP

# gh METHOD PATH [JSON_FILE] → response code; the body goes to $BODY_FILE.
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
  internal)
    echo "  ✗ у репозитория видимость internal — его читают все участники enterprise. Нужен private."
    exit 1 ;;
  archived)
    echo "  ✗ репозиторий в архиве — задачи в нём не заводятся. Разархивируйте (Settings → Danger Zone)."
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
issue_json > "$DATA_FILE"
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
    echo "  ✗ GitHub отказал в создании задачи (403): у токена нет права Issues: Read and write,"
    echo "    либо сработал лимит GitHub — тогда повторите через несколько минут"
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
