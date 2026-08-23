import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Manual «Опросить сейчас» (#54): trigger an on-demand bank poll of the portal's connected accounts
// from the in-portal admin UI. POSTs to /api/poll-now with the FRAME token (Bearer + X-B24-Domain) —
// the backend gates on the feature flag + admin + a per-portal cooldown, then enqueues the fetch
// jobs. Outside a portal frame there is no token → inert. Frame-auth helpers are shared (useFrameAuth),
// same as useBankConnect. UI показывает ответ сервера (кулдаун / поставлено N), а не прячет кнопку.

export interface PollNowResponse {
  enqueued?: number
  accounts?: number
  cooldownSec?: number
  /** День, за который ушла задача (эхо запроса) — интерфейс подтверждает выбор человеку. */
  day?: string
  error?: string
}

/** Сколько ждём появления итога прогона и как часто спрашиваем. */
const OUTCOME_TIMEOUT_MS = 90_000
const OUTCOME_STEP_MS = 3_000

export function useManualPoll() {
  const polling = ref(false)
  /** Итог ИМЕННО этого забора: null — ещё не дождались или ждать нечего. */
  const outcome = ref<string>('')
  const waiting = ref(false)
  const error = ref('')
  const message = ref('')
  /** True only in the in-portal frame (a token exists). Resolve on mount via syncEnabled(). */
  const enabled = ref(false)

  function syncEnabled(): void {
    enabled.value = frameAuth() !== null
  }

  /** Trigger the poll. `day` (`ГГГГ-ММ-ДД`) — точечный забор за один день (#592); пусто ⇒ обычное
   *  скользящее окно. Sets `message` on success, `error` on any failure. */
  async function poll(day = ''): Promise<void> {
    const a = frameAuth()
    enabled.value = a !== null
    error.value = ''
    message.value = ''
    if (!a) {
      error.value = 'Опрос доступен только внутри портала Bitrix24'
      return
    }
    polling.value = true
    outcome.value = ''
    // Метка последнего прогона ДО запуска — по её смене узнаём СВОЙ исход.
    let before: string | null = null
    try {
      const prev = await $fetch<{ lastSyncAt?: string | null }>('/api/import/status', { headers: authHeaders(a) })
      before = prev?.lastSyncAt ?? null
    } catch { /* нет статуса — сравнивать не с чем, но забор это не отменяет */ }
    try {
      const res = await $fetch<PollNowResponse>('/api/poll-now', {
        method: 'POST',
        headers: authHeaders(a),
        body: day ? { day } : {}
      })
      const n = res?.enqueued ?? 0
      const forDay = res?.day ? ` за ${res.day}` : ''
      message.value = n > 0
        ? `Опрос запущен${forDay}: счетов — ${res?.accounts ?? n}. Операции появятся в CRM через минуту-другую.`
        : 'Опрос запущен, но подключённых счетов нет — сначала подключите счёт.'
      if (n > 0) void awaitOutcome(a, before, day)
    } catch (e) {
      // Map the backend's typed rejections to friendly copy; fall back to the generic message.
      const status = (e as { statusCode?: number, status?: number })?.statusCode ?? (e as { status?: number })?.status
      // ⚠ 400 несёт ОСМЫСЛЕННЫЙ текст (день в будущем, кривая дата) — его и показываем, иначе
      // человек видел бы «не удалось запустить опрос» про собственную опечатку в календаре.
      const said = (e as { data?: { error?: unknown } })?.data?.error
      if (status === 400 && typeof said === 'string' && said) error.value = said
      else if (status === 429) error.value = 'Слишком часто — подождите немного и повторите.'
      // ⚠ 503 больше не значит «функция выключена» (свой выключатель снят 2026-08-23) — он значит
      // «очередь недоступна», то есть сбой на нашей стороне, и текст обязан вести к действию.
      else if (status === 503) error.value = 'Сервис обработки временно недоступен — повторите через пару минут.'
      else if (status === 403) error.value = 'Опрос может запустить только администратор портала.'
      else error.value = frameFetchError(e, 'Не удалось запустить опрос')
    } finally {
      polling.value = false
    }
  }

  /**
   * Дождаться итога запущенного прогона и рассказать о нём.
   *
   * ⚠ Без этого кнопка отвечала «опрос запущен» и ЗАМОЛКАЛА навсегда: исход был виден только в
   * логах сервера, то есть человеку в портале — никак. Именно поэтому забор за день нельзя было
   * ни принять, ни опровергнуть.
   *
   * ⚠ Сравниваем с меткой ДО запуска, а не просто «есть ли результат»: у портала он почти всегда
   * уже есть от планового опроса, и без базовой метки мы показали бы чужой прогон как свой.
   *
   * ⚠ Не дождались — говорим именно это, а не «операций нет»: прогон может идти дольше окна
   * (очередь занята, банк думает), и выдать ожидание за пустой ответ значит соврать.
   */
  async function awaitOutcome(a: ReturnType<typeof frameAuth>, before: string | null, day: string): Promise<void> {
    if (!a) return
    waiting.value = true
    const deadline = Date.now() + OUTCOME_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, OUTCOME_STEP_MS))
        let run: { lastSyncAt?: string | null, operations?: number, activitiesCreated?: number } | null = null
        try {
          run = await $fetch('/api/import/status', { headers: authHeaders(a) })
        } catch {
          continue // транзиентный сбой чтения статуса — не повод объявлять исход
        }
        const stamp = run?.lastSyncAt ?? null
        if (!stamp || stamp === before) continue
        const ops = run?.operations ?? 0
        const created = run?.activitiesCreated ?? 0
        outcome.value = ops === 0
          ? `Банк ответил: операций${day ? ` за ${day}` : ''} нет.`
          : `Готово: операций — ${ops}, записано в CRM — ${created}.`
        return
      }
      outcome.value = 'Ответа пока нет — обработка ещё идёт. Загляните в «Последние операции» через минуту.'
    } finally {
      waiting.value = false
    }
  }

  return { poll, syncEnabled, polling, error, message, enabled, outcome, waiting }
}
