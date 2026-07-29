import { frameAuth, frameAuthHeaders as authHeaders } from '~/composables/useFrameAuth'
import type { BackendState } from '~/utils/installVerdict'

// Увидела ли серверная часть наш портал (#413).
//
// Зачем: событие `ONAPPINSTALL` доставляется НЕ через iframe, а исходящим вебхуком портала на наш
// backend — именно оно приносит `application_token` и OAuth-креды. Если backend в этот момент лежал
// или событие не дошло, портал считается установленным, а серверная часть о нём не знает: ни
// опроса, ни записи в CRM. Снаружи это выглядит как полностью успешная установка.
//
// Проверяем ЧУЖИМ маршрутом намеренно: `/api/setup-status` уже отвечает 409 «portal not installed
// (no key)» ровно тогда, когда токенов портала нет, — то есть даёт искомый ответ без нового
// эндпоинта. 200 (и 403 «не админ») означают, что портал backend'у известен.

/** Сколько раз перепроверить и с какой паузой. Доставка события асинхронна и идёт параллельно с
 *  `installFinish`, поэтому мгновенный приговор давал бы ложную тревогу на здоровой установке. */
const ATTEMPTS = 3
const DELAY_MS = 1500

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Прочитать статус один раз. Отдаёт HTTP-код или 0, если запрос вообще не дошёл. */
async function probeOnce(headers: Record<string, string>): Promise<number> {
  try {
    await $fetch('/api/setup-status', { headers })
    return 200
  } catch (e) {
    const status = (e as { status?: number, statusCode?: number })?.status
      ?? (e as { statusCode?: number })?.statusCode
    return typeof status === 'number' ? status : 0
  }
}

/**
 * Дождаться, пока backend увидит портал. Возвращает `unknown` вне фрейма — там проверять нечего и
 * пугать не за что.
 */
export async function checkBackendKnowsPortal(): Promise<BackendState> {
  const a = frameAuth()
  if (!a) return 'unknown'
  const headers = authHeaders(a)

  let last = 0
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    last = await probeOnce(headers)
    // 200 — портал известен; 403 — известен, но мы не админ (для #413 это тоже «увидел»).
    if (last === 200 || last === 403) return 'ok'
    if (attempt < ATTEMPTS) await sleep(DELAY_MS)
  }

  // 409 — роут ответил и честно сказал, что токенов портала нет: событие не дошло.
  if (last === 409) return 'portal-missing'
  // 0 / 5xx — сам backend недоступен: это проблема владельца приложения, не портала.
  if (last === 0 || last >= 500) return 'down'
  // Что-то иное (400/401/…) — судить не берёмся, лучше промолчать, чем soврать.
  return 'unknown'
}
