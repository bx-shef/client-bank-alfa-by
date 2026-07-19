import { ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'
import type { AllocationTargetKind } from '~/utils/allocation'
import type { AllocationSource, DistributionStatus } from '~/utils/manualAllocation'

// Load the portal's distribution ledger (#109 §9.3 #4) for the «Распределение» tab. GET
// /api/distribution/ledger with the FRAME token (Bearer + X-B24-Domain) — the backend gates on the
// feature flag + admin, then reads the SP-ledger on the portal's stored OAuth token. Outside a portal
// frame there is no token → inert. Mirrors useProvisionDistribution / useManualPoll.

/** One distribution row as returned by the ledger read (raw amounts; the card presents them). */
export interface LedgerRow {
  targetKind: AllocationTargetKind
  targetId: string
  amount: number
  currency: string
  source: AllocationSource
  status: DistributionStatus
}

/** One payment carrier card as returned by the ledger read. */
export interface LedgerCard {
  id: string
  total: number
  currency: string
  requiresRedistribution: boolean
  rows: LedgerRow[]
}

interface LedgerResponse {
  provisioned?: boolean
  cards?: LedgerCard[]
  error?: string
}

export function useDistributionLedger() {
  const loading = ref(false)
  const error = ref('')
  /** True only in the in-portal frame (a token exists). */
  const enabled = ref(false)
  /** True once a load has resolved (drives the empty-vs-not-loaded distinction). */
  const loaded = ref(false)
  /** False when the distribution SPs aren't provisioned yet (UI shows a setup prompt). */
  const provisioned = ref(true)
  const cards = ref<LedgerCard[]>([])

  function syncEnabled(): void {
    enabled.value = frameAuth() !== null
  }

  /** Load the ledger. Sets `cards`/`provisioned` on success, `error` on any failure. */
  async function load(): Promise<void> {
    const a = frameAuth()
    enabled.value = a !== null
    error.value = ''
    if (!a) {
      error.value = 'Распределение доступно только внутри портала Bitrix24'
      return
    }
    loading.value = true
    try {
      const res = await $fetch<LedgerResponse>('/api/distribution/ledger', { headers: authHeaders(a) })
      provisioned.value = res?.provisioned !== false
      cards.value = res?.cards ?? []
      loaded.value = true
    } catch (e) {
      const status = (e as { statusCode?: number, status?: number })?.statusCode ?? (e as { status?: number })?.status
      if (status === 404) error.value = 'Распределение сейчас отключено.'
      else if (status === 403) error.value = 'Просмотр распределения доступен только администратору портала.'
      else if (status === 409) error.value = 'Приложение не установлено на портал.'
      else error.value = frameFetchError(e, 'Не удалось загрузить распределение')
    } finally {
      loading.value = false
    }
  }

  return { load, syncEnabled, loading, error, enabled, loaded, provisioned, cards }
}
