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

export function useManualPoll() {
  const polling = ref(false)
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

  return { poll, syncEnabled, polling, error, message, enabled }
}
