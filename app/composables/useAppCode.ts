import { LANDING_MARKET_CODE } from '~/utils/landing'
import { pickAppCode } from '~/utils/appUriLink'

/**
 * Код приложения НА ПОРТАЛЕ — то, чем Bitrix24 его адресует: `/marketplace/view/<код>/` для ссылки
 * на экраны (#19) и `MODULE_ID` канала pull-синхронизации настроек.
 *
 * Источник — конфигурация сборки (`NUXT_PUBLIC_B24_APP_CODE`), а не ответ портала: у тиражного
 * приложения это символьный код Маркета, у локального — `client_id`, и знать его может только тот,
 * кто эту установку заводил. Порядок кандидатов и почему не `app.info` — в `pickAppCode`.
 *
 * ⚠ `b24MarketCode` стоит ВТОРЫМ, а не первым: у нашего опубликованного приложения оба кода
 * совпадают, поэтому портал, настроивший только его, ссылку получает рабочую и сегодняшнее
 * поведение не меняется. Но вопросы это РАЗНЫЕ — «как портал зовёт приложение» против «какой у нас
 * листинг в Маркете», — и у клона на своём сервере второго ответа не существует вовсе.
 *
 * ⚠ BUILD-TIME. Статика собирается `nuxt generate`, значит переменная обязана быть в окружении
 * СБОРКИ (build-arg Dockerfile/CI), а не в `.env` на сервере. Гард — `tests/publicEnvBuildArgs.test.ts`.
 */
export function useAppCode(): string | null {
  const cfg = useRuntimeConfig().public
  return pickAppCode([String(cfg.b24AppCode || ''), String(cfg.b24MarketCode || ''), LANDING_MARKET_CODE])
}
