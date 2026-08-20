.PHONY: dev build-local prod-up prod-down prod-pull prod-redeploy logs ps doctor queue-stats \
        prior-probe prior-switch poll-check self-update help \
        gw-stop gw-start compose-update

# Обёртки над командами деплоя. Подробности — docs/DEPLOY.md.
# Прод-цели читают переменные из ./.env (DOMAIN, LETSENCRYPT_EMAIL — см. .env.example).

# ─── Локальная разработка ────────────────────────────────────────────

dev:
	pnpm dev

## Локальная сборка прод-образа и запуск на :8081 (проверка перед деплоем)
build-local:
	docker compose up --build

# ─── Прод (на сервере, /home/bitrix/bank-import) ─────────────────────
# Требует общий nginx-proxy + Watchtower на хосте (ставятся один раз вместе с
# currency-converter) и docker-сеть proxy-net. Свой Watchtower НЕ поднимаем —
# хостовый подхватывает контейнер по метке (см. docs/DEPLOY.md).

## Запустить / обновить app-контейнер
prod-up:
	docker compose -f docker-compose.prod.yml up -d

## Остановить стек
prod-down:
	docker compose -f docker-compose.prod.yml down

## Скачать свежий образ (без перезапуска контейнера)
prod-pull:
	docker compose -f docker-compose.prod.yml pull

## Принудительно обновить прямо сейчас (без ожидания Watchtower)
prod-redeploy:
	docker compose -f docker-compose.prod.yml pull && \
	docker compose -f docker-compose.prod.yml up -d && \
	docker image prune -f

## Живой лог app-контейнера (Ctrl+C чтобы выйти)
logs:
	docker compose -f docker-compose.prod.yml logs -f app

## Состояние контейнеров стека
ps:
	docker compose -f docker-compose.prod.yml ps

# ─── Диагностика на сервере ──────────────────────────────────────────
# ⚠ РЕПОЗИТОРИЯ НА СЕРВЕРЕ НЕТ — там только `docker-compose.prod.yml`, этот `Makefile` и `.env`
# (docs/OPERATIONS.md). Поэтому `bash scripts/…` на сервере физически не выполнить, и цели ниже
# скачивают скрипт по HTTPS во временный файл.
#
# ⚠ Скачиваем В ФАЙЛ, а не `curl | bash`: оборванная загрузка в пайпе выполняется кусками, и
# половина скрипта диагностики хуже, чем никакой.
#
# ⚠ Файл — от `mktemp`, а НЕ фиксированный `/tmp/prod-doctor.sh`. Предсказуемое имя в общем `/tmp`
# кто угодно может заранее подложить симлинком, и `curl -o` пройдёт по нему насквозь, перезаписав
# цель (проверено). `mktemp` создаёт файл атомарно, с `O_EXCL`. Заодно снимается вторая беда
# фиксированного имени: он оставался лежать, и набранный руками `bash /tmp/prod-doctor.sh` мог
# запустить прошлую версию — для инструмента, которому верят в аварию, это худший вид ошибки.
#
# ⚠ Шаги сцеплены `&&`, а не `;`. Каждую строку рецепта make проверяет на код возврата сам, но
# внутри ОДНОЙ строки эта защита не работает: с `;` упавший `curl` не помешал бы запустить пустой
# файл — то есть переход на `mktemp` без `&&` вернул бы ровно ту дыру, ради которой отвергнут
# `curl | bash`.
#
# ⚠ Почему НЕ `docker exec` в backend-контейнер, хотя версия скрипта совпала бы с развёрнутой:
# `prod-doctor.sh` зовут ровно тогда, когда стенд сломан, — в том числе когда backend не поднялся.
# Диагностика, которую нельзя запустить в аварию, бесполезна.
#
# ⚠ Берётся `main`, а НЕ то, что развёрнуто. Обычно это то же самое; когда важна точность, задайте
# ссылку явно: `make doctor REF=<коммит>`. Цель печатает, что именно скачала.
REF ?= main
# Умолчания параметров диагностических целей. ⚠ Именно `?=`: пустая строка, доехавшая до скрипта
# вместо значения, читается им как аргумент и ломает разбор — а выглядит это как ошибка скрипта.
SINCE ?= 3h
RAW = https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/$(REF)/scripts

