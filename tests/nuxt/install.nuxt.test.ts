import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountSuspended } from '@nuxt/test-utils/runtime'

// Mutable mock state, shared with the hoisted vi.mock factory below.
const replaceSpy = vi.hoisted(() => vi.fn())
const finishSpy = vi.hoisted(() => vi.fn(async () => {}))
const titleSpy = vi.hoisted(() => vi.fn(async () => {}))
const callSpy = vi.hoisted(() => vi.fn(async (_arg?: unknown) => ({
  isSuccess: true,
  getData: () => ({ result: true }),
  getErrorMessages: () => [] as string[]
})))
const batchSpy = vi.hoisted(() => vi.fn(async (_arg?: unknown) => ({
  isSuccess: true,
  getData: () => ({ scope: ['crm'], eventList: [] as { event: string, handler: string }[] }),
  getErrorMessages: () => [] as string[]
})))
const state = vi.hoisted(() => ({ inFrame: false, requiredRights: [] as string[], accessToken: '' }))

vi.mock('vue-router', async (orig) => {
  const actual = await orig<typeof import('vue-router')>()
  return { ...actual, useRouter: () => ({ replace: replaceSpy }) }
})

vi.mock('~/composables/useB24', async () => {
  const { makeMockB24 } = await import('./helpers/mockB24')
  return {
    useB24: () => makeMockB24({
      isInit: () => state.inFrame,
      installFinish: finishSpy,
      setTitle: titleSpy,
      batchMake: batchSpy,
      callMake: callSpy,
      requiredRights: state.requiredRights,
      ...(state.accessToken ? { accessToken: state.accessToken } : {})
    })
  }
})

const InstallPage = await import('~/pages/install.vue').then(m => m.default)

const defaultBatch = async (_arg?: unknown) => ({
  isSuccess: true,
  getData: () => ({ scope: ['crm'], eventList: [] as { event: string, handler: string }[] }),
  getErrorMessages: () => [] as string[]
})

