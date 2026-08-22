import { describe, expect, it } from 'vitest'
import {
  handleCountErasable,
  handleEraseActivities,
  parseEraseSelection,
  MAX_ERASE_ACCOUNTS,
  type CountDeps,
  type EraseDeps
} from '../server/utils/eraseRequest'
import { SingleFlightBusyError, SingleFlightUnavailableError } from '../server/utils/singleFlightLease'

// ⚠ Действие НЕОБРАТИМО. Поэтому тут проверяется прежде всего не «работает ли», а «не может ли
// сработать не там и не для того»: гейт админа, отказ на кривом вводе (вместо тихого расширения
// отбора) и то, что подсчёт СТРУКТУРНО не умеет удалять.

const input = { accessToken: 't', domain: 'p.bitrix24.by' }

function countDeps(over: Partial<CountDeps> = {}): CountDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    count: async () => ({ count: 42, capped: false }),
    ...over
  }
}

function eraseDeps(over: Partial<EraseDeps> = {}): EraseDeps {
  return {
    memberIdByDomain: async () => 'M1',
    validateFrame: async () => ({ userId: '7', isAdmin: true }),
    erase: async () => ({ deleted: 42, remaining: 0 }),
    ...over
  }
}

describe('parseEraseSelection — кривой ввод НЕ расширяет стирание', () => {
  it('пустой ввод = «за всё время по всем счетам» (законная форма)', () => {
    expect(parseEraseSelection(input)).toEqual({ period: {}, accounts: [] })
  })

  it('кривая дата — отказ, а не молча отброшенная граница', () => {
    // ⚠ Отброшенная граница превратила бы «стереть за август» в «стереть всё».
    expect(parseEraseSelection({ ...input, from: '01.08.2026' })).toBeNull()
  })

  it('кривой номер счёта — отказ, а не пропуск', () => {
    // ⚠ Пропущенный номер превратил бы «стереть по этому счёту» в «по всем», будь он единственным.
    expect(parseEraseSelection({ ...input, accounts: ['BY01ALFA', 'не счёт'] })).toBeNull()
    expect(parseEraseSelection({ ...input, accounts: [42] })).toBeNull()
    expect(parseEraseSelection({ ...input, accounts: 'BY01ALFA' })).toBeNull()
  })

  it('пустые строки в списке отбрасываются, но список не становится «все»', () => {
    expect(parseEraseSelection({ ...input, accounts: [' BY01ALFA ', ''] })).toEqual({ period: {}, accounts: ['BY01ALFA'] })
  })

  it('слишком длинный список счетов — отказ', () => {
    const many = Array.from({ length: MAX_ERASE_ACCOUNTS + 1 }, (_, i) => `BY${i}`)
    expect(parseEraseSelection({ ...input, accounts: many })).toBeNull()
  })
})

describe('handleCountErasable — показ количества', () => {
  it('отдаёт число и признак «упёрлись в потолок»', async () => {
    const res = await handleCountErasable(countDeps({ count: async () => ({ count: 300, capped: true }) }), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ count: 300, capped: true })
  })

  it('403 для не-админа — и подсчёт не выполняется', async () => {
    let touched = false
    const deps = countDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      count: async () => {
        touched = true
        return { count: 1, capped: false }
      }
    })
    expect((await handleCountErasable(deps, input)).status).toBe(403)
    expect(touched).toBe(false)
  })

  it('403 при отвергнутом фрейм-токене, 409 если портал не установлен', async () => {
    const bad = countDeps({
      validateFrame: async () => {
        throw new Error('nope')
      }
    })
    expect((await handleCountErasable(bad, input)).status).toBe(403)
    const none = countDeps({ memberIdByDomain: async () => null })
    expect((await handleCountErasable(none, input)).status).toBe(409)
  })

  it('кривой период — 400, и до подсчёта дело не доходит', async () => {
    let touched = false
    const deps = countDeps({
      count: async () => {
        touched = true
        return { count: 1, capped: false }
      }
    })
    expect((await handleCountErasable(deps, { ...input, from: 'вчера' })).status).toBe(400)
    expect(touched).toBe(false)
  })
})

