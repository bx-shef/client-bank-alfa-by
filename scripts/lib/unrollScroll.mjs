// «Раскатка» внутренних скроллеров перед fullPage-снимком (#630).
//
// ⚠ ЗАЧЕМ. `page.screenshot({ fullPage: true })` снимает ДОКУМЕНТ, а на in-portal-страницах документ
// не растёт вовсе: b24ui-оболочка прибита к вьюпорту, прокручивается внутренний контейнер. Разбор,
// замеры и то, что покрытием так и не стало, — в `docs/VISUAL_VERIFICATION.md`; здесь их НЕ
// дублируем (проект уже дважды ловил разошедшуюся копию замера).
//
// ⚠ ОДИН МОДУЛЬ НА ДВА ПОТРЕБИТЕЛЯ — регресс-тест и ручной `pnpm screenshot`. Расходясь, они
// отвечают на разные вопросы, и «посмотрел глазами» перестаёт что-либо говорить о том, что
// проверит CI.
//
// ⚠ ПОЧЕМУ НЕ СЕЛЕКТОРОМ ПО КЛАССАМ. `fixed inset-0` приходит из темы b24ui, а не из нашей
// разметки. Правило `.fixed.inset-0 { position: static }` молча перестало бы работать на апгрейде
// темы — то есть покрытие снова тихо съёжилось бы до первого экрана. Ищем скроллеры по
// ВЫЧИСЛЕННОМУ стилю и по факту переполнения, расфиксируем ровно мешающих предков.
//
// ⚠ САМОПРОВЕРКА — не украшение, а весь смысл. Функция возвращает `left`/`clipped`, и вызывающий
// обязан на них реагировать: без этого следующая перестройка оболочки вернула бы прежний дефект
// тем же способом, каким он и появился — молча и с зелёным CI.

/**
 * Исполняется В БРАУЗЕРЕ (сериализуется Playwright'ом), поэтому без импортов и без TypeScript.
 *
 * @returns {{ scrollers: number, unfixed: number, left: string[], clipped: string[], doc: number }}
 */
export function unrollScrollContainers() {
  /** Как назвать элемент в отчёте, чтобы по красному тесту было видно, ЧТО застряло. */
  const describe = e => `${e.tagName}.${String(e.className || '').slice(0, 60)} `
    + `${e.clientHeight}/${e.scrollHeight}`
  const all = () => Array.prototype.slice.call(document.querySelectorAll('*'))
  /** Вертикальный скроллер: сам прокручивается И реально переполнен. */
  const isScroller = (e) => {
    const cs = getComputedStyle(e)
    return /auto|scroll/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2
  }
  /** Обрезанный элемент: содержимое не влезает, а прокрутить его нельзя. */
  const isClipped = (e) => {
    const cs = getComputedStyle(e)
    return /hidden|clip/.test(cs.overflowY) && e.scrollHeight > e.clientHeight + 2
  }

  const log = { scrollers: 0, unfixed: 0 }
  // Проходов несколько: расфиксировав предка, мы меняем раскладку, и ниже может обнаружиться
  // следующий скроллер. Потолок — чтобы патологический случай не крутился вечно; выход из него
  // штатный, его поймает проверка `left` у вызывающего.
  for (let pass = 0; pass < 5; pass++) {
    const found = all().filter(isScroller)
    if (!found.length) break
    for (const e of found) {
      // ⚠ `overflow-x` трогаем ТОЛЬКО чтобы разблокировать `overflow-y`, и только когда он мешает.
      // По спецификации CSS, если `overflow-x` не `visible`/`clip`, заданный `overflow-y: visible`
      // ПРИНУДИТЕЛЬНО пересчитывается обратно в `auto` — то есть на таком элементе наша правка была
      // бы no-op при любом `!important`. Замерено в Chromium этого репозитория: с
      // `overflow-x: hidden` вычисленный `overflow-y` остаётся `auto`, с `overflow-x: clip` —
      // становится `visible`. b24ui поставляет несколько слотов ровно с `overflow-x-hidden
      // overflow-y-auto`, так что случай не гипотетический: без этой ветки первый же такой
      // скроллер на снимаемой странице дал бы ВЕЧНО красный тест, который нечем починить.
      // ⚠ Ставим `clip`, а НЕ `visible`: горизонтальное обрезание сохраняется, поэтому широкая
      // таблица не растянет страницу вширь — ровно то свойство, ради которого `overflow-x` и не
      // трогали.
      const ox = getComputedStyle(e).overflowX
      if (!/visible|clip/.test(ox)) e.style.setProperty('overflow-x', 'clip', 'important')
      e.style.setProperty('overflow-y', 'visible', 'important')
      // ⚠ И `max-height`, и `height`: контейнер бывает зажат любым из двух, а сняв только первый,
      // мы получили бы элемент, у которого `overflow-y` уже `visible` (значит он не `isScroller` и
      // не `isClipped`), а содержимое всё равно вылезает за коробку и налезает на соседей.
      e.style.setProperty('max-height', 'none', 'important')
      e.style.setProperty('height', 'auto', 'important')
      log.scrollers++
      for (let a = e; a && a !== document.documentElement; a = a.parentElement) {
        if (getComputedStyle(a).position === 'fixed') {
          a.style.setProperty('position', 'static', 'important')
          log.unfixed++
        }
      }
    }
  }

  return {
    ...log,
    // ⚠ Списками, а не числами: красный тест обязан называть, ЧТО именно застряло. Голое «остался
    // 1 контейнер» отправляет следующего человека воспроизводить измерение с нуля.
    left: all().filter(isScroller).map(describe),
    clipped: all().filter(isClipped).map(describe),
    doc: document.scrollingElement ? document.scrollingElement.scrollHeight : 0
  }
}
