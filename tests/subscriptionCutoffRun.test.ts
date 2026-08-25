import { describe, expect, it, vi } from 'vitest'
import { runSubscriptionCutoff, type SubscriptionCutoffDeps } from '../server/utils/subscriptionCutoffRun'
import { SUBSCRIPTION_CUTOFF_DAYS, MAX_SUBSCRIPTION_CUTOFF_PER_RUN } from '../app/utils/portalSubscription'

// Автоотключение банка у портала без подписки на REST (#614, часть 3).
//
// ⚠ Единственный механизм, рвущий связь клиента с банком без участия человека. Поэтому тесты здесь
// проверяют не «сработало ли», а прежде всего «не сработало ли лишнего»: предохранитель по доле
// флота, потолок за прогон, отдельная реакция на расхождение выборки с правилом.

const NOW = 1_800_000_000_000
const DAY = 86_400_000

function deps(over: Partial<SubscriptionCutoffDeps> = {}): SubscriptionCutoffDeps {
  return {
    now: () => NOW,
    countDue: async () => 0,
    countPortals: async () => 100,
    selectDue: async () => [],
    disconnectBanks: async () => 1,
    clearMark: async () => true,
    ...over
  }
}

/** Портал, молчащий ровно `d` дней. */
function due(memberId: string, d: number) {
  return { memberId, endedAtMs: NOW - d * DAY }
}

