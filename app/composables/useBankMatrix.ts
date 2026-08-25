import { computed, ref } from 'vue'
import type { BankProviderId } from '~/types/statement'
import type { MatrixRow } from '~/utils/bankAccountMatrix'
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

/**
 * Synthetic reconciliation for `?preview=1` — development without a portal, and VISUAL BASELINES (#3).
 *
 * ⚠ The same gap the connected-accounts list had: outside the portal the matrix is ALWAYS empty
 * (no frame token), so this block never appeared in a single screenshot or baseline — not one row
 * state, label or summary was covered by visual regression.
 *
 * ⚠ Deliberately INTERESTING: all four row states at once, together with the provider error that
 * PRODUCES `unchecked` (tail of #539). A shot taken on one green row documents none of what the
 * screen exists for.
 *
 * ⚠ Every bank row carries its `provider`. Untagged, a Prior IBAN could be offered as the account
 * of an Alfa connection (see `BankSideAccount.provider`) — and `count` per provider must agree with
 * the rows, or the fixture teaches a state the real endpoint can never produce.
 *
 * ⚠ Numbers are SYNTHETIC and must stay so: they land both in committed baselines and in the public
 * JS chunk, so a real IBAN here equals publishing bank details.
 */
export const PREVIEW_BANK_MATRIX: { rows: MatrixRow[], providers: MatrixProviderStatus[] } = {
  rows: [
    {
      state: 'bank-only',
      bank: { number: 'BY00ALFA00000000000000000009', provider: 'alfa-by' },
      connected: false
    },
    {
      state: 'looks-same',
      crm: { companyId: '1', number: 'BY00 ALFA 0000 0000 0000 0000 0004' },
      bank: { number: 'BY00ALFA00000000000000000004', provider: 'alfa-by' },
      connected: true
    },
    // Prior stayed silent below, so this account of ours could not be checked at all.
    { state: 'unchecked', crm: { companyId: '1', number: 'BY00PJCB00000000000000000002' }, connected: true },
    {
      state: 'matched',
      crm: { companyId: '1', number: 'BY00ALFA00000000000000000001' },
      bank: { number: 'BY00ALFA00000000000000000001', provider: 'alfa-by' },
      connected: true
    }
  ],
  providers: [
    { provider: 'alfa-by', count: 3, error: null },
    // This refusal is what makes the row above `unchecked` — together they are the screen under test.
    { provider: 'prior-by', count: 0, error: 'подключение сейчас обновляется — повторите через несколько секунд' }
  ]
}

export function useBankMatrix() {
  const rows = ref<MatrixRow[]>([])
  const providers = ref<MatrixProviderStatus[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  // ⚠ `clean`/`problems` USED to live here as well and were never read: the only caller
  // (`BankConnectCard`) passes `rows` straight to `AccountMatrix`, which derives both from its own
  // props. Two exported computeds nobody consumed still had to be reasoned about on every change to
  // the state machine — and the first draft of this change dutifully «deduplicated» them against
  // the component, describing a second consumer that did not exist. Deleted.
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
        // ⚠ `retry: 0` обязателен: ofetch по умолчанию повторяет GET, в том числе на 429 и без
        // паузы, — то есть каждый отказ троттла сам удваивает нагрузку на ту же зону и приближает
        // следующий. Маршрут вдобавок ходит в оба банка, поэтому «бесплатным» повтор тут не бывает.
        { headers: authHeaders(a), retry: 0 }
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

  return { rows, providers, loading, loaded, error, bankAccounts, load }
}
