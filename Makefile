.PHONY: dev build-local prod-up prod-down prod-pull prod-redeploy logs ps

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