describe('автоотключение банка при мёртвой подписке (#614)', () => {
  it('портал за порогом — банк отключён, счётчики сходятся', async () => {
    const disconnectBanks = vi.fn(async () => 3)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', SUBSCRIPTION_CUTOFF_DAYS)],
      disconnectBanks
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(disconnectBanks).toHaveBeenCalledWith('M1')
    expect(s).toMatchObject({ candidates: 1, cutoff: 1, connections: 3, failed: 0, diverged: 0 })
  })

  it('портал ДО порога не трогаем, даже если выборка его отдала', async () => {
    // Вторая, независимая проверка тем же правилом, что рисует обратный отсчёт оператору. Без неё
    // политика жила бы только в SQL, и «отключим через 2 дня» на экране разошлось бы с делом.
    const disconnectBanks = vi.fn(async () => 1)
    const warn = vi.fn()
    const clearMark = vi.fn(async () => true)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', SUBSCRIPTION_CUTOFF_DAYS - 1)],
      disconnectBanks, warn, clearMark
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(disconnectBanks).not.toHaveBeenCalled()
    expect(s.diverged).toBe(1)
    expect(s.cutoff).toBe(0)
    // ⚠ Расхождение считается ОТДЕЛЬНО от отказа базы: чинится в коде, а не на сервере.
    expect(s.failed).toBe(0)
    expect(warn.mock.calls.join(' ')).toContain('разошлись')
    // ⚠ И метку НЕ снимаем: снятие спрятало бы ошибку в коде И оставило бы банк подключённым
    // навсегда — портал больше никогда не попал бы в выборку.
    expect(clearMark).not.toHaveBeenCalled()
  })

  it('слишком большая доля флота — НЕ отключаем никого', async () => {
    // Метку ставит регулярка по тексту ошибки Bitrix24 (машинного кода он не даёт). Смени банк
    // формулировку или расширь кто-нибудь маску — «мёртвыми» станут все разом.
    const disconnectBanks = vi.fn(async () => 1)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 60,
      countPortals: async () => 100,
      selectDue: async () => [due('M1', 30)],
      disconnectBanks
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(s.breach).toBe(true)
    expect(disconnectBanks).not.toHaveBeenCalled()
    expect(s.cutoff).toBe(0)
  })

  it('предохранитель не срабатывает на здоровой доле', async () => {
    const disconnectBanks = vi.fn(async () => 1)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      countPortals: async () => 100,
      selectDue: async () => [due('M1', 30)],
      disconnectBanks
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(s.breach).toBe(false)
    expect(disconnectBanks).toHaveBeenCalledOnce()
  })

  it('за прогон отключаем не больше потолка, остальные — в следующий', async () => {
    const many = Array.from({ length: MAX_SUBSCRIPTION_CUTOFF_PER_RUN + 3 }, (_, i) => due(`M${i}`, 30))
    const disconnectBanks = vi.fn(async () => 1)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => many.length,
      countPortals: async () => 1000,
      selectDue: async () => many,
      disconnectBanks
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(s.cutoff).toBe(MAX_SUBSCRIPTION_CUTOFF_PER_RUN)
    expect(s.capped).toBe(true)
    expect(disconnectBanks).toHaveBeenCalledTimes(MAX_SUBSCRIPTION_CUTOFF_PER_RUN)
  })

  it('отказ на одном портале не отменяет остальные', async () => {
    const disconnectBanks = vi.fn(async (m: string) => {
      if (m === 'M1') throw new Error('база молчит')
      return 2
    })
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 2,
      countPortals: async () => 100,
      selectDue: async () => [due('M1', 30), due('M2', 30)],
      disconnectBanks
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(s.failed).toBe(1)
    expect(s.cutoff).toBe(1)
    expect(s.connections).toBe(2)
  })

  it('сырой member_id в лог не попадает — только необратимая метка', async () => {
    const lines: string[] = []
    await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('portal-secret-id', 30)],
      log: m => lines.push(m),
      warn: m => lines.push(m)
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(lines.join(' ')).not.toContain('portal-secret-id')
  })

  it('строка итога печатается, даже когда отключать некого', async () => {
    // Молчащий автомат неотличим от невзведённого — а этот единственный рвёт связь с банком сам.
    const log = vi.fn()
    await runSubscriptionCutoff(deps({ log }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(log).toHaveBeenCalledOnce()
    expect(String(log.mock.calls[0]?.[0])).toContain('кандидатов 0')
  })

  it('порог берётся из аргумента: большим числом автомат глушится целиком', async () => {
    // Аварийный выключатель у автомата ровно один — порог. Это должно РАБОТАТЬ, а не подразумеваться.
    const disconnectBanks = vi.fn(async () => 1)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', 30)],
      disconnectBanks
    }), 3650)
    expect(disconnectBanks).not.toHaveBeenCalled()
    expect(s.cutoff).toBe(0)
  })

  it('после отключения метка снимается — иначе автомат заклинивает навсегда', async () => {
    // ⚠ Метка живёт в `portal_tokens` и переживает удаление банковских строк, а выборка
    // отсортирована по ней ASC: не сними её — отключённый портал станет ПЕРВЫМ в каждом следующем
    // прогоне, займёт место в бюджете и будет печатать громкое «банк отключён» каждые полчаса.
    const clearMark = vi.fn(async () => true)
    await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', 30)],
      clearMark
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(clearMark).toHaveBeenCalledWith('M1')
  })

  it('отключение упало — метку НЕ снимаем, следующий прогон обязан повторить', async () => {
    const clearMark = vi.fn(async () => true)
    await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', 30)],
      disconnectBanks: async () => { throw new Error('база молчит') },
      clearMark
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(clearMark).not.toHaveBeenCalled()
  })

  it('отключать было нечего — это не отключение, а холостой ход', async () => {
    // Банк уже сняли (оператор, ONAPPUNINSTALL, уборщик #599), метка осталась. Громкая строка
    // здесь врала бы о событии, которого не было.
    const warn = vi.fn()
    const clearMark = vi.fn(async () => true)
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', 30)],
      disconnectBanks: async () => 0,
      clearMark, warn
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(s.skipped).toBe(1)
    expect(s.cutoff).toBe(0)
    expect(s.failed).toBe(0)
    expect(warn).not.toHaveBeenCalled()
    // Метку снимаем всё равно — иначе холостой ход повторялся бы вечно.
    expect(clearMark).toHaveBeenCalledWith('M1')
  })

  it('отказ снятия метки НЕ выдаётся за неудачное отключение', async () => {
    // Отключение уже состоялось; повтор в следующий прогон идемпотентен и уйдёт в `skipped`.
    const s = await runSubscriptionCutoff(deps({
      countDue: async () => 1,
      selectDue: async () => [due('M1', 30)],
      disconnectBanks: async () => 2,
      clearMark: async () => { throw new Error('база молчит') }
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(s.cutoff).toBe(1)
    expect(s.failed).toBe(0)
  })

  it('граница уходит в SQL готовой — база не знает про политику', async () => {
    const seen: number[] = []
    await runSubscriptionCutoff(deps({
      countDue: async (b) => {
        seen.push(b)
        return 0
      },
      selectDue: async (b) => {
        seen.push(b)
        return []
      }
    }), SUBSCRIPTION_CUTOFF_DAYS)
    expect(seen[0]).toBe(NOW - SUBSCRIPTION_CUTOFF_DAYS * DAY)
  })
})
