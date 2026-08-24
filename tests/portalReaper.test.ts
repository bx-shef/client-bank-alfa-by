import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REAP_DAYS,
  isGrantDead,
  MAX_REAP_PER_RUN,
  MIN_REAP_DAYS,
  reaperLogLine,
  reapVerdict,
  resolveReapDays
} from '~/utils/portalReaper'
import { runPortalReaper, type PortalReaperDeps } from '../server/utils/portalReaperRun'

// Уборщик мёртвых порталов (#574).
//
// ⚠ Это ЕДИНСТВЕННЫЙ механизм в приложении, который стирает данные клиента без его действия, и
// откатить его нельзя. Поэтому тесты здесь проверяют не «работает ли уборка», а «не сработает ли
// она там, где не должна»: сигнал узкий, порог не занижается, потолок держит, а расхождение
// выборки с правилом останавливает удаление.

describe('isGrantDead — сигнал УЖЕ, чем у соседей, и это намеренно', () => {
  it('мёртвый грант — только invalid_grant', () => {
    expect(isGrantDead('invalid_grant')).toBe(true)
  })

  it('коды, которые `verifyInstallMember` считает отказом гранта, здесь НЕ считаются', () => {
    // ⚠ Там ошибка в сторону «не смогли проверить» безопасна — установка просто не запишется.
    // Здесь направление обратное: ошибка классификации стирает данные живого клиента.
    expect(isGrantDead('invalid_token')).toBe(false)
    expect(isGrantDead('expired_token')).toBe(false)
  })

  it('истёкший триал — НЕ повод стирать: клиент жив, просто не платит', () => {
    expect(isGrantDead('PAYMENT_REQUIRED')).toBe(false)
  })

  it('«не смогли спросить» — не «нам отказали»', () => {
    for (const code of ['', 'wrong_client', 'ETIMEDOUT', 'ECONNRESET', 'QUERY_LIMIT_EXCEEDED']) {
      expect(isGrantDead(code), code || '(пусто)').toBe(false)
    }
  })
})

describe('resolveReapDays — порог можно только ПОДНЯТЬ', () => {
  it('пусто/мусор/ноль дают умолчание, а не немедленное стирание', () => {
    // ⚠ `Number('')` это 0: без явной ветки опечатка в переменной окружения означала бы «стирать
    // сразу», то есть самый дорогой возможный промах.
    for (const raw of [undefined, '', '   ', 'abc', '0', '-5', 'NaN']) {
      expect(resolveReapDays(raw), String(raw)).toBe(DEFAULT_REAP_DAYS)
    }
  })

  it('занизить ниже пола НЕЛЬЗЯ никакой настройкой', () => {
    expect(resolveReapDays('1')).toBe(MIN_REAP_DAYS)
    expect(resolveReapDays('13')).toBe(MIN_REAP_DAYS)
  })

  it('поднять можно — это безвредно', () => {
    expect(resolveReapDays('90')).toBe(90)
    expect(resolveReapDays('45.9'), 'дробное усекается вниз').toBe(45)
  })
})

describe('reapVerdict', () => {
  const DAY = 86_400_000
  const now = 1_800_000_000_000

  it('без отметки портал ЖИВ', () => {
    expect(reapVerdict(0, now, 30)).toBe('alive')
    expect(reapVerdict(null, now, 30)).toBe('alive')
    expect(reapVerdict(undefined, now, 30)).toBe('alive')
  })

  it('срок не вышел — ждём', () => {
    expect(reapVerdict(now - 29 * DAY, now, 30)).toBe('too-early')
  })

  it('срок вышел — стираем (граница включительно)', () => {
    expect(reapVerdict(now - 30 * DAY, now, 30)).toBe('reap')
    expect(reapVerdict(now - 31 * DAY, now, 30)).toBe('reap')
  })

  it('метка из БУДУЩЕГО даёт отсрочку, а не досрочное удаление', () => {
    // Часы двух инстансов могут разъехаться; ошибаться надо в сторону «подержим дольше».
    expect(reapVerdict(now + 5 * DAY, now, 30)).toBe('too-early')
  })
})

const DAY = 86_400_000
const NOW = 1_800_000_000_000

function deps(over: Partial<PortalReaperDeps> = {}): PortalReaperDeps {
  return {
    now: () => NOW,
    countRevoked: async () => 0,
    selectReapable: async () => [],
    deletePortal: vi.fn(async () => {}),
    ...over
  }
}