beforeEach(() => {
  vi.useFakeTimers();
  [replaceSpy, finishSpy, titleSpy, batchSpy, callSpy].forEach(s => s.mockClear())
  // mockClear keeps implementations, so restore the default (a test may have
  // installed a failure-aware mockImplementation).
  state.requiredRights = []
  state.accessToken = ''
  batchSpy.mockImplementation(defaultBatch)
  callSpy.mockImplementation(async () => ({ isSuccess: true, getData: () => ({ result: true }), getErrorMessages: () => [] as string[] }))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('install.vue — standalone (no B24 frame)', () => {
  beforeEach(() => {
    state.inFrame = false
  })

  it('НЕ устанавливает ничего и не редиректит — просто выходит (#414)', async () => {
    // Раньше страница крутила фальшивый прогресс и уводила на лендинг. Теперь объяснение
    // показывает общий `InPortalGate`, а сама установка молча не начинается: снаружи портала
    // её нельзя ни завершить, ни даже осмысленно изобразить.
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(13000)
    expect(finishSpy).not.toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
    // Утверждение со ЗНАКОМ ПЛЮС: одни «не вызвано» прошли бы и на застрявшей странице установки.
    expect(wrapper.find('[data-testid="portal-gate-outside"]').exists()).toBe(true)
  })
})

describe('install.vue — inside a B24 frame', () => {
  beforeEach(() => {
    state.inFrame = true
  })

  it('sets the title and calls installFinish (no redirect)', async () => {
    await mountSuspended(InstallPage)
    // isInit() is true immediately, so waitForB24 returns at once; then setTitle,
    // batch.make, an ~800ms delay, installFinish.
    await vi.advanceTimersByTimeAsync(2000)
    expect(titleSpy).toHaveBeenCalled()
    expect(finishSpy).toHaveBeenCalled()
    expect(replaceSpy).not.toHaveBeenCalled()
  })

  it('binds the app lifecycle AND CRM deletion events to the backend endpoint before finishing', async () => {
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    // Find the batch call (and its call index) that carries the event.bind calls.
    type BatchArg = { calls?: { method: string, params: Record<string, unknown> }[] }
    const bindIndex = batchSpy.mock.calls.findIndex((call) => {
      const arg = (call as unknown[])[0] as BatchArg
      return Array.isArray(arg.calls) && arg.calls.some(c => c.method === 'event.bind')
    })
    expect(bindIndex).toBeGreaterThanOrEqual(0)
    const bindArg = (batchSpy.mock.calls[bindIndex]![0]) as BatchArg
    const bound = bindArg.calls!.filter(c => c.method === 'event.bind')
    // Lifecycle events (token delivery) + the three §9.2 deletion events (ledger reconcile).
    expect(bound.map(c => c.params.event)).toEqual([
      'ONAPPINSTALL',
      'ONAPPUNINSTALL',
      'ONCRMDEALDELETE',
      'ONCRMCOMPANYDELETE',
      'ONCRMDYNAMICITEMDELETE'
    ])
    // Handler must be ABSOLUTE (the guard's whole point) — a relative path would
    // register a dead binding. `.+//` before the path enforces scheme+host.
    for (const c of bound) expect(String(c.params.handler)).toMatch(/^https?:\/\/.+\/api\/b24\/events$/)
    // Ordering is load-bearing: bind must run BEFORE installFinish so the current
    // install's ONAPPINSTALL reaches the freshly-bound handler.
    expect(finishSpy).toHaveBeenCalled()
    const bindOrder = batchSpy.mock.invocationCallOrder[bindIndex]!
    const finishOrder = finishSpy.mock.invocationCallOrder[0]!
    expect(bindOrder).toBeLessThan(finishOrder)
  })

  it('registers the app automation trigger (crm.automation.trigger.add) before finishing (#79)', async () => {
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    // A single call.make with the trigger registration was issued.
    type CallArg = { method: string, params: Record<string, unknown> }
    const regIndex = callSpy.mock.calls.findIndex((call) => {
      const arg = (call as unknown[])[0] as CallArg
      return arg?.method === 'crm.automation.trigger.add'
    })
    expect(regIndex).toBeGreaterThanOrEqual(0)
    const regArg = (callSpy.mock.calls[regIndex]![0]) as CallArg
    expect(regArg.params.CODE).toBe('cba_payment_received')
    expect(String(regArg.params.NAME)).not.toHaveLength(0)
    // Runs in application context before installFinish.
    expect(finishSpy).toHaveBeenCalled()
    const regOrder = callSpy.mock.invocationCallOrder[regIndex]!
    expect(regOrder).toBeLessThan(finishSpy.mock.invocationCallOrder[0]!)
  })

  it('registers the app chat bot (imbot.v2.Bot.register) before finishing (#496)', async () => {
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    type CallArg = { method: string, params: Record<string, unknown> }
    const regIndex = callSpy.mock.calls.findIndex((call) => {
      const arg = (call as unknown[])[0] as CallArg
      // ⚠ Именно v2: `imbot.register` — устаревшее поколение, и ошибка тут тихая (старый метод
      // существует и отвечает).
      return arg?.method === 'imbot.v2.Bot.register'
    })
    expect(regIndex).toBeGreaterThanOrEqual(0)
    const regArg = (callSpy.mock.calls[regIndex]![0]) as CallArg
    expect(regArg.params.CODE).toBe('cba_statement_bot')
    expect(JSON.stringify(regArg)).not.toMatch(/botToken/i) // под OAuth его быть не должно
    const regOrder = callSpy.mock.invocationCallOrder[regIndex]!
    expect(regOrder).toBeLessThan(finishSpy.mock.invocationCallOrder[0]!)
  })

  it('bot registration is BEST-EFFORT: a portal without the imbot scope still installs', async () => {
    // Самый частый случай на старых установках: скоуп не выдан, регистрация отвергнута. Установка
    // уже доставила токены — валить её из-за подписи сообщений нельзя.
    callSpy.mockImplementation(async () => ({
      isSuccess: false,
      getData: () => ({ result: false }),
      getErrorMessages: () => ['The request requires HIGHER PRIVILEGES than provided by the access token']
    }))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Ошибка установки')
  })

  it('trigger registration is BEST-EFFORT: a rejected promise does not block the install', async () => {
    // Non-admin installer / non-commercial plan → the API rejects trigger.add. The
    // install must still finish (the token-delivering event.bind already succeeded).
    callSpy.mockRejectedValue(new Error('Access denied! Admin permissions required'))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).toHaveBeenCalled() // install NOT blocked
    expect(wrapper.text()).not.toContain('Ошибка установки')
  })

  it('trigger registration is BEST-EFFORT: a resolved FAILED Result does not block the install (realistic B24 failure)', async () => {
    // B24 usually returns a failed Result rather than throwing — registerTrigger reads
    // res.isSuccess=false and records the error string, never rethrows. Install still finishes.
    callSpy.mockImplementation(async () => ({
      isSuccess: false,
      getData: () => ({ result: false }),
      getErrorMessages: () => ['Access denied! Application context required']
    }))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    // The call WAS made and returned a failed Result (not a throw); install still finishes.
    const madeReg = callSpy.mock.calls.some((c) => {
      const arg = (c as unknown[])[0] as { method?: string }
      return arg?.method === 'crm.automation.trigger.add'
    })
    expect(madeReg).toBe(true)
    expect(finishSpy).toHaveBeenCalled() // install NOT blocked by the failed Result
    expect(wrapper.text()).not.toContain('Ошибка установки')
  })

  it('surfaces a retryable error and does NOT finish when event.bind fails', async () => {
    // Init batch (app.info/scope/event.get) succeeds; the bind batch resolves as
    // a failed Result — install must not finish with events unbound.
    batchSpy.mockImplementation(async (arg?: unknown) => {
      const calls = (arg as { calls?: { method: string }[] }).calls
      const isBind = Array.isArray(calls) && calls.some(c => c.method === 'event.bind')
      return {
        isSuccess: !isBind,
        getData: () => ({ scope: ['crm'], eventList: [] as { event: string, handler: string }[] }),
        getErrorMessages: () => (isBind ? ['bind refused'] : [])
      }
    })
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Ошибка установки')
    expect(wrapper.text()).toContain('Повторить')
  })

  it('shows a retryable error when a batch call rejects', async () => {
    batchSpy.mockRejectedValueOnce(new Error('boom'))
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)
    expect(finishSpy).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('Ошибка установки')
    expect(wrapper.text()).toContain('Повторить')
  })
})