describe('handleEraseActivities — само стирание', () => {
  it('отдаёт, сколько удалено и сколько ОСТАЛОСЬ', async () => {
    const res = await handleEraseActivities(eraseDeps({ erase: async () => ({ deleted: 300, remaining: 88 }) }), input)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ deleted: 300, remaining: 88 })
  })

  it('403 для не-админа — и НИЧЕГО не удаляется', async () => {
    // Самый важный тест файла: необратимое действие затрагивает CRM всего портала.
    let touched = false
    const deps = eraseDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      erase: async () => {
        touched = true
        return { deleted: 1, remaining: 0 }
      }
    })
    expect((await handleEraseActivities(deps, input)).status).toBe(403)
    expect(touched).toBe(false)
  })

  it('кривой ввод — 400, и НИЧЕГО не удаляется', async () => {
    let touched = false
    const deps = eraseDeps({
      erase: async () => {
        touched = true
        return { deleted: 1, remaining: 0 }
      }
    })
    expect((await handleEraseActivities(deps, { ...input, to: '2026-8-1' })).status).toBe(400)
    expect((await handleEraseActivities(deps, { ...input, from: '2026-08-31', to: '2026-08-01' })).status).toBe(400)
    expect(touched).toBe(false)
  })

  it('«уже идёт» — это 503, а не авария, и в аудит не пишется', async () => {
    // ⚠ Второму вызывающему нечего делать: первый удаляет ровно те же дела. Хуже того, параллельное
    // стирание сдвигает offset-пагинацию друг другу, и часть дел молча не попала бы в список —
    // на НЕОБРАТИМОМ действии. Поэтому отказ, а не «попробуем тоже».
    const seen: number[] = []
    const deps = eraseDeps({
      erase: async () => {
        throw new SingleFlightBusyError('erase-activities:M1')
      },
      audit: e => seen.push(e.outcome.deleted)
    })
    const res = await handleEraseActivities(deps, input)
    expect(res.status).toBe(503)
    expect(String(res.body.error)).toContain('уже выполняется')
    expect(seen).toEqual([]) // ничего не стёрли — и в журнале об этом ни строки
  })

  it('наша база недоступна — 503, а не 502: это не поломка портала клиента', async () => {
    // Разведение важно для алертинга: 503 → `unavailable`, 502 → `upstream_error`.
    const deps = eraseDeps({
      erase: async () => {
        throw new SingleFlightUnavailableError('erase-activities:M1', new Error('pool'))
      }
    })
    expect((await handleEraseActivities(deps, input)).status).toBe(503)
  })

  it('прочие ошибки НЕ проглатываются — молчать о них нельзя', async () => {
    const deps = eraseDeps({
      erase: async () => {
        throw new Error('портал не ответил')
      }
    })
    await expect(handleEraseActivities(deps, input)).rejects.toThrow('портал не ответил')
  })

  it('пишет в аудит КТО и ЧТО стёр — но только после успеха', async () => {
    const seen: string[] = []
    const deps = eraseDeps({
      audit: e => seen.push(`${e.memberId}|${e.userId}|${e.outcome.deleted}|${e.selection.accounts.join(',')}`)
    })
    await handleEraseActivities(deps, { ...input, accounts: ['BY01ALFA'] })
    expect(seen).toEqual(['M1|7|42|BY01ALFA'])

    // Не-админ не должен оставлять след «стёр» — он ничего не стёр.
    seen.length = 0
    await handleEraseActivities(eraseDeps({
      validateFrame: async () => ({ userId: '9', isAdmin: false }),
      audit: e => seen.push(String(e.outcome.deleted))
    }), input)
    expect(seen).toEqual([])
  })
})
