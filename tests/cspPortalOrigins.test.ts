import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
// Скрипт экспортирует чистые хелперы; CLI-часть под гардом, импорт её не запускает.
import { TOKEN, buildOriginList, injectOrigins, normalizeOrigin } from '../scripts/csp-portal-origins.mjs'

describe('normalizeOrigin', () => {
  it('дописывает схему к голому хосту', () => {
    expect(normalizeOrigin('portal.standartno.by')).toBe('https://portal.standartno.by')
  })

  it('принимает одну wildcard-метку и приводит хост к нижнему регистру', () => {
    expect(normalizeOrigin('https://*.Example.BY')).toBe('https://*.example.by')
  })

  // ⚠ Значение приходит из переменной CI и попадает В ЗАГОЛОВОК ОТВЕТА. Точка с запятой
  // закрывает директиву CSP, а перенос строки рвёт заголовок — то есть «почистить пробелы»
  // тут недостаточно, нужен белый список формы.
  it.each([
    ['точка с запятой дописывает свою директиву', 'evil.by; script-src *'],
    ['перенос строки рвёт заголовок', 'evil.by\nX-Foo: bar'],
    ['путь — уже не источник', 'https://evil.by/path'],
    ['http вместо https', 'http://portal.standartno.by'],
    ['без точки — не хост', 'localhost'],
    ['звёздочка целиком', '*']
  ])('отвергает: %s', (_name, value) => {
    expect(normalizeOrigin(value)).toBeNull()
  })
})

describe('buildOriginList', () => {
  it('разделяет запятыми и пробелами и ставит ведущий пробел', () => {
    expect(buildOriginList('a.example.by, b.example.by'))
      .toBe(' https://a.example.by https://b.example.by')
  })

  it('дедуплицирует', () => {
    expect(buildOriginList('a.example.by https://a.example.by')).toBe(' https://a.example.by')
  })

  // Пустой список — ШТАТНЫЙ случай (облачный портал), а не ошибка: токен исчезает бесследно,
  // CSP остаётся синтаксически целой.
  it.each([[''], [undefined], ['   '], [', ,']])('пустой вход → пустая строка (%s)', (value) => {
    expect(buildOriginList(value as string | undefined)).toBe('')
  })

  it('роняет только негодные записи, годные оставляет', () => {
    expect(buildOriginList('good.example.by, bad;value')).toBe(' https://good.example.by')
  })
})

describe('injectOrigins', () => {
  it('заменяет ВСЕ вхождения токена', () => {
    const conf = `connect-src 'self'${TOKEN}; frame-ancestors 'self'${TOKEN};`
    expect(injectOrigins(conf, 'portal.standartno.by'))
      .toBe('connect-src \'self\' https://portal.standartno.by; frame-ancestors \'self\' https://portal.standartno.by;')
  })
})

// Структурный инвариант: токен обязан жить в конфиге, причём в ОБЕИХ директивах.
// Потеряется один — коробочный портал получит наполовину рабочую CSP: фрейм откроется,
// а вызовы к порталу молча заблокируются (или наоборот), и виноватым будет выглядеть SDK.
describe('nginx.conf', () => {
  it('несёт токен в connect-src и frame-ancestors', () => {
    const conf = readFileSync(new URL('../nginx.conf', import.meta.url), 'utf8')
    const csp = conf.split('\n').find(line => line.includes('frame-ancestors') && line.includes(TOKEN))
    expect(csp, `в nginx.conf нет строки CSP с ${TOKEN}`).toBeTruthy()
    expect(csp!.split(TOKEN).length - 1).toBe(2)
    expect(csp).toMatch(new RegExp(`connect-src[^;]*${TOKEN}`))
    expect(csp).toMatch(new RegExp(`frame-ancestors[^;]*${TOKEN}`))
  })
})
