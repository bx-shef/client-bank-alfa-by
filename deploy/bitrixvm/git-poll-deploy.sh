#!/usr/bin/env bash
# Обновление приложения на виртуальной машине Битрикс24 по ОПРОСУ git.
#
# Сервер сам раз в N минут спрашивает у git, не появился ли новый коммит в
# отслеживаемой ветке, и если появился — подтягивает образы ровно этого коммита и
# перезапускает стек. Ни входящих вебхуков, ни доступа снаружи: инициатива всегда
# на стороне сервера. Порядок работы и настройка — docs/DEPLOY_BITRIXVM.md.
#
# ⚠ Отслеживается git, а разворачиваются ОБРАЗЫ ПО ТЕГУ КОММИТА (`sha-<короткий>`,
# его пишет docker/metadata-action в CI). Не `:latest`. Разница принципиальная:
#   * `:latest` — движущаяся цель, и между `pull` образа лендинга и `pull` образа
#     backend она может сдвинуться: получим половину одной версии и половину другой;
#   * тег коммита не движется никогда, поэтому «развёрнут коммит X» — проверяемое
#     утверждение, а откат сводится к «развернуть предыдущий X».
#
# ⚠ Пока CI не закончил сборку, образов этого коммита в реестре ещё нет. Это НЕ
# ошибка: скрипт молча выходит и попробует на следующем тике. Иначе каждый push
# порождал бы тревогу, а операторы за неделю научились бы её игнорировать.

set -Eeuo pipefail

CONFIG="${BANK_APP_DEPLOY_CONFIG:-/etc/bank-app-deploy/deploy.env}"
STATE_DIR="${BANK_APP_DEPLOY_STATE:-/var/lib/bank-app-deploy}"
LOCK_FILE="$STATE_DIR/deploy.lock"

log() { printf '[deploy] %s\n' "$*"; }
die() { printf '[deploy] ОШИБКА: %s\n' "$*" >&2; exit 1; }

[ -r "$CONFIG" ] || die "нет файла настроек $CONFIG"
# shellcheck disable=SC1090
. "$CONFIG"

: "${GIT_URL:?в $CONFIG не задан GIT_URL}"
: "${GIT_BRANCH:=main}"
: "${STACK_DIR:?в $CONFIG не задан STACK_DIR (каталог с docker-compose и .env)}"
: "${IMAGE_APP:?в $CONFIG не задан IMAGE_APP (без тега)}"
: "${IMAGE_BACKEND:?в $CONFIG не задан IMAGE_BACKEND (без тега)}"
: "${HEALTH_URL:=http://127.0.0.1:8080/api/health}"
: "${READY_URL:=http://127.0.0.1:8080/api/ready}"
: "${SHA_TAG_LENGTH:=7}"

mkdir -p "$STATE_DIR"

# Все команды compose выполняются ИЗ каталога стека: оттуда же compose читает .env,
# в котором лежит COMPOSE_FILE с обоими файлами (базовым и оверлеем площадки).
# Запуск из другого каталога подхватил бы только базовый файл — то есть тихо
# развернул бы конфигурацию другой площадки.
cd "$STACK_DIR" || die "нет каталога стека $STACK_DIR"

# ⚠ Один запуск за раз. Тик таймера может наложиться на затянувшееся обновление
# (реестр отвечает медленно, миграция идёт), и два `compose up` одновременно
# перезапускают контейнеры друг у друга — стек остаётся в неизвестном состоянии.
# `-n` (не ждать) вместо ожидания: второму запуску нечего добавить, первый уже
# делает ту же работу.
exec 9>"$LOCK_FILE"
flock -n 9 || { log "обновление уже идёт, пропускаю тик"; exit 0; }

# ── Доступ к git ────────────────────────────────────────────────────────────
# Deploy key: ключ привязан к ОДНОМУ репозиторию, отзывается одним действием, и
# GitHub показывает дату последнего использования — это и есть аудит доступа.
# IdentitiesOnly=yes обязателен: без него ssh сперва переберёт ключи агента и
# может авторизоваться совсем не тем, что мы отзываем.
if [ -n "${GIT_SSH_KEY:-}" ]; then
  [ -r "$GIT_SSH_KEY" ] || die "ключ $GIT_SSH_KEY недоступен на чтение"
  export GIT_SSH_COMMAND="ssh -i $GIT_SSH_KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15"
fi

log "опрашиваю $GIT_URL ($GIT_BRANCH)"
remote_line="$(git ls-remote --exit-code "$GIT_URL" "refs/heads/$GIT_BRANCH" 2>&1)" \
  || die "не удалось опросить репозиторий: $remote_line"