// Вердикт установки (#410). Смысл: «Готово» больше не равно «работает». Раньше недовыданные права
// показывались бейджами внутри СВЁРНУТОЙ диагностики — то есть не показывались.
describe('install.vue — вердикт установки (#410)', () => {
  beforeEach(() => {
    state.inFrame = true
  })

  it('портал выдал не все права → degraded с перечислением и раскрытой диагностикой', async () => {
    // Портал вернул только `crm`, а приложение просит ещё и `userfieldconfig` (#408 в чистом виде).
    state.requiredRights = ['crm', 'userfieldconfig']
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)

    const verdict = wrapper.find('[data-testid="install-verdict"]')
    expect(verdict.exists()).toBe(true)
    expect(verdict.text()).toContain('userfieldconfig')
    expect(verdict.text()).toContain('Переустановите')
    // Диагностика раскрывается САМА, когда есть о чём говорить: раньше проблема пряталась именно там.
    expect(wrapper.text()).toContain('Обработчик событий')
  })

  it('все права выданы → зелёный вердикт без списка проблем', async () => {
    state.requiredRights = ['crm']
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(2000)

    const verdict = wrapper.find('[data-testid="install-verdict"]')
    expect(verdict.exists()).toBe(true)
    expect(verdict.text()).toContain('Приложение установлено')
    expect(verdict.text()).not.toContain('Переустановите')
  })

  it('вне портала вердикт не показывается — это не провал установки, а демо-режим', async () => {
    state.inFrame = false
    state.requiredRights = ['crm', 'userfieldconfig']
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(13000)
    expect(wrapper.find('[data-testid="install-verdict"]').exists()).toBe(false)
  })
})

