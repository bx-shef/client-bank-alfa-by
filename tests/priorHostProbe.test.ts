import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildClientAssertionClaims, PRIOR_API_PREFIXES } from '../app/utils/priorOauth'
import { buildPriorJwtHeader } from '../server/utils/priorJwt'

// Гард дрейфа между пробой хоста (#522, bash) и боевым кодом (TypeScript).
//
// ⚠ `scripts/prior-host-probe.sh` собирает `client_assertion` РУКАМИ на openssl — иначе на прод-
// сервере её не построить: там нет ни node, ни pnpm, ни исходников, только docker и .env. Значит
// форма ассерции и пути API существуют в проекте ДВАЖДЫ, на двух языках, и разъехаться могут
// молча: проба продолжит «работать», просто её ответ перестанет что-либо говорить о боевом пути.
//
// Отказ при этом самый неприятный из возможных — проба ответит «хост не принял наш client_id», и
// вывод будет ровно противоположен истине: решение о переключении прода примут по ложному «нет».
// Поэтому поля сверяются с настоящими билдерами, а не переписываются сюда константами.

const SCRIPT = readFileSync(join(import.meta.dirname, '..', 'scripts', 'prior-host-probe.sh'), 'utf8')

describe('проба хоста Приорбанка не разошлась с боевым кодом (#522)', () => {
  it('исходник читается и содержит сборку ассерции', () => {
    // Без этого «нарушителей нет» достигалось бы переименованием файла.
    expect(SCRIPT).toContain('client_assertion')
    expect(SCRIPT).toContain('openssl dgst -sha256 -sign')
  })

  it('заголовок JWT — те же поля, что у `buildPriorJwtHeader`', () => {
    const header = buildPriorJwtHeader('KID')
    for (const key of Object.keys(header)) {
      expect(SCRIPT, `в заголовке пробы нет поля ${key}`).toMatch(new RegExp(`"${key}"\\s*:`))
    }
    expect(SCRIPT).toContain('"alg":"RS256"')
  })

  it('claims ассерции — те же поля, что у `buildClientAssertionClaims`', () => {
    const claims = buildClientAssertionClaims({ clientId: 'C', aud: 'A', nowSec: 1, jti: 'J' })
    for (const key of Object.keys(claims)) {
      expect(SCRIPT, `в claims пробы нет поля ${key}`).toMatch(new RegExp(`"${key}"\\s*:`))
    }
    // ⚠ `aud` — МАССИВ, а не строка: банк так и проверяет, и одиночная строка отвергается как
    // невалидная ассерция. В bash это легко написать иначе, не заметив.
    expect(Array.isArray(claims.aud)).toBe(true)
    expect(SCRIPT).toMatch(/"aud":\s*\[/)
  })

  it('префиксы путей API взяты из общего источника, а не выдуманы', () => {
    expect(SCRIPT).toContain(PRIOR_API_PREFIXES.AUTH)
    expect(SCRIPT).toContain(PRIOR_API_PREFIXES.DCR)
    expect(SCRIPT).toContain(PRIOR_API_PREFIXES.OB)
  })

  it('проба НЕ трогает refresh-токены — это убило бы живые подключения', () => {
    // ⚠ Единственный по-настоящему опасный вызов, который тут можно было бы сделать. Обновление
    // РОТИРУЕТ refresh, и проба, выбросившая новый, оставила бы подключение с потраченным токеном:
    // снаружи цело, умирает на следующем обновлении, лечится только повторным входом владельца
    // счёта в интернет-банк (#505/#509). Запрещено структурно, а не памятью автора.
    expect(SCRIPT).not.toMatch(/grant_type=refresh_token/)
    expect(SCRIPT).not.toMatch(/refresh_token_enc/)
    // Действительность регистрации проверяется грантом без побочных эффектов.
    expect(SCRIPT).toContain('grant_type=client_credentials')
  })

  it('секреты не печатаются', () => {
    // Значение токена и ключа не должно попадать в вывод — сервер общий, вывод копируют в чат.
    expect(SCRIPT).not.toMatch(/echo.*\$ACCESS[^_]/)
    expect(SCRIPT).not.toMatch(/echo.*PRIVATE_KEY_RAW/)
    expect(SCRIPT).toContain('значение не печатаем')
  })

  it('ключ кладётся во временный файл с правами 600 и удаляется', () => {
    expect(SCRIPT).toContain('chmod 600')
    expect(SCRIPT).toMatch(/trap 'rm -f "\$KEYFILE"' EXIT/)
  })
})
