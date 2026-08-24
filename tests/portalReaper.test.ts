import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_REAP_DAYS,
  FLEET_BREACH_MIN_PORTALS,
  fleetBreach,
  isGrantDead,
  MAX_REAP_PER_RUN,
  MIN_REAP_DAYS,
  reapDue,
  REAP_MIN_INTERVAL_MS,
  REAP_OVERFETCH,
  reaperLogLine,
  reapVerdict,
  resolveReapDays
} from '~/utils/portalReaper'
import { runPortalReaper, type PortalReaperDeps } from '../server/utils/portalReaperRun'
import { portalHash } from '../server/utils/telemetryAttributes'

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
    // По умолчанию флот большой — чтобы предохранитель не срабатывал в тестах, которые не про него.
    countPortals: async () => 1000,
    selectReapable: async () => [],
    deletePortal: vi.fn(async () => {}),
    reapEnabled: true,
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
    expect(r.diverged, 'логическая ошибка считается ОТДЕЛЬНО от отказа базы').toBe(1)
    expect(r.failed, 'база тут ни при чём').toBe(0)
    expect(warn.mock.calls.some(c => String(c[0]).includes('разошлись'))).toBe(true)
  })

  it('потолок за прогон соблюдается и объявляется', async () => {
    // ⚠ Потолок не про нагрузку, а про класс ошибок: если классификатор однажды сочтёт мёртвым
    // живое, катастрофа «снесли всех за тик» превращается в «снесли троих, и это видно».
    const rows = Array.from({ length: 99 }, (_, i) => ({ memberId: `M${i}`, revokedAtMs: NOW - 40 * DAY }))
    const log = vi.fn()
    const deletePortal = vi.fn(async () => {})
    const r = await runPortalReaper(deps({
      countRevoked: async () => 99,
      selectReapable: async (_b, limit) => rows.slice(0, limit),
      deletePortal,
      log
    }), 30)
    expect(r.reaped).toBe(MAX_REAP_PER_RUN)
    expect(deletePortal, 'сверх потолка не стираем, сколько бы строк ни отдала выборка')
      .toHaveBeenCalledTimes(MAX_REAP_PER_RUN)
    expect(r.capped).toBe(true)
    expect(String(log.mock.calls.at(-1)?.[0])).toContain('не больше')
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
    // Если оно однажды сработает не на том портале, узнать, на каком именно, надо будет из лога —
    // «стёрто 3» на этот вопрос не отвечает. Портал назван НЕОБРАТИМОЙ меткой (см. тест ниже):
    // её достаточно, чтобы отличать порталы друг от друга и сверять с телеметрией.
    const warn = vi.fn()
    await runPortalReaper(deps({
      countRevoked: async () => 1,
      selectReapable: async () => [{ memberId: 'M1', revokedAtMs: NOW - 40 * DAY }],
      warn
    }), 30)
    const said = warn.mock.calls.map(c => String(c[0])).filter(m => m.includes('стёрт'))
    expect(said, 'об удалении не сказано ничего').toHaveLength(1)
    expect(said[0]).toContain(portalHash('M1'))
  })

  it('стирать нечего — строка в логе ВСЁ РАВНО есть', async () => {
    // Уборщик, который молчит, неотличим от невзведённого.
    const log = vi.fn()
    const r = await runPortalReaper(deps({ log }), 30)
    expect(r).toEqual({ candidates: 0, reaped: 0, capped: false, failed: 0, diverged: 0, observeOnly: false, breach: false, days: 30 })
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('граница передаётся в выборку СЧИТАННОЙ, а не в виде часов', async () => {
    // База не должна знать про политику, а тест — подсовывать в неё время.
    const selectReapable = vi.fn(async () => [])
    await runPortalReaper(deps({ selectReapable }), 30)
    // ⚠ Берём с запасом сверх потолка: иначе разошедшиеся строки (они самые давние, значит первые)
    // съедали бы весь бюджет в каждом прогоне и очередь не двигалась бы никогда.
    expect(selectReapable).toHaveBeenCalledWith(NOW - 30 * DAY, MAX_REAP_PER_RUN + REAP_OVERFETCH)
  })
})

const FACTS = { candidates: 0, reaped: 0, failed: 0, diverged: 0, capped: false, observeOnly: false, breach: false, days: 30 }

describe('reaperLogLine', () => {
  it('называет порог — иначе по строке не понять, чем руководствовались', () => {
    expect(reaperLogLine(FACTS)).toContain('30 дн.')
  })

  it('про потолок говорит только когда в него упёрлись', () => {
    expect(reaperLogLine({ ...FACTS, candidates: 9, reaped: 3, capped: true })).toContain('не больше')
    expect(reaperLogLine({ ...FACTS, candidates: 3, reaped: 3 })).not.toContain('не больше')
  })

  it('ПРОВАЛЫ попадают в сводку прогона, а не только в строку по порталу', () => {
    // ⚠ Найдено ревью: `failed` не доезжал до строки итога ВООБЩЕ. Стоило потеряться строке по
    // конкретному порталу — и отказ удаления становился полностью невидимым.
    expect(reaperLogLine({ ...FACTS, candidates: 2, reaped: 1, failed: 1 })).toContain('НЕ УДАЛОСЬ')
  })

  it('наблюдение без удаления НАЗЫВАЕТ себя — иначе «стёрто 0» читается как «всё чисто»', () => {
    const line = reaperLogLine({ ...FACTS, candidates: 4, observeOnly: true })
    expect(line).toContain('ВЫКЛЮЧЕНО')
    expect(line).not.toContain('стёрто 0')
  })

  it('срабатывание предохранителя объясняет ПРИЧИНУ, а не просто молчит', () => {
    const line = reaperLogLine({ ...FACTS, candidates: 40, breach: true })
    expect(line).toContain('НИЧЕГО не стёрто')
    expect(line).toMatch(/наш|поломк/i)
  })
})

