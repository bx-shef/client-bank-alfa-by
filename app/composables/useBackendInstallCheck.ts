import { frameAuth, frameAuthHeaders as authHeaders } from '~/composables/useFrameAuth'
import { mapProbeStatus, type BackendState } from '~/utils/installVerdict'

// Увидела ли серверная часть наш портал (#413).
//
// Зачем: событие `ONAPPINSTALL` доставляется НЕ через iframe, а исходящим вебхуком портала на наш
// backend — именно оно приносит `application_token` и OAuth-креды. Если backend в этот момент лежал
// или событие не дошло, портал считается установленным, а серверная часть о нём не знает: ни
// опроса, ни записи в CRM. Снаружи это выглядит как полностью успешная установка.
//
// Проверяем ЧУЖИМ маршрутом намеренно: `/api/setup-status` отвечает 409 «portal not installed
// (no key)», когда для этого домена нет строки портала, — то есть даёт нужный симптом без нового
// эндпоинта. ⚠ 409 не равен строго «событие не дошло»: он же возникает при несовпадении домена
// (алиас, self-hosted, смена адреса) и при подавленном тумбстоуном stale-register (#77). Поэтому
// вердикт по нему — мягкий («пока не подтверждено»), а не приказ переустановить.

// Сколько ждать. Токен пишет НЕ роут вебхука, а фоновый воркер: событие → проверка гранта сетевым
// OAuth-рефрешем → очередь → воркер → INSERT. Три секунды на всю эту цепочку — рулетка, и на
// занятой очереди здоровая установка получала бы ложную тревогу. Нарастающие паузы дают ~16с при
// почти бесплатном счастливом пути (первый же ответ 200 выходит сразу).
const DELAYS_MS = [1000, 2000, 3000, 4000, 6000] as const

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/** Прочитать статус один раз. Отдаёт HTTP-код или 0, если запрос вообще не дошёл. */
async function probeOnce(headers: Record<string, string>): Promise<number> {
  try {
    // retry: 0 — ofetch по умолчанию сам ретраит 409/5xx, то есть удваивал бы число запросов и
    // ломал заявленный тайминг. Повторами управляем здесь, явно.
    await $fetch('/api/setup-status', { headers, retry: 0 })
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

  let state: BackendState = 'unknown'
  for (let attempt = 0; attempt <= DELAYS_MS.length; attempt++) {
    state = mapProbeStatus(await probeOnce(headers))
    if (state === 'ok') return 'ok'
    const pause = DELAYS_MS[attempt]
    if (pause !== undefined) await sleep(pause)
  }
  return state
}
