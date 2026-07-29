import { ref } from 'vue'
import type { BankProviderId } from '~/types/statement'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Connected bank accounts for the settings UI (#404): read the list and disconnect one. Both hit
// admin-gated frame-token routes (/api/bank/accounts, /api/bank/disconnect) — same auth model as
// useBankConnect, and inert outside the portal frame (no token ⇒ nothing to show).
//
// The payload carries identity + freshness only; token material never reaches the browser.

export interface ConnectedBankAccount {
  provider: BankProviderId
  accountKey: string
  /** Epoch ms of the last successful connect/refresh. */
  connectedAt: number
  /** Epoch ms the stored access token expires at. */
  expiresAt: number
  /** False ⇒ no refresh token stored ⇒ the account must be re-connected once access expires. */
  hasRefresh: boolean
}

export function useBankAccounts() {
  const accounts = ref<ConnectedBankAccount[]>([])
  const loading = ref(false)
  const removing = ref('')
  const saving = ref('')
  const error = ref('')
  /** True once a load has resolved — lets the UI tell «пусто» apart from «ещё не спрашивали». */
  const loaded = ref(false)

  /** Row identity used for the per-row busy flag (provider+account is the store key). */
  function rowKey(a: Pick<ConnectedBankAccount, 'provider' | 'accountKey'>): string {
    return `${a.provider}|${a.accountKey}`
  }

  async function load(): Promise<void> {
    const a = frameAuth()
    if (!a) {
      // Outside the portal there is no frame token — stay inert rather than showing an error.
      accounts.value = []
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<{ accounts?: ConnectedBankAccount[] }>('/api/bank/accounts', { headers: authHeaders(a) })
      accounts.value = Array.isArray(res?.accounts) ? res.accounts : []
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось загрузить список подключений')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  /** Disconnect one account, then re-read the list (the server is the source of truth — an
   *  optimistic local splice would lie if the delete silently failed). */
  async function disconnect(account: Pick<ConnectedBankAccount, 'provider' | 'accountKey'>): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Отключение доступно только внутри портала Bitrix24'
      return false
    }
    removing.value = rowKey(account)
    error.value = ''
    try {
      await $fetch('/api/bank/disconnect', {
        method: 'POST',
        headers: authHeaders(a),
        body: { provider: account.provider, accountKey: account.accountKey }
      })
      await load()
      return true
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось отключить счёт')
      return false
    } finally {
      removing.value = ''
    }
  }

  /** Назначить счёт подключению, сделанному без него (#407). Переименовывается только временный
   *  ключ — сервер это и проверяет; здесь просто UI-обёртка. */
  async function setAccount(account: Pick<ConnectedBankAccount, 'provider' | 'accountKey'>, accountKey: string): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Действие доступно только внутри портала Bitrix24'
      return false
    }
    const value = accountKey.trim()
    if (!value) {
      error.value = 'Укажите номер счёта'
      return false
    }
    saving.value = rowKey(account)
    error.value = ''
    try {
      await $fetch('/api/bank/set-account', {
        method: 'POST',
        headers: authHeaders(a),
        body: { provider: account.provider, pendingKey: account.accountKey, accountKey: value }
      })
      await load()
      return true
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось привязать счёт')
      return false
    } finally {
      saving.value = ''
    }
  }

  return { accounts, loading, loaded, removing, saving, error, load, disconnect, setAccount, rowKey }
}
