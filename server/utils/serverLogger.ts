import {
  LogLevel,
  Logger,
  StreamHandler,
  type Formatter,
  type LogRecord,
  type LoggerInterface
} from '@bitrix24/b24jssdk'

/**
 * Серверный логгер поверх jssdk. Один вход на весь `server/**` (#529).
 *
 * ЗАЧЕМ. Было ~100 вызовов `console.*`: «уровень» выбирался тем, какой метод вспомнил автор,
 * префикс канала набирался строкой в каждой точке, а маскировку ПДн надо было помнить руками.
 * SDK даёт это конструкцией: канал, уровни с фильтрацией, обработчики, процессоры и — важное для
 * fire-and-forget путей воркера — **изоляцию: `log()` никогда не бросает и не отдаёт rejected
 * promise**, то есть падение в логировании больше не может уронить обработку платежа.
 * Документация: https://bitrix24.github.io/b24jssdk/docs/working-with-the-rest-api/logger/
 *
 * ⚠ **ТРИ РЕШЕНИЯ, каждое из которых легко принять неправильно.**
 *
 * 1. **Уровень в проде — INFO, а не ERROR.** Дефолт фабрики SDK — ERROR, и он тут был бы прямым
 *    вредом: `OPERATIONS.md` велит оператору читать `[fetch]` и итог `[crm-sync]`, а это
 *    ИНФОРМАЦИОННЫЕ строки. «В проде только ошибки» унесло бы диагностику целиком — ровно ту, ради
 *    которой рантбук и написан.
 *
 * 2. **Имена каналов = уже сложившиеся маркеры** (`[op]`, `[queue]`, `[env]`, `[auth]`, `[fetch]`,
 *    `[crm-sync]`…). По ним ищут: `docker logs | grep`, рантбук и `scripts/prod-doctor.sh`
 *    (он грепает `\[env\]|\[auth\]|\[queue-job-failed\].*FINAL`). Переименование «покрасивее»
 *    молча ломает и то, и другое, поэтому набор каналов — закрытый список ниже, а его совпадение
 *    с рантбуком стережёт `tests/serverLogChannels.test.ts`.
 *    ⚠ Формат строки выбран НЕ по вкусу: у `LineFormatter` дефолт — `[{channel}] {levelName}: …`,
 *    то есть маркер остаётся в квадратных скобках в начале строки и старые grep'ы продолжают
 *    работать. С `JsonFormatter` маркер стал бы `"channel":"op"` — все они сломались бы разом,
 *    поэтому JSON включается ОТДЕЛЬНЫМ флагом и по осознанному решению оператора.
 *
 * 3. **`TelegramHandler` из SDK НЕ заменяет `telegramAlert.ts`.** У нашего — эпизоды, дедуп,
 *    переобъявление и гарантия, что токен бота не попадёт ни в лог, ни в текст ошибки, ни в
 *    возвращаемое значение (он в URL каждого вызова). У SDK-шного — сырая отправка. Подключать
 *    его сюда нельзя.
 */

/**
 * Каналы сервера — ЗАКРЫТЫЙ список. Это не перечисление ради порядка: каждое имя уже живёт в
 * рантбуке и/или в `prod-doctor.sh` как строка поиска, и завести канал мимо этого списка значит
 * написать в лог маркер, которого никто не ищет.
 */
export const SERVER_LOG_CHANNELS = [
  'activity',
  'allocate',
  // ⚠ `auth` — ТОЛЬКО про вход оператора (`authGuard`). `prod-doctor.sh` грепает его как ЖАЛОБУ и
  // считает в FAILED, поэтому подмешивать сюда штатные предупреждения продления портального токена
  // нельзя: доктор, зовущийся в аварию, начал бы ругаться на норме (найдено ревью #529). Для них —
  // отдельный канал `token`.
  'auth',
  'b24-events',
  'bank-connect',
  'bank-keepalive',
  'chat',
  'crm-sync',
  'deletion',
  'enc-key',
  'env',
  'fetch',
  'import',
  'migrate',
  'op',
  'pg',
  'queue',
  'queue-alert',
  // ⚠ `queue-job-failed`/`queue-job-retry`/`queue-worker-error` каналами НЕ являются, хотя рантбук
  // грепает их как маркеры: их печатает `workerObservability` ВНУТРИ текста сообщения, потому что
  // тег выбирается по исходу (final/retry) в момент падения. Завести их каналами значило бы
  // разложить один и тот же смысл по трём логгерам и потерять причину выбора.
  'recognize',
  'resolve',
  'retention',
  'stage',
  'token',
  'trigger'
] as const

export type ServerLogChannel = typeof SERVER_LOG_CHANNELS[number]

/** Уровень из env; неизвестное значение — INFO, а не тишина. */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  switch ((raw ?? '').trim().toUpperCase()) {
    case 'DEBUG': return LogLevel.DEBUG
    case 'NOTICE': return LogLevel.NOTICE
    case 'WARNING': return LogLevel.WARNING
    case 'ERROR': return LogLevel.ERROR
    // ⚠ Умолчание и фолбэк — ОДИН И ТОТ ЖЕ INFO. Опечатка в `LOG_LEVEL` не должна выключать
    // диагностику: тихий уход в ERROR был бы худшим исходом — рантбук перестал бы работать, а
    // причину («опечатались в переменной») никто бы не связал с пропавшими строками.
    default: return LogLevel.INFO
  }
}

