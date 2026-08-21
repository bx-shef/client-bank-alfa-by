import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Проба `pageNo=1` (#561) — та же форма покрытия, что у `prod-poll-check.sh`: чистые функции
// вырезаются из скрипта `sed`-диапазоном и исполняются, а не грепаются.
//
// ⚠ Почему не «проверить, что функция упоминается». Ровно этот приём в соседнем файле уже подвёл:
// тело `minutes_of` выпотрошили до `echo "0"`, и все проверки остались зелёными. Проверка имени
// функции — не проверка функции. Здесь то же самое, но ставка выше: от вердикта этой пробы
// зависит, оставлять ли навсегда удвоенный расход общего лимита банка.
//
// ⚠ Никакой инфраструктуры не нужно: обе проверяемые функции чистые, а валидация дня срабатывает
// ДО первого обращения к docker.

const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/prod-alfa-page-probe.sh')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8')

/** Вызвать одну функцию скрипта, вырезав её `sed`-диапазоном (приём из prodPollCheck.test.ts). */
function callFn(fn: string, ...args: string[]): string {
  return execFileSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"`, '_', SCRIPT_PATH, ...args
  ], { encoding: 'utf8' })
}

describe('#561 проба: вердикт (исполнением, а не грепом)', () => {
  const verdict = (p0: string, p1: string) => callFn('verdict', p0, p1)
  const STATES = ['1', '0', '-1', ''] as const

  it('непустая ВТОРАЯ страница решает вопрос сама, чем бы ни ответила первая', () => {
    // ⚠ Живой дефект, найденный ревью: общая проверка «неполный ответ» стояла раньше и глушила
    // уже готовый вывод. На таблице 4×4 молчали два случая из шестнадцати — и оба были RED, то
    // есть проба замалчивала именно доказанную потерю операций.
    for (const p0 of STATES) expect(verdict(p0, '0'), `P0=${p0 || '<пусто>'}`).toBe('RED')
  })

  it('зелёный вердикт требует ОБЕИХ известных страниц', () => {
    expect(verdict('0', '1')).toBe('GREEN')
    // ⚠ Ни одно неизвестное состояние не должно давать «потерь не было»: цена ошибки в эту
    // сторону — молча вернуть стоимость задачи к 1 и снова терять операции.
    for (const p0 of ['-1', '']) expect(verdict(p0, '1')).toBe('INCONCLUSIVE')
    for (const p1 of ['-1', '']) expect(verdict('0', p1)).toBe('INCONCLUSIVE')
  })

  it('обе страницы пусты — операций не было, проба ничего не доказывает', () => {
    expect(verdict('1', '1')).toBe('NODATA')
  })

  it('вся таблица 4×4 разобрана и GREEN достижим ровно в одном случае', () => {
    const table = STATES.flatMap(p0 => STATES.map(p1 => [p0, p1, verdict(p0, p1)] as const))
    expect(table).toHaveLength(16)
    expect(table.filter(([,, v]) => v === 'GREEN')).toHaveLength(1)
    expect(table.filter(([,, v]) => v === 'RED')).toHaveLength(4)
    expect(table.every(([,, v]) => ['RED', 'GREEN', 'NODATA', 'INCONCLUSIVE'].includes(v))).toBe(true)
  })
})

describe('#561 проба: состояние страницы по сырому телу', () => {
  const state = (body: string) => callFn('page_state', body)

  it('различает пустой, непустой и отсутствующий page[]', () => {
    expect(state('{"page":[],"errors":[]}')).toBe('1')
    expect(state('{"page":[{"docId":"a"}],"errors":[]}')).toBe('0')
    expect(state('{"error":"forbidden"}')).toBe('-1')
  })

  it('переносы и отступы не мешают — банк волен форматировать как хочет', () => {
    expect(state('{\n  "page": [ ],\n  "errors": []\n}')).toBe('1')
    expect(state('{\n  "page": [\n    {"docId": "a"}\n  ]\n}')).toBe('0')
  })

  it('похожий ключ не считается за page[]', () => {
    expect(state('{"pageInfo":[{"total":5}]}')).toBe('-1')
  })
})

