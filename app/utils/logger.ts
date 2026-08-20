import { LogLevel, LoggerFactory, type LoggerInterface } from '@bitrix24/b24jssdk'

/**
 * Логгер приложения поверх jssdk. Один вход на все клиентские модули.
 *
 * ЗАЧЕМ. Было россыпью `if (import.meta.dev) console.warn('[app] …')`: уровень выбирался тем,
 * какой `console.*` вспомнил автор, «показывать ли в проде» решалось руками в каждой точке, а
 * префикс `[app]` набирался строкой и разъезжался. SDK даёт это конструкцией: канал, уровни с
 * фильтрацией, обработчики и — важное для наших fire-and-forget путей — **изоляцию: `log()`
 * никогда не бросает и не отдаёт rejected promise**.
 *
 * ⚠ `LoggerBrowser`, который выдаёт поиск первым, помечен в SDK `@deprecate` — вход через
 * `LoggerFactory`. Документация:
 * https://bitrix24.github.io/b24jssdk/docs/working-with-the-rest-api/logger/
 *
 * ⚠ КАНАЛ — не украшение. Имена совпадают с префиксами, которые уже сложились в логах (`app`,
 * `install`, `settings`, `import`), потому что по ним ищут: и глазами в консоли портала, и
 * `docker logs | grep` на сервере. Переименовать «покрасивее» значит молча сломать поиск.
 *
 * ⚠ В ПРОДЕ уровень задан ЯВНО — WARNING. Дефолт фабрики другой: `createForBrowser(channel, false)`
 * ставит ERROR (замерено), и предупреждения «триггер не зарегистрировался», «бот не завёлся» молча
 * пропали бы именно там, где нужны, — портал считался бы установленным нормально, а половина
 * функций не работала бы. Поэтому берём `createForBrowserProduction(channel, LogLevel.WARNING)`,
 * а не универсальный `createForBrowser`: третий аргумент он игнорирует (сигнатура на один параметр).
 *
 * ⚠ У логгера метод **`warning`**, а не `warn` (PSR-3). `logger.warn()` — `undefined is not a
 * function` в рантайме, причём на пути, где уже что-то сломалось. Ловится типами: возвращаем
 * типизированный `LoggerInterface`, а не `any`.
 */
const devMode = !!import.meta.dev

/**
 * Каналы, которым и в проде разрешён `info`.
 *
 * ⚠ Исключение, а не послабление: `slider` описывает разговор с ПОРТАЛОМ — что мы отправили и что
 * фрейм получил в ответ. Это единственные две строки, по которым отличимо «мы не передали
 * параметр» от «портал его не донёс», а воспроизвести разговор больше нечем: фрейм живёт у
 * клиента, второй попытки на том же открытии не бывает. Пока вопрос открыт (#537), обе стороны
 * обязаны быть видны в проде; закроем — строку отправки убрать, канал вернуть к WARNING.
 */
const VERBOSE_CHANNELS = new Set(['slider'])

/** Кэш по каналу: логгер создаётся один раз на модуль, а не на каждый вызов. */
const cache = new Map<string, LoggerInterface>()

/**
 * Логгер канала. Канал — короткое имя модуля (`app`, `install`, `settings`, `import`).
 *
 * В dev — DEBUG со всей отладкой; в проде — WARNING и выше.
 */
export function useLogger(channel: string): LoggerInterface {
  const cached = cache.get(channel)
  if (cached) return cached
  const prodLevel = VERBOSE_CHANNELS.has(channel) ? LogLevel.INFO : LogLevel.WARNING
  const logger = devMode
    ? LoggerFactory.createForBrowserDevelopment(channel)
    : LoggerFactory.createForBrowserProduction(channel, prodLevel)
  cache.set(channel, logger)
  return logger
}
