.PHONY: dev build-local prod-up prod-down prod-pull prod-redeploy logs ps doctor queue-stats

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

logs:
	docker compose -f docker-compose.prod.yml logs -f app

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
# ⚠ Почему НЕ `docker exec` в backend-контейнер, хотя версия скрипта совпала бы с развёрнутой:
# `prod-doctor.sh` зовут ровно тогда, когда стенд сломан, — в том числе когда backend не поднялся.
# Диагностика, которую нельзя запустить в аварию, бесполезна.
#
# ⚠ Берётся `main`, а НЕ то, что развёрнуто. Обычно это то же самое; когда важна точность, задайте
# ссылку явно: `make doctor REF=<коммит>`. Цель печатает, что именно скачала.
REF ?= main
RAW = https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/$(REF)/scripts

# Прочитать ОДНО значение из ./.env, не исполняя файл.
#
# ⚠ Обычное `set -a; . ./.env` — это ЗАПУСК файла как скрипта, и на настоящем `.env` он ломается:
# `POSTGRES_PASSWORD=x y z` превращается в команду («./.env: y: not found»), значение с `$$(…)`
# исполняется, а переменные НИЖЕ сломанной строки просто не доезжают — то есть команда молча
# работает не с тем токеном. Проверено на файле с пробелом в пароле. Здесь берётся ровно одна
# строка `КЛЮЧ=значение`, ничего не выполняется, и лишнего в окружение не попадает.
env-value = $$(grep -m1 "^[[:space:]]*$(1)[[:space:]]*=" ./.env 2>/dev/null | cut -d= -f2- | tr -d '\r' | tr -d '"')

## Диагностика боевого стенда одним прогоном: `make doctor` (домен берётся из ./.env)
#
# ⚠ Домен НЕ спрашиваем — читаем `DOMAIN` из `./.env`, который на сервере и так рядом. Аварийную
# команду набирают с телефона, и подстановка домена руками означает опечатку в самый неудобный
# момент; переопределить всё равно можно — `make doctor DOMAIN=example.by` перекрывает `.env`.
doctor:
	@echo "[make] скачиваю prod-doctor.sh из $(REF)"
	@curl -fsSL -o /tmp/prod-doctor.sh "$(RAW)/prod-doctor.sh"
	@d="$(DOMAIN)"; [ -n "$$d" ] || d="$(call env-value,DOMAIN)"; \
	  bash /tmp/prod-doctor.sh "$$d"

## Счётчики очередей из работающего backend. Нужен B24_APPLICATION_TOKEN (берётся из ./.env)
queue-stats:
	@echo "[make] скачиваю queue-stats.sh из $(REF)"
	@curl -fsSL -o /tmp/queue-stats.sh "$(RAW)/queue-stats.sh"
	@B24_APPLICATION_TOKEN="$(call env-value,B24_APPLICATION_TOKEN)" \
	  bash /tmp/queue-stats.sh docker-compose.prod.yml