describe('install.vue — смарт-процессы создаются САМИ (решение владельца 2026-08-23)', () => {
  // ⚠ Этого блока не было, и мутационный прогон показал цену: снять вызов провижининга целиком или
  // убрать его try/catch можно было, не уронив НИ ОДНОГО теста. Причина структурная — у мока фрейма
  // намеренно нет токена, поэтому `frameAuth()` отдаёт null, проверка серверной части выходит до
  // `$fetch`, и весь путь оказывается недостижим. Здесь токен задаётся явно, а `$fetch` замокан.
  const fetchMock = vi.fn()

  beforeEach(() => {
    state.inFrame = true
    state.accessToken = 'frame-token'
    fetchMock.mockReset()
    // `/api/setup-status` — зонд #413: 200 значит «серверная часть знает портал».
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('setup-status')) return {}
      return { ok: true, paymentSpEtid: 1044, distributionSpEtid: 1046, created: true }
    })
    vi.stubGlobal('$fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Вызовы к нашему backend, в порядке обращения. */
  const urls = () => fetchMock.mock.calls.map(c => String(c[0]))

  it('провижининг идёт ПОСЛЕ подтверждения серверной части — иначе 409 и ложная ошибка', async () => {
    // ⚠ Порядок несущий: провижининг работает на СОХРАНЁННОМ токене портала, а его приносит
    // `ONAPPINSTALL` мимо iframe. До подтверждения вызов вернул бы 409 и записал в вердикт ошибку
    // о том, что событие просто ещё не доехало.
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(20000)
    const probe = urls().findIndex(u => u.includes('setup-status'))
    const provision = urls().findIndex(u => u.includes('/api/distribution/provision'))
    expect(probe, 'зонд серверной части не вызывался').toBeGreaterThanOrEqual(0)
    expect(provision, 'провижининг смарт-процессов не вызывался').toBeGreaterThanOrEqual(0)
    expect(provision).toBeGreaterThan(probe)
    // И только методом POST — GET создал бы иллюзию, что мы просто читаем состояние.
    const opts = fetchMock.mock.calls[provision]![1] as { method?: string, headers?: Record<string, string> }
    expect(opts?.method).toBe('POST')
    expect(opts?.headers?.authorization).toContain('frame-token')
  })

  it('серверная часть НЕ подтвердила портал — провижининг не зовём вовсе', async () => {
    // 409 = события установки ещё нет. Звать провижининг значило бы получить свой 409 и записать
    // ошибку о том, чего не случилось.
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('setup-status')) throw Object.assign(new Error('conflict'), { statusCode: 409 })
      return { ok: true }
    })
    await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(20000)
    expect(urls().some(u => u.includes('/api/distribution/provision'))).toBe(false)
  })

  it('провижининг упал — установка ВСЁ РАВНО завершена (best-effort)', async () => {
    // ⚠ Тот же контракт, что у триггера и бота: токены уже доставлены, и отказ второстепенного шага
    // не имеет права превращать удавшуюся установку в «Ошибка установки».
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('setup-status')) return {}
      throw Object.assign(new Error('crm.type.add failed'), { statusCode: 502 })
    })
    const wrapper = await mountSuspended(InstallPage)
    await vi.advanceTimersByTimeAsync(20000)
    expect(finishSpy, 'установка не завершилась из-за второстепенного шага').toHaveBeenCalled()
    expect(wrapper.text()).not.toContain('Ошибка установки')
    // …но молчать об этом нельзя: без смарт-процесса не ведётся реестр.
    expect(wrapper.text()).toContain('смарт-процессы')
  })
})
