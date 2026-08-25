// «Раскатка» внутренних скроллеров перед fullPage-снимком (#630).
//
// ⚠ ЗАЧЕМ. `page.screenshot({ fullPage: true })` снимает ДОКУМЕНТ. На in-portal-страницах документ
// не растёт вовсе: b24ui-оболочка `B24DashboardGroup` — это `fixed inset-0 flex overflow-hidden`,
// то есть экран пришпилен к вьюпорту, а прокручивается внутренний `flex-1 overflow-y-auto`.
// Замерено на собранной статике (`/settings?preview=1`): `document.scrollingElement.scrollHeight`
// = 900 при содержимом 2118. Значит эталон равен первому экрану, и всё ниже — сверка счетов,
// исключения, авто-проведение, карта распознавания, очистка, сами кнопки Save/Cancel — не
// проверялось визуальной регрессией НИ РАЗУ, хотя джоба была зелёной и выглядела рабочей.
//
// ⚠ ОДИН МОДУЛЬ НА ДВА ПОТРЕБИТЕЛЯ — регресс-тест и ручной `pnpm screenshot`. Паритет тут уже
// объявлен требованием (`scripts/screenshot.mjs`, комментарий про `reducedMotion`): расходятся они
// — и «посмотрел глазами» перестаёт что-либо говорить о том, что проверит CI. Ровно это и было:
// ручной снимок настроек тоже отдавал 1280×900, и чтобы увидеть блок сверки, приходилось писать
// одноразовый скрипт со снимком по локатору.
//
// ⚠ ПОЧЕМУ НЕ СЕЛЕКТОРОМ ПО КЛАССАМ. `fixed inset-0` приходит из темы b24ui, а не из нашей
// разметки. Правило `.fixed.inset-0 { position: static }` молча перестало бы работать на апгрейде
// темы — то есть покрытие снова тихо съёжилось бы до первого экрана. Здесь ищем скроллеры по
// ВЫЧИСЛЕННОМУ стилю и по факту переполнения, а расфиксируем ровно тех предков, что мешают.
//
// ⚠ САМОПРОВЕРКА — не украшение, а весь смысл. Функция возвращает `left`/`clipped`, и вызывающий
// обязан на них падать: без этого следующая перестройка оболочки вернула бы прежний дефект тем же
// способом, каким он и появился — молча и с зелёным CI.

/**
 * Исполняется В БРАУЗЕРЕ (сериализуется Playwright'ом), поэтому без импортов и без TypeScript.
 *
 * @returns {{ scrollers: number, unfixed: number, left: number, clipped: string[], doc: number }}
 */
export function unrollScrollContainers() {
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
    const found = Array.prototype.filter.call(document.querySelectorAll('*'), isScroller)
    if (!found.length) break
    for (const e of found) {
      // ⚠ Только `overflow-y`. Горизонтальную прокрутку трогать НЕЛЬЗЯ: широкие таблицы и блоки
      // кода по конвенции проекта живут в своём `overflow-x: auto`, и раскатав его, мы растянули
      // бы страницу вширь — то есть поменяли бы эталон там, где ничего не чинили.
      e.style.setProperty('overflow-y', 'visible', 'important')
      e.style.setProperty('max-height', 'none', 'important')
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
    left: Array.prototype.filter.call(document.querySelectorAll('*'), isScroller).length,
    clipped: Array.prototype.map.call(
      Array.prototype.filter.call(document.querySelectorAll('*'), isClipped),
      e => `${e.tagName}.${String(e.className || '').slice(0, 60)} ${e.clientHeight}/${e.scrollHeight}`
    ),
    doc: document.scrollingElement.scrollHeight
  }
}

/**
 * Прогнать раскатку на странице Playwright и вернуть диагностику.
 *
 * ⚠ Ни на что не жалуется сама — решение принимает вызывающий: у теста это `expect`, у ручного
 * скрипта — предупреждение в консоль. Смешивать их здесь значило бы либо ронять ручной прогон, либо
 * молчать в тесте.
 *
 * @param {import('playwright').Page} page
 */
export async function unrollPage(page) {
  return page.evaluate(unrollScrollContainers)
}
