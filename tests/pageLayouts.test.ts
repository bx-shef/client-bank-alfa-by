import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Какой странице какой layout и какой гейт (#532).
 *
 * ⚠ Раньше layout был один на два разных мира — портальные страницы внутри iframe и служебные
 * экраны оператора в обычной вкладке — и назывался `clear`, то есть не различал их вовсе. Имя
 * восстановили, но имя само по себе ничего не удерживает: страницу легко завести с чужим
 * layout'ом или вовсе без гейта, и оба промаха ТИХИЕ. Портальная страница без `InPortalGate`
 * снаружи портала показывает неработающий интерфейс вместо объяснения (#414), а операторская без
 * `AuthGate` — защищённое содержимое до редиректа.
 *
 * ⚠ Список ЗАКРЫТЫЙ: новая страница обязана получить решение «в каком она мире», а не унаследовать
 * его молчанием.
 */
const PAGES = join(process.cwd(), 'app/pages')

/** Страницы внутри портала Bitrix24: iframe, фрейм-токен, слайдеры. */
const PORTAL = ['app.vue', 'import.vue', 'install.vue', 'settings.vue']
/** Служебные экраны оператора: обычная вкладка, наша сессионная кука. */
const OPERATOR = ['login.vue', 'queues.vue']
/** Публичные страницы лендинга. */
const LANDING = ['index.vue', 'partners.vue']
/**
 * Публичная страница, которую открывают И снаружи, И слайдером портала: справка (#576).
 *
 * ⚠ Четвёртая категория заведена не ради исключения из правил, а потому что мир у страницы
 * действительно свой: она индексируется (ссылку даём в карточке Маркета), но рисуется внутри
 * слайдера рядом с настройками — а брендовая тёмная оболочка лендинга там выглядела бы чужой
 * страницей. Отсюда `portal`-layout при публичном маршруте.
 *
 * ⚠ `InPortalGate` ей ЗАПРЕЩЁН, и это проверяется: гейт закрывает то, что без фрейм-токена не
 * работает, а справка — чистый текст. Закрыв её гейтом, мы сделали бы недоступной ровно ту
 * страницу, которую даём людям, у которых что-то не работает.
 */
const PUBLIC_PORTAL = ['help.vue']

/** Исходник без комментариев — судим о КОДЕ, а не о прозе рядом с ним. */
function stripComments(src: string): string {
  // ⚠ Порядок снятия выяснен НЕ здесь, а на живом промахе соседнего гарда
  // (`tests/seoMetaPlacement.test.ts`): сперва строчные, потом блочные. Строчный комментарий с
  // путём вида `/*` блочный стриппер, запущенный первым, принимает за начало блока и съедает всё
  // до следующего `*/` — тест падал на странице, которая в порядке.
  // ⚠ Строчная регулярка ЗАЯКОРЕНА на начало строки: без якоря она срезала бы хвост любой строки
  // кода с `https://`, включая ту, где мог бы стоять сам тег гейта.
  return src.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function codeOnly(file: string): string {
  return stripComments(readFileSync(join(PAGES, file), 'utf8'))
}

/**
 * Только блок `<script setup>` — там, где `definePageMeta` и живёт.
 *
 * ⚠ Найдено мутацией: пока метку искали по всему файлу, строка `layout: 'portal'`, случайно
 * оказавшаяся в РАЗМЕТКЕ, подделывала классификацию — страница с чужим layout'ом проходила гард.
 */
function scriptOnly(file: string): string {
  const src = codeOnly(file)
  const end = src.indexOf('</script>')
  return end === -1 ? src : src.slice(0, end)
}

/**
 * Тег гейта с ГРАНИЦЕЙ имени.
 *
 * ⚠ Голое `toContain('<InPortalGate')` ошибалось в обе стороны (замерено мутацией): опечатка
 * `<InPortalGateway>` засчитывалась за гейт, а законный соседний компонент с тем же префиксом
 * (`<InPortalGateBanner />`) краснел бы на верном коде. Красный на верном коде учит ослаблять
 * гард, поэтому это не мелочь.
 */
function hasTag(code: string, tag: string): boolean {
  return new RegExp(`<${tag}[\\s/>]`).test(code)
}

describe('layout и гейт каждой страницы (#532)', () => {
  it('все страницы классифицированы', () => {
    const known = new Set([...PORTAL, ...OPERATOR, ...LANDING, ...PUBLIC_PORTAL])
    // ⚠ Обход РЕКУРСИВНЫЙ, хотя `app/pages` сейчас плоский: соседний закрытый список страниц
    // (`seoMetaPlacement.test.ts`) промахнулся ровно нерекурсивным вариантом — вложенная страница
    // не попадала в сопоставление, и «третьего не дано» проходило молча на неклассифицированной.
    const files = readdirSync(PAGES, { recursive: true, encoding: 'utf8' })
      .map(f => String(f).split('\\').join('/'))
      .filter(f => f.endsWith('.vue'))
    expect(files.filter(f => !known.has(f)), 'новая страница без решения «в каком она мире»').toEqual([])
    // И обратно: список не должен пережить удалённую страницу.
    expect([...known].filter(f => !files.includes(f)), 'в списке страница, которой больше нет').toEqual([])
  })

  it('портальные страницы берут layout portal и несут InPortalGate', () => {
    for (const f of PORTAL) {
      const code = codeOnly(f)
      expect(scriptOnly(f), `${f}: чужой layout (метка обязана быть строковым литералом в script setup — иначе гард её не прочитает)`)
        .toContain('layout: \'portal\'')
      // ⚠ Гейт живёт в СТРАНИЦЕ, а не в layout'е, потому что `/app` подавляет его целиком, пока
      // уводит фрейм на слайдер. Раз он в странице — его можно забыть, и вот проверка.
      expect(hasTag(code, 'InPortalGate'), `${f}: нет InPortalGate — снаружи портала покажет неработающий интерфейс`)
        .toBe(true)
      // ⚠ Гейт под условием — это гейт, которого может не быть. Единственное исключение названо
      // поимённо: `/app` гасит свой гейт, пока уводит фрейм на слайдер (иначе страница, которую
      // никто не открывал, показывает свой экран ~160 мс — замерено). Любое другое условие
      // обязано быть обсуждено, а не унаследовано.
      const gate = /<InPortalGate\b[^>]*>/.exec(code)?.[0] ?? ''
      if (f === 'app.vue') expect(gate, 'app.vue: пропало условие подавления гейта на уходе в слайдер').toContain('v-if="!leavingToSlider"')
      else expect(gate, `${f}: гейт под условием — он может не сработать`).not.toContain('v-if')
    }
  })

  it('публичная справка: portal-layout, но без портального гейта', () => {
    for (const f of PUBLIC_PORTAL) {
      const code = codeOnly(f)
      expect(scriptOnly(f), `${f}: чужой layout`).toContain('layout: \'portal\'')
      expect(hasTag(code, 'InPortalGate'), `${f}: гейт на справке — недоступна тем, кому нужна`).toBe(false)
    }
  })

  it('операторские страницы берут layout operator, а защищённая — ещё и AuthGate', () => {
    for (const f of OPERATOR) {
      expect(scriptOnly(f), `${f}: чужой layout (метка обязана быть строковым литералом в script setup)`)
        .toContain('layout: \'operator\'')
    }
    const queues = codeOnly('queues.vue')
    expect(hasTag(queues, 'AuthGate'), 'queues: пропал AuthGate — содержимое мелькнёт до редиректа').toBe(true)
    expect(queues, 'queues: пропал серверный гвард').toContain('middleware: \'auth\'')
    // ⚠ А вход НЕ гейтим: страница, требующая войти, чтобы показать форму входа, — тупик.
    expect(hasTag(codeOnly('login.vue'), 'AuthGate'), 'login под AuthGate — тупик').toBe(false)
  })

  it('страницы лендинга берут layout landing и НЕ несут портальных гейтов', () => {
    for (const f of LANDING) {
      const code = codeOnly(f)
      expect(scriptOnly(f), `${f}: чужой layout`).toContain('layout: \'landing\'')
      expect(code, `${f}: портальный гейт на публичной странице`).not.toContain('<InPortalGate')
    }
  })

  it('оба служебных layout стоят на общей оболочке', () => {
    // ⚠ Разметка у них сегодня одна; разъехавшись, они воспроизвели бы дефект ровно в половине
    // приложения — то есть там, где его никто не искал бы.
    for (const l of ['portal.vue', 'operator.vue']) {
      // ⚠ Комментарии срезаем и здесь: у страниц срезали, а у layout'ов забыли — и мутация
      // «оболочка только в комментарии, разметка своя» проходила зелёной (замерено).
      const src = stripComments(readFileSync(join(process.cwd(), 'app/layouts', l), 'utf8'))
      expect(src, `${l}: своя копия оболочки вместо AppShell`).toContain('<AppShell>')
      expect(src, `${l}: свой <B24App> — оболочка обязана быть ОДНА`).not.toContain('<B24App')
      expect(src, `${l}: AppShell без слота — страница не отрисуется`).toContain('<slot />')
    }
    // ⚠ Решение внутри оболочки оплачено измерением (#530): `overflow-x-hidden` делает контейнер
    // скроллпортом, и любой `sticky` под ним молча перестаёт липнуть. Текстом это возвращается
    // одним словом, поэтому одним словом и стережём.
    const shell = readFileSync(join(process.cwd(), 'app/components/AppShell.vue'), 'utf8')
    expect(shell, 'вернулся overflow-x-hidden — sticky перестанет работать на всех служебных страницах')
      .not.toMatch(/class="[^"]*overflow-x-hidden/)
    expect(shell).toMatch(/class="[^"]*overflow-x-clip/)
  })
})
