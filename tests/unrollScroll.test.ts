import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { unrollScrollContainers } from '../scripts/lib/unrollScroll.mjs'

// Раскатка внутренних скроллеров перед fullPage-снимком (#630).
//
// ⚠ Единственным «покрытием» у неё была живая страница `/settings`, которой хватает ОДНОГО
// прохода. То есть многопроходный цикл — та самая часть, ради которой он и написан («расфиксировав
// предка, ниже может обнаружиться следующий скроллер») — не проверялся ничем (находка ревью).
//
// ⚠ Настоящего DOM тут не нужно и он бы ВРЕДИЛ: happy-dom не считает раскладку, `scrollHeight`
// и `clientHeight` у него нули, поэтому «тест» проходил бы при любой реализации. Фейковое дерево
// задаёт размеры явно — то есть проверяет ровно решения функции, а не движок.

interface FakeEl {
  tagName: string
  className: string
  clientHeight: number
  scrollHeight: number
  parentElement: FakeEl | null
  style: { setProperty: (k: string, v: string, p?: string) => void }
  css: Record<string, string>
  applied: Record<string, string>
}

function el(over: Partial<FakeEl> & { css?: Record<string, string> } = {}): FakeEl {
  const node: FakeEl = {
    tagName: 'DIV',
    className: '',
    clientHeight: 100,
    scrollHeight: 100,
    parentElement: null,
    css: { overflowY: 'visible', overflowX: 'visible', position: 'static', ...(over.css ?? {}) },
    applied: {},
    style: { setProperty: (k, v) => {
      node.applied[k] = v
      // Браузер применяет стиль к вычисленному — фейк обязан вести себя так же, иначе цикл
      // «нашли скроллер → сняли overflow» никогда не сходился бы и тест проверял бы не то.
      if (k === 'overflow-y') node.css.overflowY = v
      if (k === 'overflow-x') node.css.overflowX = v
      if (k === 'position') node.css.position = v
      if (k === 'height' || k === 'max-height') node.scrollHeight = node.clientHeight
    } },
    ...over
  }
  return node
}

/**
 * ⚠ Ключевая деталь браузера, которую фейк ОБЯЗАН воспроизводить: если `overflow-x` не
 * `visible`/`clip`, заданный `overflow-y: visible` пересчитывается обратно в `auto`. Без этого
 * правила тест не отличил бы работающую реализацию от no-op.
 */
function computed(node: FakeEl): Record<string, string> {
  const oy = node.css.overflowY === 'visible' && !/visible|clip/.test(node.css.overflowX ?? 'visible')
    ? 'auto'
    : node.css.overflowY
  return { ...node.css, overflowY: oy }
}

function run(nodes: FakeEl[]) {
  const g = globalThis as unknown as Record<string, unknown>
  const prevDoc = g.document
  const prevCs = g.getComputedStyle
  g.document = {
    querySelectorAll: () => nodes,
    documentElement: { },
    scrollingElement: { scrollHeight: 1234 }
  }
  g.getComputedStyle = (n: FakeEl) => computed(n)
  try {
    return unrollScrollContainers()
  } finally {
    g.document = prevDoc
    g.getComputedStyle = prevCs
  }
}

const scroller = (over: Partial<FakeEl> = {}) =>
  el({ clientHeight: 100, scrollHeight: 900, css: { overflowY: 'auto' }, ...over })