describe('runPortalReaper', () => {
  it('стирает ТЕМ ЖЕ путём, что штатное удаление, и меткой времени в СЕКУНДАХ', async () => {
    // ⚠ Секунды — как у события Б24: тумбстоун пишет тот же `deleteToken`, и «сейчас» верно,
    // потому что настоящая переустановка произойдёт позже и её событие будет новее.
    const deletePortal = vi.fn(async () => {})
    const r = await runPortalReaper(deps({
      countRevoked: async () => 1,
      selectReapable: async () => [{ memberId: 'M1', revokedAtMs: NOW - 40 * DAY }],
      deletePortal
    }), 30)
    expect(r.reaped).toBe(1)
    expect(deletePortal).toHaveBeenCalledWith('M1', Math.floor(NOW / 1000))
  })

  it('РАСХОЖДЕНИЕ выборки и правила ОСТАНАВЛИВАЕТ удаление', async () => {
    // ⚠ Несущее. Правило живёт и в SQL-условии выборки, и в чистой функции; если они разойдутся
    // (правку внесли в одно место), удаление необратимо. Вторая проверка ловит это ДО удаления.
    const deletePortal = vi.fn(async () => {})
    const warn = vi.fn()
    const r = await runPortalReaper(deps({
      countRevoked: async () => 1,
      // Выборка «ошиблась»: метка свежая, а строка пришла.
      selectReapable: async () => [{ memberId: 'M1', revokedAtMs: NOW - 2 * DAY }],
      deletePortal,
      warn
    }), 30)
    expect(deletePortal, 'живой портал НЕ должен быть стёрт').not.toHaveBeenCalled()
    expect(r.reaped).toBe(0)
    expect(r.failed).toBe(1)
    expect(warn.mock.calls.some(c => String(c[0]).includes('разошлись'))).toBe(true)
  })

  it('потолок за прогон соблюдается и объявляется', async () => {
    // ⚠ Потолок не про нагрузку, а про класс ошибок: если классификатор однажды сочтёт мёртвым
    // живое, катастрофа «снесли всех за тик» превращается в «снесли троих, и это видно».
    const rows = Array.from({ length: MAX_REAP_PER_RUN }, (_, i) => ({ memberId: `M${i}`, revokedAtMs: NOW - 40 * DAY }))
    const log = vi.fn()
    const r = await runPortalReaper(deps({
      countRevoked: async () => 99,
      selectReapable: async (_b, limit) => rows.slice(0, limit),
      log
    }), 30)
    expect(r.reaped).toBe(MAX_REAP_PER_RUN)
    expect(r.capped).toBe(true)
    expect(String(log.mock.calls[0]?.[0])).toContain('не больше')
  })

  it('отказ ОДНОГО удаления не отменяет остальные', async () => {
    const deletePortal = vi.fn(async (memberId: string) => {
      if (memberId === 'M1') throw new Error('база молчит')
    })
    const r = await runPortalReaper(deps({
      countRevoked: async () => 2,
      selectReapable: async () => [
        { memberId: 'M1', revokedAtMs: NOW - 40 * DAY },
        { memberId: 'M2', revokedAtMs: NOW - 40 * DAY }
      ],
      deletePortal
    }), 30)
    expect(r.reaped).toBe(1)
    expect(r.failed).toBe(1)
    expect(deletePortal).toHaveBeenCalledTimes(2)
  })

  it('КАЖДОЕ удаление уходит отдельной громкой строкой, а не только числом', async () => {
    // Если оно однажды сработает не на том портале, узнать, на каком именно, надо будет из лога.
    const warn = vi.fn()
    await runPortalReaper(deps({
      countRevoked: async () => 1,
      selectReapable: async () => [{ memberId: 'M1', revokedAtMs: NOW - 40 * DAY }],
      warn
    }), 30)
    expect(warn.mock.calls.some(c => String(c[0]).includes('M1') && String(c[0]).includes('стёрт'))).toBe(true)
  })

  it('стирать нечего — строка в логе ВСЁ РАВНО есть', async () => {
    // Уборщик, который молчит, неотличим от невзведённого.
    const log = vi.fn()
    const r = await runPortalReaper(deps({ log }), 30)
    expect(r).toEqual({ candidates: 0, reaped: 0, capped: false, failed: 0 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('граница передаётся в выборку СЧИТАННОЙ, а не в виде часов', async () => {
    // База не должна знать про политику, а тест — подсовывать в неё время.
    const selectReapable = vi.fn(async () => [])
    await runPortalReaper(deps({ selectReapable }), 30)
    expect(selectReapable).toHaveBeenCalledWith(NOW - 30 * DAY, MAX_REAP_PER_RUN)
  })
})

describe('reaperLogLine', () => {
  it('называет порог — иначе по строке не понять, чем руководствовались', () => {
    expect(reaperLogLine(0, 0, false, 30)).toContain('30 дн.')
  })

  it('про потолок говорит только когда в него упёрлись', () => {
    expect(reaperLogLine(9, 3, true, 30)).toContain('не больше')
    expect(reaperLogLine(3, 3, false, 30)).not.toContain('не больше')
  })
})
