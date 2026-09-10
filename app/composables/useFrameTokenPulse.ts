import { frameTokenDelayMs, frameTokenDue } from '~/utils/frameTokenPulse'
import { useLogger } from '~/utils/logger'

// Проводка продления токена фрейма. Правило «пора ли» и «когда проснуться» — чистое
// (`app/utils/frameTokenPulse.ts`), здесь только таймер, подписка на возврат вкладки и вызов SDK.
//
// ⚠ Принимаем НЕ `B24Frame`, а его `auth`, и по структурному типу. Две причины, и первая
// несущая: `useB24` запускает этот модуль, поэтому импорт `useB24` отсюда замкнул бы цикл.
// Вторая — проверяемость: подсунуть объект с двумя методами тест может, поднять `B24Frame` — нет.
//
// ⚠ Синглтон на страницу: `B24Frame` один на iframe, и второй таймер продлевал бы тот же токен
// вторым `postMessage` — лишняя ротация без единой выгоды.
//
// ⚠ НИКОГДА не бросает и ничего не чинит сама. Отказ продления означает, что портал не ответил
// (сессия закрыта, окно потеряно) — лечится перезагрузкой страницы человеком, а не нами. Наша
// задача — не дать токену умереть на исправной вкладке, и только.

/** Ровно то, что нам нужно от `AuthManager` SDK. */
export interface FrameAuthActions {
  getAuthData: () => false | { expires?: number }
  refreshAuth: () => Promise<{ expires?: number }>
}

let stopPulse: (() => void) | null = null

export function useFrameTokenPulse() {
  /** Запустить продление (идемпотентно). На сервере — no-op. */
  function start(auth: FrameAuthActions): void {
    if (stopPulse) return
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const log = useLogger('auth')

    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    async function tick(): Promise<void> {
      if (stopped) return
      // Срок неизвестен ⇒ минимальная пауза: так же поступаем и при отказе продления ниже.
      let delay = frameTokenDelayMs(undefined, Date.now())
      try {
        const data = auth.getAuthData()
        const expires = data === false ? undefined : data.expires
        if (frameTokenDue(expires, Date.now())) {
          const fresh = await auth.refreshAuth()
          log.info('frame token refreshed before expiry')
          delay = frameTokenDelayMs(fresh.expires, Date.now())
        } else {
          delay = frameTokenDelayMs(expires, Date.now())
        }
      } catch {
        // Портал не ответил — пробуем на следующем тике. Срок в этот момент неизвестен, поэтому
        // пауза остаётся минимальной.
      }
      if (!stopped) {
        timer = setTimeout(() => {
          void tick()
        }, delay)
      }
    }

    // ⚠ При возврате на вкладку проверяем НЕМЕДЛЕННО. Таймер в фоне задушен браузером и мог не
    // сработать ни разу — именно так вкладка и приходит с мёртвым токеном.
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      clearTimeout(timer)
      void tick()
    }
    document.addEventListener('visibilitychange', onVisible)

    stopPulse = () => {
      stopped = true
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      stopPulse = null
    }
    void tick()
  }

  /** Остановить продление (размонтирование фрейма, тесты). */
  function stop(): void {
    stopPulse?.()
  }

  return { start, stop }
}
