import { computed, ref } from 'vue'
import type { BankProviderId } from '~/types/statement'
import type { MatrixRow } from '~/utils/bankAccountMatrix'
import { matrixIsClean, matrixProblems } from '~/utils/bankAccountMatrix'
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
 * Синтетическая сверка для `?preview=1` — разработка без портала и ВИЗУАЛЬНЫЕ ЭТАЛОНЫ (#3).
 *
 * ⚠ Та же дыра, что была у списка подключений: вне портала матрица ВСЕГДА пуста (нет фрейм-токена),
 * поэтому блок сверки не попадал ни в один скриншот и ни в один эталон — ни строки состояния, ни
 * подписи, ни сводки не были прикрыты визуальной регрессией ни разу.
 *
 * ⚠ Случай намеренно ИНТЕРЕСНЫЙ и покрывает все четыре состояния строки СРАЗУ, включая `unchecked`
 * (хвост #539) вместе с ошибкой провайдера, которая его и порождает: снимок, сделанный на одной
 * зелёной строке, не документирует ничего из того, ради чего экран существует.
 *
 * ⚠ Номера СИНТЕТИЧЕСКИЕ и обязаны такими остаться — они попадают и в коммитимые эталоны, и в
 * публичный JS-чанк, то есть настоящий IBAN здесь равен публикации реквизитов.
 */
export const PREVIEW_BANK_MATRIX: { rows: MatrixRow[], providers: MatrixProviderStatus[] } = {
  rows: [
    { state: 'bank-only', bank: { number: 'BY00ALFA00000000000000000009' }, connected: false },
    {
      state: 'looks-same',
      crm: { companyId: '1', number: 'BY00 ALFA 0000 0000 0000 0000 0004' },
      bank: { number: 'BY00ALFA00000000000000000004' },
      connected: true
    },
    { state: 'unchecked', crm: { companyId: '1', number: 'BY00PJCB00000000000000000002' }, connected: true },
    {
      state: 'matched',
      crm: { companyId: '1', number: 'BY00ALFA00000000000000000001' },
      bank: { number: 'BY00ALFA00000000000000000001' },
      connected: true
    }
  ],
  providers: [
    { provider: 'alfa-by', count: 2, error: null },
    // Именно этот отказ и делает строку выше `unchecked` — вместе они и есть проверяемый экран.
    { provider: 'prior-by', count: 0, error: 'подключение сейчас обновляется — повторите через несколько секунд' }
  ]
}

export function useBankMatrix() {
  const rows = ref<MatrixRow[]>([])
  const providers = ref<MatrixProviderStatus[]>([])
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref('')

  /** True when every row matches — the screen can then stay quiet instead of demanding attention. */
  const clean = computed(() => matrixIsClean(rows.value))
  /** Rows an admin must act on, in the order the core already sorted them.
   *  ⚠ Not `state !== 'matched'`: `unchecked` is not a problem — it is a question the bank did not
   *  answer this run, and listing it as one sends the admin to fix healthy requisites. */
  const problems = computed(() => matrixProblems(rows.value))
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

  return { rows, providers, loading, loaded, error, clean, problems, bankAccounts, load }
}
