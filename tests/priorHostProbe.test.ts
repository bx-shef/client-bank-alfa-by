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

  it('401 НЕ трактуется как «эндпоинта нет» — это «дай токен»', () => {
    // ⚠ Живой прогон на проде поймал ровно эту ошибку в первой версии: `/oidcdiscovery` ответил
    // `401 Missing Credentials`, а проба напечатала «сервера авторизации по этому адресу нет».
    // Вывод был АКТИВНО ложным — на том же хосте токен выдавался прекрасно. Эндпоинт закрыт
    // токеном, и 401 означает лишь это.
    expect(SCRIPT).not.toMatch(/401[^\n]*нет\b/)
    expect(SCRIPT).not.toContain('сервера авторизации по этому адресу нет')
    // Ресурсный API различает «нет двери» и «дверь есть, нужен другой ключ» — по коду.
    expect(SCRIPT).toMatch(/401\|403\)\s*ok/)
    expect(SCRIPT).toMatch(/404\)\s*bad/)
  })

  it('discovery спрашивается С ТОКЕНОМ, а не до него', () => {
    // Порядок шагов — часть смысла: пока токена нет, API-шлюз банка отвечает 401 на всё, и
    // спрашивать конфигурацию раньше токена бессмысленно.
    const tokenAt = SCRIPT.indexOf('grant_type=client_credentials')
    const discAt = SCRIPT.indexOf('/oidcdiscovery"')
    expect(tokenAt).toBeGreaterThan(-1)
    expect(discAt).toBeGreaterThan(tokenAt)
  })

  it('проверка ресурсного API по умолчанию ЧИТАЮЩАЯ', () => {
    // ⚠ Отличить «API здесь» от «API здесь нет» можно кодом ответа, ничего не создавая. Запись
    // (создание согласия) остаётся за отдельным флагом — она оставляет след в банке.
    const readAt = SCRIPT.indexOf(`"$TARGET$OB_PREFIX/accounts"`)
    expect(readAt).toBeGreaterThan(-1)
    expect(SCRIPT).toMatch(/WITH_CONSENT" != "1"/)
  })

  it('секреты не печатаются', () => {
    // Значение токена и ключа не должно попадать в вывод — сервер общий, вывод копируют в чат.
    expect(SCRIPT).not.toMatch(/echo.*\$ACCESS[^_]/)
    expect(SCRIPT).not.toMatch(/echo.*PRIVATE_KEY_RAW/)
    expect(SCRIPT).toContain('значение не печатаем')
  })

  it('ключ кладётся во временные файлы с правами 600 и удаляется', () => {
    // ⚠ Файлов ДВА: сырое значение из `.env` и собранный PEM. Разбор форм хранения (экранированные
    // переносы / настоящие переносы / голый base64) требует промежуточного файла, и он несёт ровно
    // тот же секрет — забыть про него было бы легко именно потому, что он «временный».
    for (const f of ['KEYFILE', 'KEYRAW']) {
      expect(SCRIPT, `${f} не создан через mktemp`).toMatch(new RegExp(`${f}="\\$\\(mktemp`))
      expect(SCRIPT, `${f} не удаляется по trap`).toMatch(new RegExp(`trap '[^']*\\$${f}[^']*' EXIT`))
    }
    expect(SCRIPT.match(/chmod 600/g) ?? []).toHaveLength(2)
  })

  it('диагностика отказа не печатает сам ключ', () => {
    // ⚠ Когда ключ не разбирается, выбирать не из чего — показать его нельзя, а «не разбирается»
    // без подробностей не лечится ничем, кроме угадывания. Поэтому печатаются признаки: число
    // строк, длина, ПЕРВЫЕ 30 символов первой строки (у PEM это заголовок `-----BEGIN …`).
    // Обрезка обязана быть в коде, а не в намерении.
    expect(SCRIPT).toMatch(/cut -c1-30/)
    // Целиком содержимое ни одного из файлов с ключом наружу не выводится.
    expect(SCRIPT).not.toMatch(/cat "\$KEYFILE"/)
    expect(SCRIPT).not.toMatch(/echo.*\$\(cat "\$KEYRAW"\)/)
  })
})