describe('reapDue — уборщик не наследует чужую частоту', () => {
  it('первый прогон разрешён', () => {
    expect(reapDue(null, NOW)).toBe(true)
  })

  it('вплотную после прогона — НЕТ', () => {
    // ⚠ Несущее. Уборщик висел на свип-тике (дефолт 30 мин, кламп от 1 мин), и потолок «3 за
    // прогон» означал до ~144 порталов в сутки. Пока частота приходит из чужой переменной,
    // потолок не ограничивает ущерб ни в каком смысле.
    expect(reapDue(NOW - 60_000, NOW)).toBe(false)
    expect(reapDue(NOW - REAP_MIN_INTERVAL_MS + 1, NOW)).toBe(false)
  })

  it('через сутки — да (граница включительно)', () => {
    expect(reapDue(NOW - REAP_MIN_INTERVAL_MS, NOW)).toBe(true)
  })

  it('часы будущего дают отсрочку, а не досрочный прогон', () => {
    expect(reapDue(NOW + REAP_MIN_INTERVAL_MS, NOW)).toBe(false)
  })
})

describe('fleetBreach — защита от ОБЩЕЙ причины', () => {
  it('на крошечном флоте доля не считается', () => {
    // «Двое из трёх» — это два ушедших клиента, а не авария.
    expect(fleetBreach(2, 3)).toBe(false)
    expect(fleetBreach(FLEET_BREACH_MIN_PORTALS - 1, FLEET_BREACH_MIN_PORTALS - 1)).toBe(false)
  })

  it('единичные смерти на живом флоте — не авария', () => {
    expect(fleetBreach(1, 100)).toBe(false)
    expect(fleetBreach(20, 100)).toBe(false)
  })

  it('заметная доля флота — авария, и это НЕ повод стирать', () => {
    expect(fleetBreach(40, 100)).toBe(true)
    expect(fleetBreach(100, 100)).toBe(true)
  })
})

describe('runPortalReaper: предохранитель и наблюдение', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ memberId: `M${i}`, revokedAtMs: NOW - 40 * DAY }))

  it('доля флота превышена ⇒ НЕ стираем НИЧЕГО и кричим', async () => {
    const deletePortal = vi.fn(async () => {})
    const warn = vi.fn()
    const r = await runPortalReaper(deps({
      countRevoked: async () => 60,
      countPortals: async () => 100,
      selectReapable: async () => many,
      deletePortal,
      warn
    }), 30)
    expect(deletePortal, 'при общей поломке не стирается НИ ОДИН портал').not.toHaveBeenCalled()
    expect(r.breach).toBe(true)
    expect(r.reaped).toBe(0)
    expect(warn.mock.calls.some(c => String(c[0]).includes('ОСТАНОВЛЕН'))).toBe(true)
  })

  it('предохранитель молчит, когда кандидатов нет вовсе', async () => {
    // Иначе пустой флот (0 из 0) сам себя объявлял бы аварией.
    const r = await runPortalReaper(deps({ countRevoked: async () => 0, countPortals: async () => 0 }), 30)
    expect(r.breach).toBe(false)
  })

  it('удаление ВЫКЛЮЧЕНО ⇒ идём ТЕМ ЖЕ путём, но без необратимого шага', async () => {
    // ⚠ Несущее. Соблазн «незачем ходить в базу, если не стираем» стоил бы того, ради чего
    // наблюдение и заведено: владелец включал бы необратимое удаление, увидев число из ДРУГОГО
    // запроса, а путь выборки впервые исполнился бы в тот прогон, который уже стирает.
    const deletePortal = vi.fn(async () => {})
    const selectReapable = vi.fn(async () => [{ memberId: 'M1', revokedAtMs: NOW - 40 * DAY }])
    const log = vi.fn()
    const r = await runPortalReaper(deps({
      reapEnabled: false,
      countRevoked: async () => 1,
      selectReapable,
      deletePortal,
      log
    }), 30)
    expect(deletePortal, 'необратимый шаг не делается').not.toHaveBeenCalled()
    expect(selectReapable, 'а путь выборки — исполняется').toHaveBeenCalled()
    expect(r).toMatchObject({ candidates: 1, reaped: 0, observeOnly: true })
    const said = log.mock.calls.map(c => String(c[0])).join('\n')
    expect(said, 'владелец должен видеть, КОГО именно').toContain(portalHash('M1'))
  })

  it('провал удаления попадает в СВОДКУ, а не только в строку по порталу', async () => {
    const r = await runPortalReaper(deps({
      countRevoked: async () => 1,
      selectReapable: async () => [{ memberId: 'M1', revokedAtMs: NOW - 40 * DAY }],
      deletePortal: vi.fn(async () => { throw new Error('база молчит') })
    }), 30)
    expect(r.failed).toBe(1)
  })

  it('member_id НЕ попадает в лог сырым — только необратимой меткой', async () => {
    // На удалении лог остаётся ЕДИНСТВЕННЫМ пережившим упоминанием связи «этот портал ↔ мы
    // держали его банковские креды»: строки из таблиц в этот момент уничтожаются.
    const warn = vi.fn()
    await runPortalReaper(deps({
      countRevoked: async () => 1,
      selectReapable: async () => [{ memberId: 'secret-member-id-42', revokedAtMs: NOW - 40 * DAY }],
      warn
    }), 30)
    const all = warn.mock.calls.map(c => String(c[0])).join('\n')
    expect(all).toContain('стёрт')
    expect(all, 'сырой member_id в логе удаления').not.toContain('secret-member-id-42')
  })
})
