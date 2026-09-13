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
 * ⚠ Запасной вариант ровно один — `LANDING_MARKET_CODE`, код НАШЕГО опубликованного приложения.
 * Отдельной переменной «код листинга в Маркете» нет (решение владельца, 2026-09-13): у клона
 * листинга не существует ни нашего, ни своего, поэтому вопрос «какой у нас листинг» имеет один
 * ответ — константу, из которой строится и публичный адрес карточки на лендинге.
 *
 * ⚠ BUILD-TIME. Статика собирается `nuxt generate`, значит переменная обязана быть в окружении
 * СБОРКИ (build-arg Dockerfile/CI), а не в `.env` на сервере. Гард — `tests/publicEnvBuildArgs.test.ts`.
 */
export function useAppCode(): string | null {
  const cfg = useRuntimeConfig().public
  return pickAppCode([String(cfg.b24AppCode || ''), LANDING_MARKET_CODE])
}
