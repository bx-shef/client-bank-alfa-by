import { afterEach, describe, expect, it, vi } from 'vitest'

// Поведенческий тест пульса воркеров (#466 §1) — по образцу `claimCooldownSlot.test.ts`.
//
// ⚠ Заведён потому, что ревью прошло насквозь греп-версию: подмена `Set` на массив (потеря дедупа)
// и вообще любая порча тела функции оставляли все тесты зелёными, пока в исходнике оставалась
// подстрока `scan(`. Проверка присутствия слова — не проверка функции.
//
// ⚠ Дедуп не косметика: `SCAN` МОЖЕТ вернуть один и тот же ключ на разных страницах курсора — это
// свойство самого Redis, а не крайний случай. Без `Set` один живой воркер считался бы за нескольких,
// то есть счётчик врал бы в сторону «всё хорошо» — ровно в ту, которая гасит тревогу.
process.env.REDIS_URL = 'redis://localhost:6379'

let pages: Array<[string, string[]]> = []
let scanCalls: unknown[][] = []
let scanFails = false

vi.mock('bullmq', () => ({
  Queue: class {
    getBackend(): { client: Promise<{ scan: (...a: unknown[]) => Promise<[string, string[]]> }> } {
      return {
        client: Promise.resolve({
          scan: (...args: unknown[]) => {
            scanCalls.push(args)
            if (scanFails) return Promise.reject(new Error('ECONNREFUSED'))
            return Promise.resolve(pages.shift() ?? ['0', []])
          }
        })
      }
    }

    close(): Promise<void> { return Promise.resolve() }
  }
}))

const { countLiveWorkers } = await import('../server/queue/connection')

afterEach(() => {
  pages = []
  scanCalls = []
  scanFails = false
})

describe('countLiveWorkers', () => {
  it('считает ключи со всех страниц курсора', async () => {
    pages = [['17', ['worker-beat:a', 'worker-beat:b']], ['0', ['worker-beat:c']]]
    expect(await countLiveWorkers()).toBe(3)
  })

  it('ДЕДУПЛИЦИРУЕТ: повтор ключа между страницами не задваивает счёт', async () => {
    // ⚠ Это не выдуманный случай — Redis прямо допускает повтор ключа между итерациями SCAN.
    pages = [['9', ['worker-beat:a', 'worker-beat:b']], ['0', ['worker-beat:b', 'worker-beat:c']]]
    expect(await countLiveWorkers(), 'дедуп потерян — один воркер считается за нескольких').toBe(3)
  })

  it('пустой ответ — ноль, а не срыв', async () => {
    pages = [['0', []]]
    expect(await countLiveWorkers()).toBe(0)
  })

  it('идёт SCAN с префиксом, а не по всему кейспейсу без фильтра', async () => {
    pages = [['0', []]]
    await countLiveWorkers()
    expect(scanCalls[0]).toContain('MATCH')
    expect(String(scanCalls[0])).toContain('worker-beat:')
  })

  it('ошибка Redis пробрасывается, а не выдаётся за «ноль живых»', async () => {
    // ⚠ Ключевой инвариант: «не смогли прочитать» и «воркеров нет» — разные вещи, и склеить их
    // значит поднять ложную тревогу ровно в аварию. Изоляцию делает вызывающий (тик здоровья),
    // но только если функция ЧЕСТНО падает, а не возвращает 0.
    scanFails = true
    await expect(countLiveWorkers()).rejects.toThrow(/ECONNREFUSED/)
  })
})
