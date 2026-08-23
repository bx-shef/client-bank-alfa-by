import { describe, expect, it, vi } from 'vitest'
import { classifyProvisionError, handleProvisionRequest, type ProvisionRequestDeps } from '../server/utils/provisionRequest'
import { SingleFlightBusyError } from '../server/utils/singleFlightLease'
import type { ProvisionDistributionOutcome } from '../server/utils/distributionProvisionHandler'

// Pure request gate for POST /api/distribution/provision (#109 §9.1): feature gate → frame auth
// (installed + valid token + admin) → provision. DI over fakes — no pg / network.

const OUTCOME: ProvisionDistributionOutcome = {
  // ⚠ `payment`/`distribution` (SpRef) — не то же, что удобные `*Etid` рядом: у SpRef два числа
  // (`entityTypeId` для `crm.item.*` и `id` для `userfieldconfig`), и фикстура жила без них.
  payment: { entityTypeId: 1044, id: 144 },
  distribution: { entityTypeId: 1046, id: 146 },
  paymentSpEtid: 1044,
  distributionSpEtid: 1046,
  createdPaymentSp: true,
  createdDistributionSp: false,
  addedFields: 3,
  storedChanged: true
}

function deps(over: Partial<ProvisionRequestDeps> = {}): ProvisionRequestDeps {
  return {
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

  it('порядок гейтов: без токена и домена портал даже не ищем', async () => {
    // ⚠ Прежде первым стоял feature-гейт (`DISTRIBUTION_PROVISION_ENABLED`), и он же прикрывал
    // этот порядок. Флага больше нет — режим приложения всегда «включено», потому что смарт-процесс
    // «Платежи» это РЕЕСТР, а не дополнительная возможность, — поэтому проверять порядок надо
    // отдельно: спрашивать базу о портале до того, как вызывающий вообще представился, незачем.
    const memberIdByDomain = vi.fn(async () => 'M')
    const res = await handleProvisionRequest(deps({ memberIdByDomain }), { accessToken: '', domain: '' })
    expect(res.status).toBe(400)
    expect(memberIdByDomain).not.toHaveBeenCalled()
  })
})

describe('concurrent click — «busy», not a failure (#516)', () => {
  /** Отказ «операция уже идёт» — ровно то, что раньше уходило наружу необработанным. */
  const busy = new SingleFlightBusyError('provision-sp:m1')

  it('a busy single-flight ⇒ 503 with a human message, not 502', async () => {
    // ⚠ Provisioning CREATES smart processes in the client's CRM and there is no rollback button in
    // production. An admin who sees «provisioning failed» cannot tell whether anything was created,
    // and the natural reaction is to press again. The message must say NOT to.
    const r = await handleProvisionRequest(deps({
      provision: async () => {
        throw busy
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

  /** Исходник без комментариев — гард обязан судить о КОДЕ, а не о прозе рядом с ним. */
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

  it('«занято» опознаётся ОБЩИМ предикатом, а не своей копией', async () => {
    // Разойдись копии — один маршрут отвечал бы «занято», другой «сбой», на одном и том же исходе.
    // ⚠ Комментарии вырезаются, и это не косметика: проверка по сырому исходнику КРАСНЕЛА бы на
    // верном коде, который всего лишь упоминает `'55P03'` в объяснении. Красный билд на верном
    // коде учит ослаблять гард — то есть такой гард сам себе враг (найдено мутацией).
    const { readFileSync } = await import('node:fs')
    for (const rel of ['server/utils/provisionRequest.ts', 'server/utils/recomputeRequest.ts']) {
      const code = stripComments(readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8'))
      expect(code, `${rel} не использует общий isSingleFlightBusy`).toContain('isSingleFlightBusy')
      expect(code, `${rel} завёл свою копию кода 55P03`).not.toMatch(/'55P03'/)
    }
  })

  it('живые маршруты держат single-flight АРЕНДОЙ, а не advisory-локом (#538)', async () => {
    // ⚠ Единственный тест, который вообще смотрит на проводку. Чистые хендлеры выше получают
    // «занято» через DI-мок и до `provision.post.ts`/`recompute.post.ts` не доходят никогда,
    // поэтому возврат к `withAdvisoryLock` оставил бы ВЕСЬ набор зелёным — а в проде это ровно тот
    // дефект, ради которого правка и писалась: лок держит соединение из пула (пул — 10) всё время
    // REST-цепочки, ни разу не обратившись к базе. Провижининг — это десятки секунд, пересчёт —
    // минуты; десяток таких операций с РАЗНЫХ порталов выедает пул целиком, и readiness-проба
    // начинает честно отвечать «Postgres недоступен» при полностью здоровом Postgres.
    //
    // ⚠ Проверяется ОТСУТСТВИЕ лока, а не только наличие аренды: вернуть `withAdvisoryLock` рядом
    // с работающей арендой — самый вероятный способ починки «на всякий случай», и он возвращает
    // ровно ту цену, от которой избавлялись.
    const { readFileSync } = await import('node:fs')
    for (const rel of ['server/api/distribution/provision.post.ts', 'server/api/distribution/recompute.post.ts']) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
      const code = stripComments(src)
      expect(code, `${rel} не берёт аренду single-flight`).toContain('withSingleFlightLease')
      expect(code, `${rel} снова держит соединение пула advisory-локом всю REST-цепочку`)
        .not.toContain('withAdvisoryLock')
      // Срок аренды — из общей константы (имя целиком, а не по маске `_LEASE_SEC`: под неё
      // подошла бы и чужая константа, и мутация «подставить чужой срок» проходила зелёной).
      expect(code, `${rel} завёл свою копию срока аренды`).toContain('SINGLE_FLIGHT_LEASE_SEC')
      // ⚠ Ключ обязан быть ПЕР-ПОРТАЛЬНЫМ и строиться общим билдером: ключ без `memberId` — это
      // общий семафор, при котором провижининг одного клиента отвечает «занято» всем остальным.
      expect(code, `${rel} строит ключ аренды мимо общего билдера`).toMatch(/LeaseKey\(memberId\)/)
    }
  })

  it('исчерпание НАШЕГО пула не выдаётся за молчание портала (#538)', () => {
    // pg-pool бросает `timeout exceeded when trying to connect` — строку, совпадающую с общей
    // веткой «timeout». Пока она стояла первой, админу уверенно сообщали «Портал не ответил
    // вовремя», и он шёл искать причину в Bitrix24, тогда как соединения кончились у нас.
    const poolText = classifyProvisionError('Error: timeout exceeded when trying to connect')
    expect(poolText).not.toContain('Портал не ответил')
    expect(poolText).toContain('наша сторона')
    // И настоящий сетевой таймаут по-прежнему читается как таймаут портала.
    expect(classifyProvisionError('fetch failed: network timeout')).toContain('Портал не ответил')
  })
})
