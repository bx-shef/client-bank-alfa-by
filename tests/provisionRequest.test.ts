import { describe, expect, it, vi } from 'vitest'
import { handleProvisionRequest, type ProvisionRequestDeps } from '../server/utils/provisionRequest'
import type { ProvisionDistributionOutcome } from '../server/utils/distributionProvisionHandler'

// Pure request gate for POST /api/distribution/provision (#109 §9.1): feature gate → frame auth
// (installed + valid token + admin) → provision. DI over fakes — no pg / network.

const OUTCOME: ProvisionDistributionOutcome = {
  paymentSpEtid: 1044,
  distributionSpEtid: 1046,
  createdPaymentSp: true,
  createdDistributionSp: false,
  addedFields: 3,
  storedChanged: true
}

function deps(over: Partial<ProvisionRequestDeps> = {}): ProvisionRequestDeps {
  return {
    enabled: true,
    memberIdByDomain: async () => 'MEMBER1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    provision: async () => OUTCOME,
    ...over
  }
}

const input = { accessToken: 'tok', domain: 'x.bitrix24.by' }

/** An async fn that always rejects — keeps the throw off the deps-override line (lint). */
const rejectsWith = (msg: string) => async (): Promise<never> => {
  throw new Error(msg)
}

describe('handleProvisionRequest', () => {
  it('provisions and returns the outcome for an admin in an installed portal', async () => {
    const provision = vi.fn(async () => OUTCOME)
    const res = await handleProvisionRequest(deps({ provision }), input)
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, paymentSpEtid: 1044, distributionSpEtid: 1046, created: true, addedFields: 3, storedChanged: true })
    expect(provision).toHaveBeenCalledWith('MEMBER1')
  })

  it('404 when the feature is disabled (reveals nothing, checked first)', async () => {
    const provision = vi.fn(async () => OUTCOME)
    const res = await handleProvisionRequest(deps({ enabled: false, provision }), input)
    expect(res.status).toBe(404)
    expect(provision).not.toHaveBeenCalled()
  })

  it('400 without a token or domain', async () => {
    expect((await handleProvisionRequest(deps(), { accessToken: '', domain: 'x' })).status).toBe(400)
    expect((await handleProvisionRequest(deps(), { accessToken: 't', domain: '' })).status).toBe(400)
  })

  it('409 when the portal is not installed (no member id)', async () => {
    const res = await handleProvisionRequest(deps({ memberIdByDomain: async () => '' }), input)
    expect(res.status).toBe(409)
  })

  it('401 when the frame token fails to validate (throws) or returns no user', async () => {
    const throwing = deps({ validateFrame: rejectsWith('expired') })
    expect((await handleProvisionRequest(throwing, input)).status).toBe(401)
    const noUser = deps({ validateFrame: async () => ({ userId: '', isAdmin: true }) })
    expect((await handleProvisionRequest(noUser, input)).status).toBe(401)
  })

  it('403 when the caller is not an admin', async () => {
    const provision = vi.fn(async () => OUTCOME)
    const res = await handleProvisionRequest(deps({ provision, validateFrame: async () => ({ userId: '7', isAdmin: false }) }), input)
    expect(res.status).toBe(403)
    expect(provision).not.toHaveBeenCalled()
  })

  it('502 when member lookup throws (upstream error, fail-closed)', async () => {
    const res = await handleProvisionRequest(deps({ memberIdByDomain: rejectsWith('db down') }), input)
    expect(res.status).toBe(502)
  })

  it('502 when provisioning throws (never leaks the error, no partial success body)', async () => {
    const res = await handleProvisionRequest(deps({ provision: rejectsWith('crm.type.add failed') }), input)
    expect(res.status).toBe(502)
    expect(res.body.ok).toBeUndefined()
  })

  it('gate order: disabled beats missing creds (no auth probing when off)', async () => {
    const memberIdByDomain = vi.fn(async () => 'M')
    const res = await handleProvisionRequest(deps({ enabled: false, memberIdByDomain }), { accessToken: '', domain: '' })
    expect(res.status).toBe(404)
    expect(memberIdByDomain).not.toHaveBeenCalled()
  })
})

describe('конкурентный клик — «занято», а не сбой (#516)', () => {
  /** Ошибка Postgres при исчерпании `lock_timeout` — ровно то, что прилетало наружу необработанным. */
  const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })

  it('исчерпание ожидания лока ⇒ 503 с человеческим текстом, а не 502', async () => {
    // ⚠ Провижининг СОЗДАЁТ смарт-процессы в CRM клиента, и кнопки отката в проде нет. Админ,
    // увидев «provisioning failed», не знает, создалось что-то или нет, и естественная реакция —
    // нажать ещё раз. Сообщение обязано сказать, что делать этого НЕ надо.
    const r = await handleProvisionRequest(deps({
      provision: async () => {
        throw lockTimeout
      }
    }), input)
    expect(r.status).toBe(503)
    expect(String(r.body.error)).toMatch(/уже выполняется/)
    expect(String(r.body.error), 'не сказано, что повтор вреден').toMatch(/Повторное нажатие/)
  })

  it('НАСТОЯЩИЙ сбой по-прежнему пробрасывается как 502, а не выдаётся за «занято»', async () => {
    // ⚠ Зеркало теста из `bankAccountRename` (#509). Спутать эти два случая — значит предложить
    // человеку жать кнопку, пока не надоест, тогда как причина в другом месте.
    const r = await handleProvisionRequest(deps({
      provision: async () => {
        throw new Error('connection terminated')
      }
    }), input)
    expect(r.status).toBe(502)
  })

  it('код 55P03 опознаётся ОБЩЕЙ функцией, а не своей копией', async () => {
    // Разойдись копии — один маршрут отвечал бы «занято», другой «сбой», на одном и том же коде.
    const { readFileSync } = await import('node:fs')
    for (const rel of ['server/utils/provisionRequest.ts', 'server/utils/recomputeRequest.ts']) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
      expect(src, `${rel} не использует общий isLockTimeout`).toContain('isLockTimeout')
      expect(src, `${rel} завёл свою копию кода 55P03`).not.toMatch(/'55P03'/)
    }
  })
})
