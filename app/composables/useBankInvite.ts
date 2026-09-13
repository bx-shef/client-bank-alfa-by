import { ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'
import { contactLabel, type BankContact } from '~/utils/bankContact'
import type { BankProviderId } from '~/types/statement'

// «Передать владельцу счёта» (#19): администратор выбирает сотрудника штатным диалогом портала, а
// сервер выпускает ссылку/инструкцию и отправляет её ему в чат от имени приложения.
//
// ⚠ ЗАЧЕМ ЭТО ВООБЩЕ. Подключение банка админское, а пароль от интернет-банка знает владелец
// счёта — обычно бухгалтер. Раньше передать ссылку можно было только скопировав её из поля и
// переслав вручную, то есть самый частый сценарий подключения был ручным обходным путём.
//
// ⚠ ССЫЛКУ МЫ ЗДЕСЬ НЕ ВИДИМ И НЕ ХОТИМ ВИДЕТЬ: сервер выпускает её и сразу отправляет. Вернись
// она сюда — её срок начинал бы течь на экране администратора, а получателю доставался бы
// остаток чужого отсчёта.

/** Что вернул диалог выбора сотрудника. `null` — закрыли, ничего не выбрав (не ошибка). */
export interface PickedUser {
  id: string
  name: string
}

export function useBankInvite() {
  const b24 = useB24()
  const sending = ref(false)
  const error = ref('')
  /** Кому отправили в прошлый раз (с сервера). `null` — ещё никому. */
  const contact = ref<BankContact | null>(null)
  /** Непустое сразу после удачной отправки — подпись «отправлено такому-то». */
  const sentTo = ref('')

  /**
   * Открыть штатный диалог выбора сотрудника.
   *
   * ⚠ Только внутри фрейма портала (диалог рисует сам портал). Снаружи — `null` с объяснением, а
   * не тишина: молчащая кнопка неотличима от сломанной.
   */
  async function pickUser(): Promise<PickedUser | null> {
    error.value = ''
    try {
      await b24.init()
      const frame = b24.get()
      if (!frame) {
        error.value = 'Выбор сотрудника доступен только внутри портала Bitrix24'
        return null
      }
      const selected = await frame.dialog.selectUser()
      if (!selected) return null // закрыли диалог — это не ошибка и не повод что-то писать
      return { id: String(selected.id ?? ''), name: String(selected.name ?? '') }
    } catch (e) {
      error.value = e instanceof Error ? e.message : 'Не удалось открыть выбор сотрудника'
      return null
    }
  }

  /** Отправить приглашение выбранному сотруднику. `true` — доставлено. */
  async function send(provider: BankProviderId, user: PickedUser): Promise<boolean> {
    const a = frameAuth()
    error.value = ''
    sentTo.value = ''
    if (!a) {
      error.value = 'Отправка доступна только внутри портала Bitrix24'
      return false
    }
    sending.value = true
    try {
      const res = await $fetch<{ sent?: boolean, error?: string }>('/api/bank/send-link', {
        method: 'POST',
        headers: authHeaders(a),
        body: { provider, userId: user.id, userName: user.name }
      })
      if (!res?.sent) {
        error.value = res?.error || 'Не удалось отправить'
        return false
      }
      // Локальная копия адресата — чтобы подпись обновилась, не дожидаясь повторного чтения с
      // сервера (тот пишет его best-effort, уже ПОСЛЕ доставки сообщения).
      contact.value = user.name ? { userId: user.id, name: user.name } : { userId: user.id }
      sentTo.value = contactLabel(contact.value)
      return true
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось отправить')
      return false
    } finally {
      sending.value = false
    }
  }

  /** Прочитать запомненного адресата. Тихо инертно вне портала и при отказе — это подсказка,
   *  а не часть подключения: ошибка здесь не должна красить экран настроек. */
  async function loadContact(): Promise<void> {
    const a = frameAuth()
    if (!a) return
    try {
      const res = await $fetch<{ contact?: BankContact | null }>('/api/bank/contact', { headers: authHeaders(a) })
      contact.value = res?.contact ?? null
    } catch {
      contact.value = null
    }
  }

  return { sending, error, contact, sentTo, pickUser, send, loadContact }
}