# Прочитать ОДНО значение из ./.env, не исполняя файл.
#
# ⚠ Обычное `set -a; . ./.env` — это ЗАПУСК файла как скрипта, и на настоящем `.env` он ломается:
# `POSTGRES_PASSWORD=x y z` превращается в команду («./.env: y: not found»), значение с `$$(…)`
# исполняется, а переменные НИЖЕ сломанной строки просто не доезжают — то есть команда молча
# работает не с тем токеном. Проверено на файле с пробелом в пароле. Здесь берётся ровно одна
# строка `КЛЮЧ=значение`, ничего не выполняется, и лишнего в окружение не попадает.
#
# ⚠ Разбор держим НЕ УЖЕ формата, который тот же файл обязан поддерживать для `docker compose`
# (цели `prod-up`/`prod-pull` читают этот же `.env`). Иначе получается ловушка: `DOMAIN="x.by"`
# или комментарий в конце строки — для Compose это норма, а сюда доехало бы вместе с кавычками,
# и `prod-doctor.sh` объявил бы «ПЛОХО» по всем внешним проверкам живого сайта. Ложная тревога в
# аварию хуже отсутствия проверки. Поэтому: необязательный `export`, пробелы вокруг `=`, снятие
# ОБРАМЛЯЮЩЕЙ пары кавычек (а не всех подряд — `tr -d '"'` выел бы кавычки и из середины) и
# комментарий в конце строки.
#
# ⚠ Экзотику формата сюда всё равно не затащить, поэтому вторая линия обороны — цели ПЕЧАТАЮТ
# прочитанное. Разобранный неверно домен видно глазом сразу; это дешевле и надёжнее, чем гнаться
# за побайтовой совместимостью с парсером Compose.
#
# ⚠ При задвоенном ключе побеждает ПЕРВАЯ строка (`head -1`), тогда как `. ./.env` оставил бы
# последнюю. Расходится с привычкой — но эта форма не молчит: значение печатается.
#
# ⚠ Отдельного `tr -d '\r'` тут НЕТ и не нужно: `\r` из CRLF-файла стоит в конце строки, а
# `[[:space:]]` его включает — срез хвостовых пробелов уносит его сам. Стадия, которую нельзя
# уронить мутацией, выглядит как страховка, но проверить её нечем; поведение закреплено тестом
# (`tests/makefileEnvValue.test.ts`, случай CRLF), а не лишним звеном конвейера.
env-value = $$(sed -n "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$(1)[[:space:]]*=//p" ./.env 2>/dev/null \
	  | head -1 \
	  | sed -e "s/^[[:space:]]*//" -e "s/[[:space:]][[:space:]]*\#.*\$$//" -e "s/[[:space:]]*\$$//" \
	        -e "s/^\"\(.*\)\"\$$/\1/" -e "s/^'\(.*\)'\$$/\1/")

