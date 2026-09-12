import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { decodeUploadText } from '~/utils/importUpload'
import { detectManualFormat, normalizeManualStatement } from '~/utils/manualImport'
import { LANDING_FEATURES, LANDING_STEPS, LANDING_PAIN_RESULT, LANDING_INTEGRATORS, LANDING_FORMATS, LANDING_MARKET_URL, LANDING_MARKET_PROMO, LANDING_TITLE, LANDING_DEMO_SAMPLES, copyrightYears, pageTitle } from '~/utils/landing'

/** УНП, которые встречаются в синтетических примерах. Список ЗАКРЫТЫЙ: новый номер обязан
 *  попасть сюда осознанно (см. проверку ниже). */
const DEMO_UNPS = new Set([
  '100000001', '100000002', '100000003', '100000004', '100777001',
  '190000001', '190000002', '190000004', '190000005',
  '191009988', '191234567', '191667788',
  '200000001', '200000002', '200000003', '200000004'
])

describe('LANDING_DEMO_SAMPLES (demo download samples)', () => {
  // Drift guard: every advertised sample must actually exist in public/ (else the
  // one-click loader 404s in production with no test failure), and its `name`
  // (download filename) must match the url's basename.
  it('each sample url points at a real file in public/ and name matches the url', () => {
    expect(LANDING_DEMO_SAMPLES.length).toBeGreaterThan(0)
    for (const s of LANDING_DEMO_SAMPLES) {
      expect(s.url.startsWith('/samples/')).toBe(true)
      expect(existsSync(`public${s.url}`)).toBe(true)
      expect(s.name).toBe(basename(s.url))
    }
  })

  /**
   * ⚠ «Файл лежит на месте» ещё не значит «демо его покажет». Чип грузит пример В ТОТ ЖЕ разбор,
   * которым идёт настоящая выписка, поэтому пример, который не разбирается, даёт человеку ошибку
   * на первом же клике — ровно там, где он решает, работает приложение или нет. Проверяем разбор,
   * а не наличие: добавление формата (#700) — самый частый повод промахнуться кодировкой.
   */
  it('each sample actually parses into operations', () => {
    for (const s of LANDING_DEMO_SAMPLES) {
      const bytes = readFileSync(`public${s.url}`)
      const text = decodeUploadText(bytes)
      expect(detectManualFormat(text), s.name).not.toBe('unknown')
      const items = normalizeManualStatement(text, { account: '' })
      expect(items.length, s.name).toBeGreaterThan(0)
      for (const i of items) {
        expect(i.amount, s.name).toBeGreaterThan(0)
        expect(i.currency, s.name).toMatch(/^[A-Z]{3}$/)
      }
    }
  })

  /**
   * ⚠ Примеры ПУБЛИЧНЫЕ — они скачиваются с лендинга и лежат в репозитории, который ОТКРЫТ, —
   * поэтому обязаны быть синтетикой: реальная выписка здесь это публикация финансовых ПДн клиента.
   * Признак берём не по слову «DEMO» (его легко не написать), а по форме номера: у выдуманных
   * счетов тело — длинная нулевая серия, у настоящего белорусского счёта такой не бывает.
   * ⚠ Файл без единого счёта проверку НЕ проходит: пустой список иначе означал бы «нарушений нет»
   * ровно там, где маска перестала совпадать с форматом.
   * ⚠ Масок ДВЕ: белорусский IBAN и голый 20-значный счёт (так их пишет формат 1С).
   */
  it('samples are synthetic — no real-looking bank accounts', () => {
    for (const s of LANDING_DEMO_SAMPLES) {
      const text = decodeUploadText(readFileSync(`public${s.url}`))
      const accounts = text.match(/BY\d{2}[A-Z]{4}\d{20}|\b\d{20}\b/gi) ?? []
      expect(accounts.length, `${s.name}: счетов не найдено — маска разошлась с форматом`)
        .toBeGreaterThan(0)
      for (const a of accounts) {
        expect(a, `${s.name}: ${a} не похож на синтетический`).toMatch(/0{10}/)
      }
    }
  })

  /**
   * ⚠ Гард обязан смотреть на КАТАЛОГ, а не на реестр примеров. Проверено мутацией: настоящая
   * выписка, положенная в `public/samples/` и НЕ внесённая в `LANDING_DEMO_SAMPLES`, проходила
   * зелёной — а лежит она при этом в публичной раздаче и в открытом репозитории, то есть
   * опубликована ровно так же.
   * ⚠ И проверяется не только форма счёта: мутация с настоящей выпиской, где счета имеют нулевую
   * серию (у банковских транзитных счетов это норма), а утекают УНП, название организации и
   * телефон, тоже проходила зелёной.
   */
  it('every file in public/samples/ is synthetic — не только зарегистрированные', () => {
    const dir = 'public/samples'
    const files = readdirSync(dir).filter(f => f.endsWith('.txt'))
    expect(files.length).toBeGreaterThanOrEqual(LANDING_DEMO_SAMPLES.length)
    for (const f of files) {
      const text = decodeUploadText(readFileSync(join(dir, f)))
      // Название организации ищем ТОЛЬКО В КАВЫЧКАХ: в выписке оно всегда закавычено
      // (`ООО "…"`), а вне кавычек той же формы бывают имена полей формата 1С
      // («ВерсияФормата», «ДатаНачала») — они к клиенту отношения не имеют.
      // Признак настоящего названия — слипшийся CamelCase («ТехноСервис», «БелАгроТорг»);
      // демо-имена так не выглядят («Ромашка», «Бизнес-Центр», «ТЕСТ КЛИЕНТ»).
      // ⚠ Настоящего названия клиента в примерах нет и в ЭТОМ комментарии тоже — оно и есть то,
      // что мы прячем; привести его «для наглядности» значило бы опубликовать ровно его.
      const quoted = [...text.matchAll(/["«]([^"»]{2,60})["»]/g)].map(m => m[1]!)
      const proper = quoted.filter(q => /[А-ЯЁ][а-яё]+[А-ЯЁ]/.test(q))
      expect(proper, `${f}: похоже на настоящее название организации`).toEqual([])
      // ⚠ УНП проверяется ПО СПИСКУ, а не по маске: структурно настоящий и выдуманный УНП
      // неотличимы — обе девятизначные, и по форме настоящий от выдуманного не отличается. Список
      // заставляет автора нового примера ОСТАНОВИТЬСЯ и внести номер руками — ровно тот момент,
      // в который и надо спросить себя, откуда этот номер взялся.
      const unps = [...new Set(text.match(/\b\d{9}\b/g) ?? [])]
        .filter(u => !DEMO_UNPS.has(u))
      expect(unps, `${f}: УНП не из списка демо-значений — откуда он?`).toEqual([])
      expect(text, `${f}: похоже на телефон`).not.toMatch(/\+375\d{9}/)
      expect(text, `${f}: похоже на e-mail`).not.toMatch(/[\w.-]+@[\w.-]+\.[a-z]{2,}/i)
    }
  })
})

describe('copyrightYears', () => {
  it('shows a single year when start === current', () => {
    expect(copyrightYears(2026, 2026)).toBe('2026')
  })

  it('shows a range when the project spans multiple years', () => {
    expect(copyrightYears(2026, 2030)).toBe('2026–2030')
  })

  it('does not produce a backwards range', () => {
    // Clock skew / wrong system date should not render "2026–2025".
    expect(copyrightYears(2026, 2025)).toBe('2026')
  })
})

describe('pageTitle', () => {
  it('appends the app name as a suffix', () => {
    expect(pageTitle('Настройки')).toBe(`Настройки — ${LANDING_TITLE}`)
  })
})

describe('LANDING_FEATURES', () => {
  it('every feature has a non-empty title and description', () => {
    expect(LANDING_FEATURES.length).toBeGreaterThan(0)
    for (const feature of LANDING_FEATURES) {
      expect(feature.title.trim()).not.toBe('')
      expect(feature.description.trim()).not.toBe('')
    }
  })
})

describe('LANDING_STEPS', () => {
  it('numbers the steps 01..03 with filled title/text', () => {
    expect(LANDING_STEPS.map(s => s.step)).toEqual(['01', '02', '03'])
    for (const s of LANDING_STEPS) {
      expect(s.title.trim()).not.toBe('')
      expect(s.text.trim()).not.toBe('')
    }
  })
})

describe('pain → result copy', () => {
  it('has both a before and after line', () => {
    expect(LANDING_PAIN_RESULT.before.trim()).not.toBe('')
    expect(LANDING_PAIN_RESULT.after.trim()).not.toBe('')
  })

  it('has non-empty integrators copy', () => {
    expect(LANDING_INTEGRATORS.trim()).not.toBe('')
    expect(LANDING_INTEGRATORS).toContain('коннектор')
  })

  it('lists the supported banks/formats', () => {
    expect(LANDING_FORMATS.length).toBeGreaterThan(0)
    expect(LANDING_FORMATS).toContain('Альфа-Банк Беларусь')
    expect(LANDING_FORMATS).toContain('Приорбанк')
    for (const f of LANDING_FORMATS) expect(f.trim()).not.toBe('')
  })

  it('points the marketplace link to the shef.bankimport listing over https', () => {
    expect(LANDING_MARKET_URL).toMatch(/^https:\/\//)
    expect(LANDING_MARKET_URL).toContain('shef.bankimport')
  })
})

describe('LANDING_MARKET_PROMO', () => {
  it('carries non-empty copy for every slot of the <AppInBitrixCard> card', () => {
    for (const key of ['eyebrow', 'title', 'text', 'cta'] as const) {
      expect(LANDING_MARKET_PROMO[key].trim().length).toBeGreaterThan(0)
    }
  })

  it('matches the copy agreed in docs/POSITIONING.md', () => {
    // Guard against silent drift from the owner-agreed wording (mirrored in the doc).
    expect(LANDING_MARKET_PROMO.eyebrow).toBe('Приложение для Bitrix24')
    expect(LANDING_MARKET_PROMO.title).toBe('Импорт выписки прямо в Bitrix24')
    expect(LANDING_MARKET_PROMO.cta).toBe('Открыть в Маркете Bitrix24')
    // The body is the longest, most drift-prone string — assert it verbatim too.
    expect(LANDING_MARKET_PROMO.text).toBe(
      'Выписка из клиент-банка попадает в CRM автоматически: контрагент, оплата, стадии сделки, уведомления — не выходя из портала.'
    )
  })
})
