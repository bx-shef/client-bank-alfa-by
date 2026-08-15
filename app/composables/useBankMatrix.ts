import { computed, ref } from 'vue'
import type { BankProviderId } from '~/types/statement'
import type { MatrixRow } from '~/utils/bankAccountMatrix'
import { matrixIsClean } from '~/utils/bankAccountMatrix'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// «Наш счёт ↔ счёт в банке» (#494): read the matrix from the admin-gated frame-token route
// /api/bank/matrix. Same auth model as useBankAccounts, and equally inert outside the portal frame.
//
// No secrets reach the browser: the payload is account NUMBERS (which the admin can already read
// in CRM and in their bank) plus a per-provider error string.

/** One bank's answer, reported apart from the rows — an empty bank side caused by a failed
 *  request must never read as «банк не отдаёт ни одного счёта». */
export interface MatrixProviderStatus {
  provider: BankProviderId
  count: number
  error: string | null
}

export function useBankMatrix() {
  const rows = ref<MatrixRow[]>([])
  const providers = ref<MatrixProviderStatus[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  /** True when every row matches — the screen can then stay quiet instead of demanding attention. */
  const clean = computed(() => matrixIsClean(rows.value))
  /** Rows an admin must act on, in the order the core already sorted them. */
  const problems = computed(() => rows.value.filter(r => r.state !== 'matched'))
  /** Bank-side accounts, per provider, for the «pick instead of type» flow (#407 + #494). */
  const bankAccounts = computed(() => rows.value.filter(r => r.bank).map(r => r.bank!))

  async function load(): Promise<void> {
    const a = frameAuth()
    if (!a) {
      rows.value = []
      providers.value = []
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<{ rows?: MatrixRow[], providers?: MatrixProviderStatus[] }>(
        '/api/bank/matrix',
        { headers: authHeaders(a) }
      )
      rows.value = Array.isArray(res?.rows) ? res.rows : []
      providers.value = Array.isArray(res?.providers) ? res.providers : []
    } catch (e) {
      // 409 «portal not installed» is a real answer here, not a glitch: the settings form renders
      // outside a finished install during development. The shared mapper already words it.
      error.value = frameFetchError(e, 'Не удалось сверить счета с банком')
      rows.value = []
      providers.value = []
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  return { rows, providers, loading, loaded, error, clean, problems, bankAccounts, load }
}