## Обновить САМ этот Makefile из репозитория (новые цели появляются только так)
#
# ⚠ Без этой цели остальные бесполезны. Репозитория на сервере нет, `Makefile` кладётся туда
# один раз при развёртывании и дальше живёт своей жизнью — поэтому цель, добавленная в репо,
# на сервере просто не существует, и оператору приходится набирать сырые `docker compose` и
# `curl … | bash`. Ровно это и происходило.
#
# ⚠ Скачанное проверяется по признаку, который есть в ЛЮБОЙ версии файла (`.PHONY` + давняя цель
# `prod-redeploy`), а не по свежей. Первая попытка проверяла `help` — цель, добавленную этой же
# правкой, — и bootstrap на живом сервере честно отказался: чтобы поставить новую цель, ему
# требовалась новая цель. Проверка обязана переживать любую версию, иначе она блокирует ровно то
# обновление, ради которого написана.
self-update:
	@t=$$(mktemp /tmp/Makefile.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/$(REF)/Makefile" \
	  && grep -q '^\.PHONY:' "$$t" \
	  && make -n -f "$$t" prod-redeploy >/dev/null 2>&1 \
	  && { b="./Makefile.bak-$$(date +%Y%m%d-%H%M%S)"; cp ./Makefile "$$b"; cp "$$t" ./Makefile; \
	       echo "[make] Makefile обновлён из $(REF), копия прежнего: $$b"; \
	       echo "[make] новые цели:"; make help; }

## Остановить крипто-шлюз (не нужен, пока Приор ходит напрямую на :9344)
#
# ⚠ Это ВРЕМЕННО: `prod-redeploy` поднимет его снова, пока сервис не закомментирован в
# `docker-compose.prod.yml`. Насовсем — `make compose-update` (в репозитории он выключен по
# умолчанию) либо закомментировать вручную. Цель нужна ровно для «выключить прямо сейчас».
gw-stop:
	@docker compose -f docker-compose.prod.yml stop crypto-gw \
	  && echo "[make] crypto-gw остановлен. ⚠ prod-redeploy поднимет его снова — см. compose-update"

## Поднять крипто-шлюз обратно (понадобится при сертификации СКЗИ)
gw-start:
	@docker compose -f docker-compose.prod.yml up -d crypto-gw \
	  && echo "[make] crypto-gw поднят. Переключить банк обратно: make prior-switch TO=gateway"

## Обновить docker-compose.prod.yml из репозитория (ЗАТРЁТ локальные правки — сперва покажет их)
#
#   make compose-update              # только показать, что изменится
#   make compose-update CONFIRM=1    # применить
#
# ⚠ Файл на сервере правят руками (так включали крипто-шлюз), поэтому слепая замена уничтожила бы
# настройку, о которой никто не помнит. Отсюда два шага и обязательный CONFIRM.
compose-update:
	@t=$$(mktemp /tmp/compose.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/$(REF)/docker-compose.prod.yml" \
	  && docker compose -f "$$t" config -q \
	  && { echo "[make] отличия текущего файла от $(REF) (- сервер, + репозиторий):"; \
	       diff -u ./docker-compose.prod.yml "$$t" | sed -n '3,80p' || true; \
	       if [ "$(CONFIRM)" = "1" ]; then \
	         b="./docker-compose.prod.yml.bak-$$(date +%Y%m%d-%H%M%S)"; cp ./docker-compose.prod.yml "$$b"; \
	         cp "$$t" ./docker-compose.prod.yml; \
	         echo "[make] заменён, копия прежнего: $$b. Применить: make prod-redeploy"; \
	       else echo "[make] это был показ. Применить: make compose-update CONFIRM=1"; fi; }

## Список целей с описаниями
#
# ⚠ Запоминает ПОСЛЕДНЮЮ строку `##` и печатает её у ближайшей следующей цели. Наивный
# `grep -B1` этого не умеет: у половины целей между описанием и самой целью лежит ещё
# несколько строк комментария, и они молча выпадали из списка — то есть справка врала о том,
# что вообще можно запустить.
help:
	@awk '/^## /{d=substr($$0,4)} \
	      /^[a-z][a-z-]*:/{if(d!=""){printf "  %-14s %s\n", substr($$1,1,length($$1)-1), d; d=""}}' \
	      $(MAKEFILE_LIST)

## Что происходит с опросом банков: успехи, падения, продление токенов (#522)
#
#   make poll-check            # за 3 часа
#   make poll-check SINCE=30m
poll-check:
	@t=$$(mktemp /tmp/poll-check.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/prod-poll-check.sh" \
	  && bash "$$t" "$(SINCE)"

## Переключить Приорбанк между прямым адресом и крипто-шлюзом (#522)
#
#   make prior-switch TO=direct     # напрямую, без белорусской криптографии
#   make prior-switch TO=gateway    # обратно через crypto-gw
#   make prior-switch               # только показать текущее состояние
prior-switch:
	@t=$$(mktemp /tmp/prior-switch.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/prior-switch-host.sh" \
	  && { a="--show"; [ "$(TO)" = "direct" ] && a="--to-direct"; \
	       [ "$(TO)" = "gateway" ] && a="--to-gateway"; bash "$$t" $$a; }

#
# ⚠ Домен НЕ спрашиваем — читаем `DOMAIN` из `./.env`, который на сервере и так рядом. Аварийную
# команду набирают с телефона, и подстановка домена руками означает опечатку в самый неудобный
# момент; переопределить всё равно можно — `make doctor DOMAIN=example.by` перекрывает `.env`.
## Проба хоста Приорбанка: принимает ли он серверные вызовы боевыми ключами (#522)
#
#   make prior-probe                       # проба https://api.priorbank.by:9344
#   make prior-probe HOST=https://хост:порт
#   make prior-probe CONSENT=1             # + создать пробное согласие (ЗАПИСЬ в банк)
#
# Креды берутся из ./.env и в вывод не попадают. Нужны только curl и openssl.
prior-probe:
	@echo "[make] скачиваю prior-host-probe.sh из $(REF)"
	@t=$$(mktemp /tmp/prior-probe.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/prior-host-probe.sh" \
	  && { h="$(HOST)"; [ -n "$$h" ] || h="https://api.priorbank.by:9344"; \
	       c=""; [ "$(CONSENT)" = "1" ] && c="--with-consent"; \
	       bash "$$t" "$$h" $$c; }

## Диагностика боевого стенда одним прогоном: `make doctor` (домен берётся из ./.env)
doctor:
	@echo "[make] скачиваю prod-doctor.sh из $(REF)"
	@t=$$(mktemp /tmp/prod-doctor.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/prod-doctor.sh" \
	  && { d="$(DOMAIN)"; [ -n "$$d" ] || d="$(call env-value,DOMAIN)"; \
	       echo "[make] домен: $${d:-<не задан, внешние проверки пропущу>}"; bash "$$t" "$$d"; }

## Счётчики очередей из работающего backend. Нужен B24_APPLICATION_TOKEN (берётся из ./.env)
#
# ⚠ Токен НЕ принимается из командной строки (в отличие от `DOMAIN` у `doctor`) — намеренно:
# `make queue-stats B24_APPLICATION_TOKEN=…` уехал бы в history оболочки и в `ps`. Единственный
# источник — `./.env`, он на сервере и так рядом. Не «чинить» эту асимметрию.
#
# ⚠ Печатается ДЛИНА, а не токен: значение показывать нельзя, но убедиться, что он вообще
# прочитался (и что его не порезал разбор `.env`), надо — иначе 403 от backend читается как
# «токен неверный», хотя на деле его тут просто не нашли.
queue-stats:
	@echo "[make] скачиваю queue-stats.sh из $(REF)"
	@t=$$(mktemp /tmp/queue-stats.XXXXXX) && trap 'rm -f "$$t"' EXIT \
	  && curl -fsSL -o "$$t" "$(RAW)/queue-stats.sh" \
	  && { tok="$(call env-value,B24_APPLICATION_TOKEN)"; \
	       echo "[make] B24_APPLICATION_TOKEN из ./.env: длина $${#tok}"; \
	       B24_APPLICATION_TOKEN="$$tok" bash "$$t" docker-compose.prod.yml; }