describe('раскатка скроллеров (#630)', () => {
  it('обычный скроллер раскатывается, и ничего не остаётся', () => {
    const r = run([scroller()])
    expect(r.scrollers).toBe(1)
    expect(r.left).toEqual([])
    expect(r.clipped).toEqual([])
  })

  it('снимаются ОБА ограничителя высоты — и max-height, и height', () => {
    // ⚠ Контейнер бывает зажат любым из двух. Сняв только `max-height`, мы получили бы элемент с
    // `overflow-y: visible` (значит ни скроллер, ни обрезанный — гард молчит), содержимое
    // которого всё равно вылезает за коробку и налезает на соседей.
    const n = scroller()
    run([n])
    expect(Object.keys(n.applied).sort()).toContain('height')
    expect(Object.keys(n.applied).sort()).toContain('max-height')
  })

  it('⚠ скроллер с `overflow-x: hidden` тоже раскатывается — иначе правка была бы no-op', () => {
    // Спецификация CSS: при `overflow-x` не `visible`/`clip` заданный `overflow-y: visible`
    // пересчитывается обратно в `auto`. b24ui поставляет слоты ровно с такой парой, и без ветки
    // «поставить overflow-x: clip» первый же такой контейнер дал бы ВЕЧНО красный тест.
    const n = scroller({ css: { overflowY: 'auto', overflowX: 'hidden' } })
    const r = run([n])
    expect(n.applied['overflow-x'], 'горизонталь обязана стать clip, а не visible').toBe('clip')
    expect(r.left).toEqual([])
  })

  it('горизонтальную прокрутку у НЕскроллера не трогаем', () => {
    // Широкая таблица без вертикального переполнения — не наше дело: раскатав её, мы растянули бы
    // страницу вширь и поменяли эталон там, где ничего не чинили.
    const wide = el({ css: { overflowX: 'auto' }, clientHeight: 100, scrollHeight: 100 })
    run([wide])
    expect(wide.applied).toEqual({})
  })

  it('fixed-предок расфиксируется', () => {
    const shell = el({ css: { position: 'fixed' } })
    const inner = scroller({ parentElement: shell })
    const r = run([shell, inner])
    expect(shell.applied.position).toBe('static')
    expect(r.unfixed).toBe(1)
  })

  it('⚠ второй скроллер, проявившийся ПОСЛЕ расфиксации, тоже раскатывается', () => {
    // Ради этого и написан многопроходный цикл — и ровно это не проверялось ничем.
    const shell = el({ css: { position: 'fixed' } })
    const outer = scroller({ parentElement: shell })
    const inner = el({ clientHeight: 50, scrollHeight: 400, parentElement: outer, css: { overflowY: 'visible' } })
    const nodes = [shell, outer, inner]
    const g = globalThis as unknown as Record<string, unknown>
    const prevDoc = g.document
    const prevCs = g.getComputedStyle
    g.document = { querySelectorAll: () => nodes, documentElement: {}, scrollingElement: { scrollHeight: 1 } }
    g.getComputedStyle = (n: FakeEl) => {
      // Внутренний становится скроллером ТОЛЬКО после того, как расфиксировали оболочку.
      if (n === inner && shell.css.position === 'static') return { ...computed(n), overflowY: 'auto' }
      return computed(n)
    }
    try {
      const r = unrollScrollContainers()
      expect(r.scrollers, 'второй проход обязан подхватить проявившийся скроллер').toBe(2)
      expect(r.left).toEqual([])
    } finally {
      g.document = prevDoc
      g.getComputedStyle = prevCs
    }
  })

  it('обрезанный элемент ПОПАДАЕТ в отчёт и НЕ правится', () => {
    // Это тот случай, что ловит забытую расфиксацию предка: `overflow: hidden` переполнение не
    // покажет и прокрутить себя не даст.
    const clipped = el({ clientHeight: 100, scrollHeight: 900, css: { overflowY: 'hidden' }, className: 'shell' })
    const r = run([clipped])
    expect(r.clipped).toHaveLength(1)
    expect(r.clipped[0]).toContain('100/900')
    expect(clipped.applied, 'обрезанный чиним не мы — о нём сообщаем').toEqual({})
  })

  it('отчёт НАЗЫВАЕТ застрявшее, а не считает', () => {
    // Голое «остался 1 контейнер» отправляет следующего человека воспроизводить измерение с нуля.
    const stuck = el({ clientHeight: 10, scrollHeight: 99, className: 'stuck-one', css: { overflowY: 'scroll', overflowX: 'scroll' } })
    // `setProperty` фейка честно применяет значения, но правило overflow-x возвращает `auto`,
    // если горизонталь осталась прокручиваемой — здесь она станет `clip`, так что элемент
    // раскатается; берём вместо него заведомо неподатливый.
    stuck.style.setProperty = () => {}
    const r = run([stuck])
    expect(r.left).toHaveLength(1)
    expect(r.left[0]).toContain('stuck-one')
    expect(r.left[0]).toContain('10/99')
  })
})

describe('оба потребителя берут ОДИН модуль', () => {
  it('раскатка не разъезжается между регресс-тестом и ручным скриншотом', () => {
    // ⚠ Форма гарда — как у `priorResourceHeadersChokePoint`/`paymentListParamsChokePoint`: смысл
    // общего модуля в том, что «посмотрел глазами» отвечает на тот же вопрос, что и CI. Заведёт
    // кто-нибудь вторую копию раскатки — расхождение вернётся молча.
    const root = join(import.meta.dirname, '..')
    const spec = readFileSync(join(root, 'tests', 'visual', 'pages.spec.ts'), 'utf8')
    const manual = readFileSync(join(root, 'scripts', 'screenshot.mjs'), 'utf8')
    for (const [name, text] of [['pages.spec.ts', spec], ['screenshot.mjs', manual]] as const) {
      expect(text, `${name}: раскатка берётся не из общего модуля`)
        .toMatch(/import \{ unrollScrollContainers \} from '.*lib\/unrollScroll\.mjs'/)
      expect(text, `${name}: результат раскатки не читается`).toContain('unrollScrollContainers)')
    }
  })
})
