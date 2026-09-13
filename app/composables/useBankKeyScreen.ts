import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Экран ВЛАДЕЛЬЦА СЧЁТА: проверить ссылку и принять ключ API (#19).
//
// ⚠ Ссылка проверяется ОТДЕЛЬНЫМ запросом ДО показа формы. Человек уходит в кабинет банка
// выпускать ключ и возвращается с ним — узнать, что ссылка протухла, после этой работы было бы
// худшим моментом из возможных.

export function useBankKeyScreen() {
  const checking = ref(true)
  const submitting = ref(false)
  /** Ссылка годна — можно показывать форму. */
  const ready = ref(false)
  /** Подключение создано. */
  const done = ref(false)
  const error = ref('')
  /** Наш `client_id` — его вписывают в кабинете банка при выпуске ключа. */
  const clientId = ref('')

  /** Проверить грант из ссылки. Пустой токен — тоже отказ, но с человеческим текстом. */
  async function check(token: string): Promise<void> {
    checking.value = true
    ready.value = false
    error.value = ''
    try {
      const a = frameAuth()
      if (!a) {
        error.value = 'Этот экран открывается только внутри портала Bitrix24 — перейдите по ссылке из чата.'
        return
      }
      if (!token) {
        error.value = 'Ссылка неполная — откройте её из сообщения целиком.'
        return
      }
      const res = await $fetch<{ ok?: boolean, clientId?: string, error?: string }>('/api/bank/key-request', {
        headers: authHeaders(a),
        query: { t: token }
      })
      if (!res?.ok) {
        error.value = res?.error || 'Ссылка недействительна'
        return
      }
      clientId.value = String(res.clientId ?? '')
      ready.value = true
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось проверить ссылку')
    } finally {
      checking.value = false
    }
  }

  /** Отправить ключ. `true` — подключение создано. */
  async function submit(token: string, apiKey: string): Promise<boolean> {
    const a = frameAuth()
    error.value = ''
    if (!a) {
      error.value = 'Этот экран открывается только внутри портала Bitrix24'
      return false
    }
    submitting.value = true
    try {
      const res = await $fetch<{ connected?: boolean, error?: string }>('/api/bank/submit-key', {
        method: 'POST',
        headers: authHeaders(a),
        body: { t: token, apiKey }
      })
      if (!res?.connected) {
        error.value = res?.error || 'Не удалось подключить'
        return false
      }
      done.value = true
      return true
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось подключить')
      return false
    } finally {
      submitting.value = false
    }
  }

  return { checking, submitting, ready, done, error, clientId, check, submit }
}
