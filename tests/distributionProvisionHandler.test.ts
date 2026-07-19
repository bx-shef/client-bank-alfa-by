import { describe, expect, it, vi } from 'vitest'
import { handleProvisionDistribution, type ProvisionDistributionDeps } from '../server/utils/distributionProvisionHandler'
import { DISTRIBUTION_SP_CONFIG_KEY, PAYMENT_SP_CONFIG_KEY } from '../app/config/distributionSp'
import { defaultPortalSettings, type PortalSettings } from '../app/utils/settings'
import type { KnownSpIds, ProvisionResult } from '../server/utils/distributionSpProvision'

// Provisioning-execution orchestration (#109 §9.1): load settings → provision → merge etids → save,
// single-flight. DI over fakes — no network / pg.

function settingsWith(configFields: Record<string, string>): PortalSettings {
  const s = defaultPortalSettings()
  return { ...s, recognition: { ...s.recognition, configFields } }
}

/** Deps whose provision returns a fixed result and whose store is an in-memory settings cell. */
function makeDeps(opts: {
  initial: Record<string, string>
  provisionResult: ProvisionResult
  onProvision?: (known: KnownSpIds) => void
}): { deps: ProvisionDistributionDeps, saved: PortalSettings[] } {
  const cell = { current: settingsWith(opts.initial) }
  const saved: PortalSettings[] = []
  const save = async (s: PortalSettings): Promise<void> => {
    saved.push(s)
    cell.current = s
  }
  const provision = async (known: KnownSpIds): Promise<ProvisionResult> => {
    opts.onProvision?.(known)
    return opts.provisionResult
  }
  const deps: ProvisionDistributionDeps = {
    loadSettings: async () => cell.current,
    saveSettings: save,
    provision,
    withLock: async fn => fn()
  }
  return { deps, saved }
}

const RESULT = (over: Partial<ProvisionResult> = {}): ProvisionResult => ({
  paymentSpEtid: 1044,
  distributionSpEtid: 1046,
  createdPaymentSp: true,
  createdDistributionSp: true,
  addedFields: 8,
  ...over
})

describe('handleProvisionDistribution', () => {
  it('provisions and stores both etids when settings are empty', async () => {
    let seenKnown: KnownSpIds | undefined
    const capture = (k: KnownSpIds): void => {
      seenKnown = k
    }
    const { deps, saved } = makeDeps({ initial: {}, provisionResult: RESULT(), onProvision: capture })
    const out = await handleProvisionDistribution(deps)

    expect(seenKnown).toEqual({ paymentSpEtid: null, distributionSpEtid: null }) // nothing stored yet
    expect(out.paymentSpEtid).toBe(1044)
    expect(out.distributionSpEtid).toBe(1046)
    expect(out.storedChanged).toBe(true)
    expect(saved).toHaveLength(1)
    expect(saved[0]!.recognition.configFields[PAYMENT_SP_CONFIG_KEY]).toBe('1044')
    expect(saved[0]!.recognition.configFields[DISTRIBUTION_SP_CONFIG_KEY]).toBe('1046')
  })

  it('passes the already-stored ids as `known` to provision (short-circuit path)', async () => {
    let seenKnown: KnownSpIds | undefined
    const capture = (k: KnownSpIds): void => {
      seenKnown = k
    }
    const { deps } = makeDeps({
      initial: { [PAYMENT_SP_CONFIG_KEY]: '100', [DISTRIBUTION_SP_CONFIG_KEY]: '200' },
      provisionResult: RESULT({ paymentSpEtid: 100, distributionSpEtid: 200, createdPaymentSp: false, createdDistributionSp: false, addedFields: 0 }),
      onProvision: capture
    })
    const out = await handleProvisionDistribution(deps)
    expect(seenKnown).toEqual({ paymentSpEtid: 100, distributionSpEtid: 200 })
    expect(out.storedChanged).toBe(false)
  })

  it('does NOT write settings when the resolved ids equal what is stored (idempotent)', async () => {
    const { deps, saved } = makeDeps({
      initial: { [PAYMENT_SP_CONFIG_KEY]: '1044', [DISTRIBUTION_SP_CONFIG_KEY]: '1046' },
      provisionResult: RESULT({ createdPaymentSp: false, createdDistributionSp: false, addedFields: 0 })
    })
    const out = await handleProvisionDistribution(deps)
    expect(out.storedChanged).toBe(false)
    expect(saved).toHaveLength(0)
  })

  it('writes settings when a recovered-by-title id differs from what was stored', async () => {
    // stored only the payment id; distribution recovered by title → must persist
    const { deps, saved } = makeDeps({
      initial: { [PAYMENT_SP_CONFIG_KEY]: '1044' },
      provisionResult: RESULT({ createdPaymentSp: false, createdDistributionSp: false, addedFields: 0 })
    })
    const out = await handleProvisionDistribution(deps)
    expect(out.storedChanged).toBe(true)
    expect(saved[0]!.recognition.configFields[DISTRIBUTION_SP_CONFIG_KEY]).toBe('1046')
  })

  it('preserves other configFields (does not clobber the user smart-entity target)', async () => {
    const { deps, saved } = makeDeps({
      initial: { 'smart-entity': '1030', 'smart-field': 'UF_CRM_1030_X' },
      provisionResult: RESULT()
    })
    await handleProvisionDistribution(deps)
    const cf = saved[0]!.recognition.configFields
    expect(cf['smart-entity']).toBe('1030')
    expect(cf['smart-field']).toBe('UF_CRM_1030_X')
    expect(cf[PAYMENT_SP_CONFIG_KEY]).toBe('1044')
  })

  it('runs the whole op under the single-flight lock', async () => {
    const order: string[] = []
    const settings = settingsWith({})
    const load = async (): Promise<PortalSettings> => {
      order.push('load')
      return settings
    }
    const save = async (): Promise<void> => {
      order.push('save')
    }
    const provision = async (): Promise<ProvisionResult> => {
      order.push('provision')
      return RESULT()
    }
    const withLock = async <T>(fn: () => Promise<T>): Promise<T> => {
      order.push('lock:enter')
      const r = await fn()
      order.push('lock:exit')
      return r
    }
    await handleProvisionDistribution({ loadSettings: load, saveSettings: save, provision, withLock })
    expect(order).toEqual(['lock:enter', 'load', 'provision', 'save', 'lock:exit'])
  })

  it('propagates a provisioning error (no settings write)', async () => {
    const saveSettings = vi.fn(async () => {})
    const deps: ProvisionDistributionDeps = {
      loadSettings: async () => settingsWith({}),
      saveSettings,
      provision: async () => { throw new Error('crm.type.add failed') },
      withLock: async fn => fn()
    }
    await expect(handleProvisionDistribution(deps)).rejects.toThrow(/crm\.type\.add/)
    expect(saveSettings).not.toHaveBeenCalled()
  })
})