remote_sha="${remote_line%%[[:space:]]*}"
[ ${#remote_sha} -eq 40 ] || die "неожиданный ответ git ls-remote: $remote_line"

deployed_sha=""
[ -r "$STATE_DIR/deployed_sha" ] && deployed_sha="$(cat "$STATE_DIR/deployed_sha")"

if [ "$remote_sha" = "$deployed_sha" ]; then
  log "изменений нет (${remote_sha:0:$SHA_TAG_LENGTH})"
  exit 0
fi

tag="sha-${remote_sha:0:$SHA_TAG_LENGTH}"
log "новый коммит ${remote_sha:0:$SHA_TAG_LENGTH} → тег образов $tag"

# ── Реестр ──────────────────────────────────────────────────────────────────
# Токен только на чтение пакетов; читается из файла, а не передаётся аргументом —
# аргументы видны в `ps` любому пользователю машины.
if [ -n "${REGISTRY_TOKEN_FILE:-}" ]; then
  [ -r "$REGISTRY_TOKEN_FILE" ] || die "токен реестра $REGISTRY_TOKEN_FILE недоступен"
  docker login "${REGISTRY_HOST:-ghcr.io}" -u "${REGISTRY_USER:?нужен REGISTRY_USER}" \
    --password-stdin < "$REGISTRY_TOKEN_FILE" >/dev/null \
    || die "не удалось войти в реестр ${REGISTRY_HOST:-ghcr.io}"
fi

# Тянем ОБА образа ДО перезапуска: если второй недокачался, стек ещё не тронут.
for image in "$IMAGE_APP:$tag" "$IMAGE_BACKEND:$tag"; do
  if ! docker pull --quiet "$image" >/dev/null 2>&1; then
    log "образа $image ещё нет — вероятно, CI не закончил сборку; попробую на следующем тике"
    exit 0
  fi
done

# ── Что развёрнуто сейчас (для отката) ──────────────────────────────────────
prev_app="$(docker inspect -f '{{.Image}}' "$(docker compose ps -q app 2>/dev/null || true)" 2>/dev/null || true)"
prev_backend="$(docker inspect -f '{{.Image}}' "$(docker compose ps -q backend 2>/dev/null || true)" 2>/dev/null || true)"
prev_sha="$deployed_sha"

apply() {
  local t="$1"
  # Тег коммита передаётся оверлеем окружения, а не правкой .env: правка файла
  # пережила бы откат и следующий ручной `up -d` поднял бы уже откатанную версию.
  APP_IMAGE="$IMAGE_APP:$t" BACKEND_IMAGE="$IMAGE_BACKEND:$t" \
    docker compose up -d --remove-orphans
}

healthy() {
  local i
  for i in $(seq 1 "${HEALTH_ATTEMPTS:-30}"); do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1 \
       && curl -fsS --max-time 10 "$READY_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep "${HEALTH_INTERVAL_SEC:-5}"
  done
  return 1
}

log "разворачиваю $tag"
if ! apply "$tag"; then
  die "compose up завершился ошибкой на $tag — стек мог остаться в смешанном состоянии, нужен человек"
fi

# ⚠ Проверяем ДВА адреса. /api/health отвечает «процесс жив» и остаётся зелёным при
# мёртвых Postgres и Redis; /api/ready реально прощупывает зависимости. Обновление,
# признанное успешным по одному только health, спрятало бы ровно те поломки, которые
# приносит новая версия: несовместимую миграцию и отвалившуюся очередь.
if healthy; then
  printf '%s\n' "$remote_sha" > "$STATE_DIR/deployed_sha"
  [ -n "$prev_sha" ] && printf '%s\n' "$prev_sha" > "$STATE_DIR/previous_sha"
  log "готово: развёрнут ${remote_sha:0:$SHA_TAG_LENGTH}"
  exit 0
fi

log "новая версия не прошла проверку здоровья — откатываюсь"
if [ -n "$prev_app" ] && [ -n "$prev_backend" ]; then
  # Возвращаемся на ТЕ ЖЕ образы по их идентификаторам, а не по тегу: тег к этому
  # моменту уже мог быть переписан, а идентификатор указывает ровно на то, что
  # работало минуту назад.
  APP_IMAGE="$prev_app" BACKEND_IMAGE="$prev_backend" \
    docker compose up -d --remove-orphans \
    && log "откат выполнен, работает прежняя версия" \
    || log "ОТКАТ НЕ УДАЛСЯ — требуется вмешательство"
else
  log "откатываться не на что (предыдущие образы не определены) — требуется вмешательство"
fi

# ⚠ Состояние НЕ обновляем: следующий тик попробует тот же коммит снова. Это
# осознанно — сломанную версию чинит новый коммит, и как только он появится,
# сервер подхватит его сам, без похода на сервер.
die "обновление до $tag откачено"
