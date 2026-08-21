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

function source(file: string): string {
  return readFileSync(join(PAGES, file), 'utf8')
}

/** Исходник без комментариев — судим о КОДЕ, а не о прозе рядом с ним. */
function codeOnly(file: string): string {
  return source(file).replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

describe('layout и гейт каждой страницы (#532)', () => {
  it('все страницы классифицированы', () => {
    const known = new Set([...PORTAL, ...OPERATOR, ...LANDING])
    const files = readdirSync(PAGES).filter(f => f.endsWith('.vue'))
    expect(files.filter(f => !known.has(f)), 'новая страница без решения «в каком она мире»').toEqual([])
    // И обратно: список не должен пережить удалённую страницу.
    expect([...known].filter(f => !files.includes(f)), 'в списке страница, которой больше нет').toEqual([])
  })

  it('портальные страницы берут layout portal и несут InPortalGate', () => {
    for (const f of PORTAL) {
      const code = codeOnly(f)
      expect(code, `${f}: чужой layout`).toContain('layout: \'portal\'')
      // ⚠ Гейт живёт в СТРАНИЦЕ, а не в layout'е, потому что `/app` подавляет его целиком, пока
      // уводит фрейм на слайдер. Раз он в странице — его можно забыть, и вот проверка.
      expect(code, `${f}: нет InPortalGate — снаружи портала покажет неработающий интерфейс`)
        .toContain('<InPortalGate')
    }
  })

  it('операторские страницы берут layout operator, а защищённая — ещё и AuthGate', () => {
    for (const f of OPERATOR) {
      expect(codeOnly(f), `${f}: чужой layout`).toContain('layout: \'operator\'')
    }
    const queues = codeOnly('queues.vue')
    expect(queues, 'queues: пропал AuthGate — содержимое мелькнёт до редиректа').toContain('<AuthGate')
    expect(queues, 'queues: пропал серверный гвард').toContain('middleware: \'auth\'')
    // ⚠ А вход НЕ гейтим: страница, требующая войти, чтобы показать форму входа, — тупик.
    expect(codeOnly('login.vue'), 'login под AuthGate — тупик').not.toContain('<AuthGate')
  })

  it('страницы лендинга берут layout landing и НЕ несут портальных гейтов', () => {
    for (const f of LANDING) {
      const code = codeOnly(f)
      expect(code, `${f}: чужой layout`).toContain('layout: \'landing\'')
      expect(code, `${f}: портальный гейт на публичной странице`).not.toContain('<InPortalGate')
    }
  })

  it('оба служебных layout стоят на общей оболочке', () => {
    // ⚠ Разметка у них сегодня одна; разъехавшись, они воспроизвели бы дефект ровно в половине
    // приложения — то есть там, где его никто не искал бы.
    for (const l of ['portal.vue', 'operator.vue']) {
      const src = readFileSync(join(process.cwd(), 'app/layouts', l), 'utf8')
      expect(src, `${l}: своя копия оболочки вместо AppShell`).toContain('<AppShell>')
    }
  })
})
