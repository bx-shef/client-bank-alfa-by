import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Архитектурный гард #449, форма `priorAuthSingleChokePoint`/`priorResourceHeadersChokePoint`.
//
// ЧТО ЗАЩИЩАЕМ. Один ключ подписывает два JWT. Claim-набор authorize-`request` — строгое
// НАДМНОЖЕСТВО `client_assertion`: те же `iss`/`sub`/`aud`/`iat`/`exp`/`jti`, тот же `kid`.
// Разница только в канале: assertion уходит в теле POST, а authorize — В URL, который мы САМИ
// вручаем админу для пересылки владельцу счёта («Ссылка для владельца счёта» + «Скопировать» в
// `BankConnectCard.vue`). То есть при каждом подключении он штатно проходит через мессенджер.
// Пересланная ссылка — синтаксически валидный `client_assertion`, пока их что-нибудь не разводит.
//
// ⚠ ПОЧЕМУ ИМЕННО ГАРД, А НЕ ЮНИТ-ТЕСТ. Разведение держится на асимметрии: authorize-путь берёт
// `typ` из конфига, assertion-путь — НИКОГДА, у него константа. Асимметрию легко «причесать»:
// достаточно передать четвёртый аргумент и там, «чтобы было единообразно», — и оба заголовка снова
// совпадут. Юнит-тесты этого не увидят: они проверяют, что каждая сторона отдаёт то, что ей велено,
// а велено будет одно и то же. Проверено мутацией — с четвёртым аргументом в `priorTokenAuth`
// весь остальной набор остаётся зелёным.

const ROOT = join(import.meta.dirname, '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8')

const ASSERTION_MODULE = 'server/utils/priorTokenAuth.ts'
const AUTHORIZE_MODULE = 'server/utils/priorConnectStart.ts'

/** Аргументы вызова `signJwt(...)` — по верхнеуровневым запятым, чтобы `f(a, g(b, c))` не считалось тремя. */
function signJwtArgs(src: string): string[][] {
  const out: string[][] = []
  const re = /signJwt\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    let cur = ''
    const args: string[] = []
    for (; i < src.length && depth > 0; i++) {
      const ch = src[i]!
      if (ch === '(') {
        depth++
      } else if (ch === ')') {
        depth--
        if (depth === 0) break
      }
      if (depth === 1 && ch === ',') {
        args.push(cur.trim())
        cur = ''
      } else {
        cur += ch
      }
    }
    if (cur.trim()) args.push(cur.trim())
    out.push(args)
  }
  return out
}

describe('#449: authorize-JWT и client_assertion не должны сойтись обратно', () => {
  it('assertion-путь НЕ читает переменную authorize-стороны', () => {
    const src = read(ASSERTION_MODULE)
    // Прочитав её, assertion получил бы тот же `typ`, и развод исчез бы — молча, при зелёных тестах.
    expect(src).not.toContain('PRIOR_OAUTH_REQUEST_TYP')
    expect(src).not.toContain('priorRequestTypFromEnv')
  })

  it('assertion-путь подписывает БЕЗ четвёртого аргумента — то есть константой', () => {
    const calls = signJwtArgs(read(ASSERTION_MODULE))
    // ⚠ Пустой результат — красный: переименовали вызов, и гард молча перестал стеречь.
    expect(calls.length).toBeGreaterThanOrEqual(1)
    for (const args of calls) expect(args.length).toBe(3)
  })

  it('authorize-путь подписывает С четвёртым аргументом — иначе разводить нечем', () => {
    const calls = signJwtArgs(read(AUTHORIZE_MODULE))
    expect(calls.length).toBeGreaterThanOrEqual(1)
    // Обратная половина: если отсюда убрать `typ`, заголовки совпадут так же, как если бы его
    // добавили в assertion. Гард обязан ловить оба направления, а не одно.
    expect(calls.some(a => a.length === 4)).toBe(true)
  })

  it('константа assertion объявлена там же, где подписчик, и не производна от env', () => {
    const src = read('server/utils/priorJwt.ts')
    expect(src).toContain(`export const PRIOR_ASSERTION_TYP = 'JWT'`)
  })
})