/**
 * Формат строки. Свой, а не готовый `LineFormatter`, по ДВУМ причинам, и первая — не про объём.
 *
 * ⚠ **`LineFormatter` ПОРТИТ сообщение, если в нём есть `$&`, `` $` ``, `$'` или `$1`.** Он
 * подставляет значения через `String.replace` со СТРОКОВЫМ replacement, а там эти
 * последовательности — управляющие. Замерено: сообщение «банк ответил: $& и $` » вышло как
 * «банк ответил: {message} и [fetch] ERROR: ». Для нас это не теория: в сообщения идут ответы
 * банка и Bitrix24 (`describeUpstreamError`, `(e as Error).message`), то есть текст, который
 * пишем не мы. Шаблонная строка ниже такого класса ошибок не имеет вовсе.
 *
 * ⚠ Вторая причина — объём. Дефолт SDK добавляет хвост `{} {} 2026-08-21 07:02:10`: ~26 лишних
 * байт в КАЖДОЙ строке, а объём логов у нас измерен (#498) — при «10 порталов × 100 оплат/мин»
 * история в ротации сжимается до часов. Дата вдобавок ДУБЛИРУЕТ метку времени, которую docker
 * `json-file` ставит сам. Поэтому: пустой контекст не печатаем, `extra` и дату — не печатаем
 * вовсе. ⚠ Честный итог по объёму: −26 Б за хвост, +6 Б за `INFO: ` — строка `[op]` стала
 * примерно на 20 Б короче прежней, а не «просто короче».
 *
 * ⚠ Что сохранено дословно: `[{channel}]` в начале строки. По нему грепают рантбук и
 * `prod-doctor.sh`, и это единственная часть формата, которую менять нельзя.
 */
export class ServerLineFormatter implements Formatter {
  format(record: LogRecord): string {
    const head = `[${record.channel}] ${record.levelName}: ${record.message}`
    // ⚠ Сегодня контекст не передаёт НИ ОДИН вызов (замерено ревью: 94 вызова, 0 со вторым
    // аргументом) — ветка держится под будущий структурный контекст, а не работает сейчас.
    // Пока это так, «структурные логи» из #529 считать сделанными нельзя.
    const ctx = record.context && Object.keys(record.context).length > 0
      ? ` ${JSON.stringify(record.context)}`
      : ''
    return head + ctx
  }
}

/** Кэш по каналу: логгер создаётся один раз на модуль, а не на каждый вызов. */
const cache = new Map<string, LoggerInterface>()

function build(channel: string): LoggerInterface {
  const logger = new Logger(channel)
  const level = resolveLogLevel(process.env.LOG_LEVEL)
  // ⚠ `process.stdout`, а не `stderr`: docker `json-file` собирает оба, но разделение потоков
  // ломает ПОРЯДОК строк в `docker logs` — а порядок здесь несущий, по нему читают, что за чем
  // случилось с платежом.
  const handler = new StreamHandler(level, { stream: process.stdout })
  // ⚠ Переключателя на JSON здесь НЕТ намеренно (ревью #529). `JsonFormatter` из SDK ломает все
  // существующие grep'ы (маркер `[op]` становится `"channel":"op"`) и при этом СЕГОДНЯ не даёт
  // взамен ничего: структурного контекста ни один вызов не передаёт, вся нагрузка остаётся
  // человеческой строкой внутри `message`, а рядом появляются пустые `context`/`extra` и ВТОРАЯ
  // метка времени. Переключатель, единственный наблюдаемый эффект которого — «поиск перестал
  // работать», это заряженная ловушка, а не гибкость. Заводить его вместе с настоящим контекстом.
  handler.setFormatter(new ServerLineFormatter())
  logger.pushHandler(handler)
  return logger
}

/**
 * Логгер канала. Канал — из {@link SERVER_LOG_CHANNELS}.
 *
 * ⚠ У логгера метод **`warning`**, а не `warn` (PSR-3): `logger.warn()` — это
 * `undefined is not a function` в рантайме, причём на пути, где уже что-то сломалось. Ловится
 * типами — возвращаем типизированный `LoggerInterface`, а не `any`.
 */
export function useServerLogger(channel: ServerLogChannel): LoggerInterface {
  const cached = cache.get(channel)
  if (cached) return cached
  const logger = isolate(build(channel))
  cache.set(channel, logger)
  return logger
}

/**
 * Проглотить отказ САМОГО логирования.
 *
 * ⚠ Это не перестраховка, и докстринг выше без неё был бы неточен. Проверено по исходникам SDK:
 * у `Logger.log` нет ни try/catch, ни `.catch` — изоляция сегодня держится ИСКЛЮЧИТЕЛЬНО на
 * внутреннем try внутри `StreamHandler.handle`, то есть на детали чужой реализации. А зовут нас
 * ~100 раз без `await`: добавь кто-нибудь процессор, второй обработчик или сломанный форматтер —
 * и бросок станет unhandled rejection, что при дефолтном Node роняет процесс воркера. Причём
 * ровно на пути, где уже что-то сломалось и строка нужнее всего (найдено ревью #529).
 */
function isolate(logger: LoggerInterface): LoggerInterface {
  const methods = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'] as const
  const safe = Object.create(logger) as Record<string, unknown>
  for (const name of methods) {
    const fn = (logger as unknown as Record<string, unknown>)[name]
    if (typeof fn !== 'function') continue
    safe[name] = (...args: unknown[]) => {
      try {
        return Promise.resolve((fn as (...a: unknown[]) => unknown).apply(logger, args)).catch(() => undefined)
      } catch {
        // Синхронный бросок (сломанный форматтер) — тот же исход: молчим, но живём.
        return Promise.resolve()
      }
    }
  }
  return safe as unknown as LoggerInterface
}
