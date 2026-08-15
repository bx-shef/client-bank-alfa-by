import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  keepAlivePulse, keepAliveStartedAt, markKeepAliveStarted, recordKeepAlivePulse, resetKeepAlivePulse
} from '../server/utils/keepAliveState'
import { runKeepAliveTick } from '../server/utils/keepAliveTick'
import type { KeepAlivePulseSummary } from '../app/utils/keepAlivePulse'

// Пульс продления банковских токенов (#504). Модуль держит СОСТОЯНИЕ ПРОЦЕССА, поэтому сброс перед
// каждым тестом обязателен — иначе тесты начнут зависеть от порядка запуска.

const NOW = 1_700_000_000_000

const summary = (over: Partial<KeepAlivePulseSummary> = {}): KeepAlivePulseSummary => ({
  selected: 2, refreshed: 2, skipped: 0, failed: 0, unrefreshable: 0, expired: 0, ...over
})

beforeEach(() => resetKeepAlivePulse())

describe('keepAliveState', () => {
  it('в свежем процессе пульса нет — это «ещё не было прогонов», а не «всё хорошо»', () => {
    expect(keepAlivePulse()).toBeNull()
    expect(keepAliveStartedAt()).toBeNull()
  })

  it('записанный прогон читается обратно', () => {
    recordKeepAlivePulse(summary({ refreshed: 3 }), NOW)
    expect(keepAlivePulse()).toEqual({ atMs: NOW, summary: summary({ refreshed: 3 }) })
  })

  it('КОПИРУЕТ сводку, а не хранит ссылку на неё', () => {
    // Иначе вызывающий, переиспользующий свой объект между прогонами, задним числом переписал бы
    // уже записанный пульс — и на экране появились бы числа, которых в том прогоне не было.
    const s = summary()
    recordKeepAlivePulse(s, NOW)
    s.refreshed = 999
    expect(keepAlivePulse()?.summary.refreshed).toBe(2)
  })

  it('ОТДАЁТ копию — читатель не может переписать хранимое', () => {
    recordKeepAlivePulse(summary(), NOW)
    const got = keepAlivePulse()!
    got.summary.refreshed = 999
    expect(keepAlivePulse()?.summary.refreshed).toBe(2)
  })

  it('следующий прогон вытесняет предыдущий', () => {
    recordKeepAlivePulse(summary({ refreshed: 1 }), NOW)
    recordKeepAlivePulse(summary({ refreshed: 5 }), NOW + 60_000)
    expect(keepAlivePulse()).toEqual({ atMs: NOW + 60_000, summary: summary({ refreshed: 5 }) })
  })

  it('метка старта таймера пишется и читается', () => {
    markKeepAliveStarted(NOW)
    expect(keepAliveStartedAt()).toBe(NOW)
  })

  it('сброс обнуляет И пульс, И метку старта', () => {
    // Метка забытая при сбросе превратила бы «прогонов не было» в вечную тревогу между тестами.
    recordKeepAlivePulse(summary(), NOW)
    markKeepAliveStarted(NOW)
    resetKeepAlivePulse()
    expect(keepAlivePulse()).toBeNull()
    expect(keepAliveStartedAt()).toBeNull()
  })
})

describe('runKeepAliveTick — пульс только на ЗАВЕРШЁННОМ прогоне', () => {
  it('прогон удался — пульс записан', async () => {
    const record = vi.fn()
    const ok = await runKeepAliveTick({
      run: async () => summary({ refreshed: 4 }),
      record, now: () => NOW, error: () => {}
    })
    expect(ok).toBe(true)
    expect(record).toHaveBeenCalledWith(summary({ refreshed: 4 }), NOW)
  })

  it('ПРОГОН УПАЛ — пульс НЕ записан, и это весь смысл фичи', async () => {
    // ⚠ Упавший скан не сердцебиение. Отметить его значило бы гасить ровно ту тревогу, ради
    // которой пульс заведён: сервис молчал бы «всё хорошо», пока продление падает на каждом тике.
    const record = vi.fn()
    const errors: string[] = []
    const ok = await runKeepAliveTick({
      run: async () => { throw new Error('ECONNREFUSED') },
      record, now: () => NOW, error: m => errors.push(m)
    })
    expect(ok).toBe(false)
    expect(record).not.toHaveBeenCalled()
    expect(errors.join('')).toContain('bank keep-alive run failed')
  })

  it('падение не пробрасывается — крон-инстанс переживает своё обслуживание', async () => {
    await expect(runKeepAliveTick({
      run: async () => { throw new Error('boom') },
      record: () => {}, now: () => NOW, error: () => {}
    })).resolves.toBe(false)
  })

  it('сквозной путь: упавший прогон оставляет состояние пустым', async () => {
    await runKeepAliveTick({
      run: async () => { throw new Error('down') },
      record: recordKeepAlivePulse, now: () => NOW, error: () => {}
    })
    expect(keepAlivePulse()).toBeNull()
  })
})