describe('#561 проба: маскировка номера счёта', () => {
  const mask = (v: string) => callFn('mask', v)

  it('прячет середину настоящего IBAN', () => {
    const iban = 'BY13ALFA30120000000000000000' // синтетический, 28 знаков
    expect(mask(iban)).toBe('BY13…0000')
    expect(mask(iban)).not.toContain('ALFA')
  })

  it('короткое значение НЕ выдаётся за замаскированное', () => {
    // ⚠ Голый `sed 's/^(.{4}).*(.{4})$/\1…\2/'` на восьми знаках показывает все восемь: «…» на
    // месте, скрыто ноль. Оператор, увидев такое, обоснованно перешлёт строку дальше — а вывод
    // этой команды пересылают с мобильного терминала, ради чего маскировка и заведена.
    for (const short of ['12345678', '1234567', 'abc', '', '~pending:x']) {
      expect(mask(short), `«${short}» просочилось`).toBe('****')
    }
  })
})

describe('#561 проба: разбор .env', () => {
  it('снимает кавычки, `export` и хвостовой комментарий, берёт ПЕРВОЕ вхождение', () => {
    const env = [
      'ALFA_OAUTH_API_BASE="https://developerhub.alfabank.by:8273"',
      'ALFA_OAUTH_API_BASE=https://second.example',
      'export ALFA_OAUTH_API_PREFIX=/partner/1.2.0   # комментарий'
    ].join('\n')
    const out = execFileSync('bash', ['-c',
      `d="$(mktemp -d)"; printf '%s\\n' "$2" > "$d/.env"; cd "$d";`
      + ` source <(sed -n '/^envv()/,/^}/p' "$1");`
      + ` envv ALFA_OAUTH_API_BASE; envv ALFA_OAUTH_API_PREFIX; rm -rf "$d"`,
      '_', SCRIPT_PATH, env
    ], { encoding: 'utf8' }).split('\n')
    // ⚠ Кавычки внутри значения давали `curl` адрес `"https://host:8273"/partner/…`, и банк
    // отвечал «Port number was not a decimal number» — ошибка указывала на порт, а не на кавычки.
    expect(out[0]).toBe('https://developerhub.alfabank.by:8273')
    expect(out[1]).toBe('/partner/1.2.0')
  })
})

describe('#561 проба: гарантии, которые обещает шапка', () => {
  it('не пишет ни в базу, ни в банк', () => {
    expect(SCRIPT, 'появился пишущий SQL').not.toMatch(/\b(INSERT|UPDATE|DELETE|DROP|ALTER)\b/i)
    expect(SCRIPT, 'появился не-GET запрос').not.toMatch(/curl[^\n]*(-X|--request|--data|-d\s|-F\s)/)
  })

  it('refresh-токен не выбирается запросом — свойство структурное, а не обещание', () => {
    expect(SCRIPT).not.toContain('refresh_token')
    expect(SCRIPT).toContain('SELECT account_key, access_token')
  })

  it('проверка сертификата банка не отключается', () => {
    expect(SCRIPT).not.toMatch(/--insecure|(^|\s)-k(\s|$)|CURL_CA_BUNDLE|SSL_CERT_/m)
  })

  it('ни токен, ни номер счёта не уходят в аргументы curl', () => {
    // ⚠ argv виден любому процессу через /proc/<pid>/cmdline и оседает в журнале аудита execve.
    // Заголовок и URL передаются конфигом через stdin (`curl -K -`).
    expect(SCRIPT, 'заголовок вернулся в аргументы').not.toMatch(/curl[^\n]*-H\s/)
    expect(SCRIPT, 'URL вернулся в аргументы').not.toMatch(/curl[^\n]*"\$\{?URL/)
    expect(SCRIPT).toMatch(/curl -K -/)
  })

  it('день проверяется ДО первого обращения к docker', () => {
    let code = 0
    let out: string
    try {
      out = execFileSync('bash', [SCRIPT_PATH, '3d'], { encoding: 'utf8', stdio: 'pipe' })
    } catch (e) {
      const err = e as { status?: number, stdout?: string }
      code = err.status ?? 0
      out = err.stdout ?? ''
    }
    expect(code, 'скрипт не остановился на негодном дне').toBe(2)
    expect(out).toMatch(/ГГГГ-ММ-ДД/)
  })
})
