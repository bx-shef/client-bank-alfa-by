import { describe, expect, it, vi } from 'vitest'
import { beatOnce, startWorkerBeat } from '../server/utils/workerBeat'
import { WORKER_BEAT_INTERVAL_MS, WORKER_BEAT_TTL_SEC } from '../app/utils/workerHeartbeat'

// ⚠ Планировщик вынесен из плагина РАДИ ЭТОГО ФАЙЛА. Ревью показало, что внутри
// `defineNitroPlugin` пульс можно было завести на пустой колбэк — таймер создан, `randomUUID`
// вызван, `.catch` на месте, — и весь набор тестов оставался зелёным, хотя в Redis не уходило
// ничего. Проверка «функция упомянута в исходнике» такое не ловит принципиально.

describe('beatOnce', () => {
  it('пишет отметку, когда воркеры работают', () => {
    const marks: Array<[string, number, number]> = []
    const ok = beatOnce('id-1', {
      running: () => true,
      mark: async (id, ttl, now) => { marks.push([id, ttl, now]) },
      now: () => 1000
    })
    expect(ok).toBe(true)
    expect(marks).toEqual([['id-1', WORKER_BEAT_TTL_SEC, 1000]])
  })

  it('МОЛЧИТ, когда ни один воркер не работает', () => {
    // ⚠ Ровно та дыра, за которую отвергнут `getWorkers()` BullMQ: голый таймер доказывал бы лишь,
    // что жив event loop. Закрытые или поставленные на паузу воркеры при живом процессе не должны
    // выглядеть здоровыми — иначе пульс врёт именно там, ради чего заведён.
    const marks: string[] = []
    const ok = beatOnce('id-1', {
      running: () => false,
      mark: async (id) => {
        marks.push(id)
      }
    })
    expect(ok).toBe(false)
    expect(marks, 'пульс отметился при неработающих воркерах').toEqual([])
  })

  it('сбой записи ГЛОТАЕТСЯ и не всплывает наружу', async () => {
    // ⚠ `void promise.catch(fn)`, где `fn` бросает, даёт unhandled rejection, а глобального
    // обработчика в проекте нет — на современном Node это валит воркер ровно на том сетевом блипе,
    // который пульс и должен пережить.
    const warned: string[] = []
    expect(() => beatOnce('id-1', {
      running: () => true,
      mark: async () => { throw new Error('ECONNREFUSED') },
      warn: m => warned.push(m)
    })).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
    expect(warned.join('\n')).toMatch(/worker beat failed/)
  })
})

describe('startWorkerBeat', () => {
  it('бьёт СРАЗУ и дальше по интервалу', () => {
    vi.useFakeTimers()
    try {
      const marks: number[] = []
      const timer = startWorkerBeat('id-1', {
        running: () => true,
        mark: async () => { marks.push(1) }
      })
      expect(marks.length, 'первого удара не было — дыра до конца первого интервала').toBe(1)
      vi.advanceTimersByTime(WORKER_BEAT_INTERVAL_MS * 3)
      expect(marks.length, 'таймер заведён, но колбэк не вызывается').toBe(4)
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })

  it('таймер ВОЗВРАЩАЕТСЯ — вызывающий обязан его снять', () => {
    // ⚠ `unref()` не отменяет таймер, а лишь не даёт держать процесс. Не сняв его в `close`, мы
    // даём удару сработать уже после `closeQueues()` — и он пересоздаст очередь и НОВОЕ соединение
    // с Redis, которое никто не закроет.
    vi.useFakeTimers()
    try {
      const timer = startWorkerBeat('id-1', { running: () => false, mark: async () => {} })
      expect(timer, 'таймер не возвращён — снять его неоткуда').toBeTruthy()
      clearInterval(timer)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('проводка снятия таймера', () => {
  it('плагин снимает пульс в close-хуке', async () => {
    // Структурно — но здесь это оправдано: снятие живёт в хуке Nitro, вызвать который без запуска
    // сервера нельзя. Поведение самого планировщика проверено выше вызовом.
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../server/plugins/queue.ts', import.meta.url), 'utf8')
    const hook = src.slice(src.indexOf('hooks.hook(\'close\''))
    expect(hook.slice(0, 600), 'beatTimer не снимается — таймер переживёт closeQueues()')
      .toContain('clearInterval(beatTimer)')
  })
})
