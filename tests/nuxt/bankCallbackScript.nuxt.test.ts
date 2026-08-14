import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Behavioural tests for `public/bank-callback.js` — the countdown on the page the bank redirects
// the account holder to.
//
// This file is a blind spot by construction: everything under `public/**` is excluded from ESLint
// and never type-checked, and the server-side test can only assert that the HTML *references* the
// script. So until now the only thing standing between a typo and a broken countdown on a
// customer-facing page was a reviewer's eyes. It carries real branching — two guards, a captured
// string, and a deliberate ordering of «restore the text, THEN try to close» — and each branch is
// cheap to exercise: read the file, seed a DOM, run it, drive fake timers.

const SRC = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'bank-callback.js'), 'utf8')
const MANUAL = 'Можно закрыть эту вкладку.'

function seed(html: string): void {
  document.body.innerHTML = html
}

function run(): void {
  // Executed the same way the browser would: as a standalone script over the current document.
  new Function(SRC)()
}

let closeSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  closeSpy = vi.fn()
  Object.defineProperty(window, 'close', { value: closeSpy, writable: true, configurable: true })
})

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('public/bank-callback.js', () => {
  it('считает вниз и закрывает вкладку — но текст возвращает ДО закрытия', () => {
    seed(`<p id="close-hint" data-seconds="3">${MANUAL}</p>`)
    run()
    const hint = document.getElementById('close-hint')!
    expect(hint.textContent).toContain('через 3')

    vi.advanceTimersByTime(1000)
    expect(hint.textContent).toContain('через 2')
    vi.advanceTimersByTime(1000)
    expect(hint.textContent).toContain('через 1')

    vi.advanceTimersByTime(1000)
    expect(closeSpy).toHaveBeenCalledTimes(1)
    // ⚠ Порядок принципиален и потому проверяется: закрыть браузер разрешает только вкладку,
    // открытую скриптом. Ссылку часто передают владельцу счёта, он открывает её руками — close()
    // молча не сработает, и на экране должна остаться верная подсказка, а не «через 0 с».
    expect(hint.textContent).toBe(MANUAL)

    // И таймер обязан быть снят: иначе close() звался бы каждую секунду до конца жизни вкладки.
    vi.advanceTimersByTime(5000)
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('«Отменить» останавливает отсчёт навсегда — вкладку у читающего не отнимут', () => {
    seed(`<p id="close-hint" data-seconds="5">${MANUAL}</p>`)
    run()
    const hint = document.getElementById('close-hint')!
    hint.querySelector('button')!.click()

    expect(hint.textContent).toBe(MANUAL)
    vi.advanceTimersByTime(60_000)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  it.each([
    ['без крючка вовсе', '<p>нет такого элемента</p>'],
    ['без data-seconds', `<p id="close-hint">${MANUAL}</p>`],
    ['с нулём секунд', `<p id="close-hint" data-seconds="0">${MANUAL}</p>`],
    ['с мусором вместо числа', `<p id="close-hint" data-seconds="скоро">${MANUAL}</p>`]
  ])('%s — тихий no-op, страница не трогается и не закрывается', (_name, html) => {
    seed(html)
    const before = document.body.innerHTML
    run()
    expect(document.body.innerHTML).toBe(before)
    vi.advanceTimersByTime(60_000)
    expect(closeSpy).not.toHaveBeenCalled()
  })
})
