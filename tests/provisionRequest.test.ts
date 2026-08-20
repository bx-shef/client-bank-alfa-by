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

describe('concurrent click — «busy», not a failure (#516)', () => {
  /** The Postgres error on an exhausted `lock_timeout` — exactly what used to escape unhandled. */
  const lockTimeout = Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })

  it('an exhausted lock wait ⇒ 503 with a human message, not 502', async () => {
    // ⚠ Provisioning CREATES smart processes in the client's CRM and there is no rollback button in
    // production. An admin who sees «provisioning failed» cannot tell whether anything was created,
    // and the natural reaction is to press again. The message must say NOT to.
    const r = await handleProvisionRequest(deps({
      provision: async () => {
        throw lockTimeout
      }
    }), input)
    expect(r.status).toBe(503)
    expect(String(r.body.error)).toMatch(/уже выполняется/)
    expect(String(r.body.error), 'не сказано, что повтор вреден').toMatch(/Повторное нажатие/)
  })

  it('a REAL failure still surfaces as 502, never dressed up as «busy»', async () => {
    // ⚠ Mirrors the test in `bankAccountRename` (#509). Confusing the two means telling a human to
    // keep clicking while the cause is somewhere else entirely.
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

  it('живые маршруты реально просят КОРОТКОЕ ожидание, а не молча берут 10-секундный дефолт', async () => {
    // ⚠ Единственный тест, который вообще смотрит на проводку. Чистые хендлеры выше получают
    // ошибку лока через DI-мок и до `provision.post.ts`/`recompute.post.ts` не доходят никогда,
    // поэтому пропажа третьего аргумента `{ lockWait: SINGLE_FLIGHT_LOCK_WAIT }` (мердж-конфликт,
    // «упростили дубль») оставляла ВЕСЬ набор зелёным. А в проде это ровно то, ради чего PR и
    // писался: ожидание молча откатывается на `DEFAULT_LOCK_WAIT`, и второй клик занимает
    // соединение из пула (пул — 10) на десять секунд вместо одной.
    const { readFileSync } = await import('node:fs')
    for (const rel of ['server/api/distribution/provision.post.ts', 'server/api/distribution/recompute.post.ts']) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
      expect(src, `${rel} зовёт withAdvisoryLock без lockWait — вернулся дефолт 10 с`)
        .toMatch(/lockWait:\s*SINGLE_FLIGHT_LOCK_WAIT/)
      // Не своя строка «1s» рядом с общей константой: разойдись они — маршруты стали бы ждать
      // по-разному, и никто бы этого не заметил.
      expect(src, `${rel} завёл свою копию значения ожидания`).not.toMatch(/lockWait:\s*'/)
    }
  })
})
