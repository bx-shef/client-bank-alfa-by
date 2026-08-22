import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

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
  const verdict = (p0: string, p1: string, same: string) => callFn('verdict', p0, p1, same)
  const STATES = ['1', '0', '-1', ''] as const

  it('непустая И ОТЛИЧАЮЩАЯСЯ вторая страница при ПРОЧИТАННОЙ первой — потеря доказана', () => {
    // ⚠ Живой урок первого боевого прогона: непустая страница 1 сама по себе НЕ доказательство —
    // при прочтении «0 = все» банк повторяет ту же выдачу на любой странице, и старый вердикт
    // объявил «потери доказаны» про день с одной операцией. RED требует сравнения двух
    // ПРОЧИТАННЫХ страниц; сравнение мусора с данными сравнением двух страниц не является.
    expect(verdict('0', '0', '0')).toBe('RED')
    expect(verdict('1', '0', '0')).toBe('RED')
    for (const p0 of ['-1', '']) expect(verdict(p0, '0', '0'), `P0=${p0 || '<пусто>'}`).toBe('INCONCLUSIVE')
  })

  it('страница 1 повторяет страницу 0 байт-в-байт — «0» означает ВСЕ, а не потерю', () => {
    expect(verdict('0', '0', '1')).toBe('GREEN-REPEAT')
  })

  it('непустая страница 1 БЕЗ сравнения содержимого — не вердикт', () => {
    // Сравнить было нечего (одна из страниц не дожила до FLAT) ⇒ честное «не знаем».
    expect(verdict('0', '0', '')).toBe('INCONCLUSIVE')
  })

  it('зелёный вердикт требует ОБЕИХ известных страниц', () => {
    expect(verdict('0', '1', '0')).toBe('GREEN')
    // ⚠ Ни одно неизвестное состояние не должно давать «потерь не было»: цена ошибки в эту
    // сторону — молча вернуть стоимость задачи к 1 и снова терять операции.
    for (const p0 of ['-1', '']) expect(verdict(p0, '1', '0')).toBe('INCONCLUSIVE')
    for (const p1 of ['-1', '']) expect(verdict('0', p1, '0')).toBe('INCONCLUSIVE')
  })

  it('обе страницы пусты — операций не было, проба ничего не доказывает', () => {
    expect(verdict('1', '1', '1')).toBe('NODATA')
  })

  it('вся таблица 4×4×{0,1,пусто} разобрана — уверенный вердикт только на полных данных', () => {
    const table = STATES.flatMap(p0 => STATES.flatMap(p1 =>
      ['0', '1', ''].map(same => [p0, p1, same, verdict(p0, p1, same)] as const)))
    expect(table).toHaveLength(48)
    for (const [p0, p1, same, v] of table) {
      expect(['RED', 'GREEN', 'GREEN-REPEAT', 'NODATA', 'INCONCLUSIVE']).toContain(v)
      // Любой уверенный вердикт запрещён, пока хоть одна страница не прочитана.
      if (p0 === '' || p1 === '' || p0 === '-1' || p1 === '-1') {
        expect(v, `P0=${p0} P1=${p1} same=${same}`).toBe('INCONCLUSIVE')
      }
      // RED обязан опираться на доказанное РАЗЛИЧИЕ страниц, не на непустоту.
      if (v === 'RED') expect(same).toBe('0')
    }
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

describe('совпадение тел на пустом дне (#561) — ПРОГОНОМ, а не грепом', () => {
  // ⚠ Первая редакция этой проверки грепала исходник регуляркой, и мутационный прогон показал,
  // что она даёт обе ошибки сразу. Пропускала настоящий баг: ПЕРЕСТАНОВКА тел двух веток
  // оставляла все нужные строки в блоке, тест зеленел, а на пустом дне возвращалось дословно то
  // самое «банк проигнорировал pageNo», ради снятия которого правка и делалась. И краснела на
  // верном коде: переставленные операнды сравнения, `case` вместо `if`, форма `[ "x$P0" = "x0" ]`,
  // переформулированное сообщение и даже реиндент блока — пять тождественных переписок.
  // Поэтому проверяем НАПЕЧАТАННОЕ: скрипт целиком прогоняется на подставных `docker` и `curl`.
  // Побочно это накрывает и вычисление `SAME`, и передачу его в `verdict` — то есть места, где
  // сломан вызов, а не функция, и которые изолированные вызовы функций не видят в принципе.
  const EMPTY = '{"page":[]}'
  const OPS = '{"page":[{"docId":"1","amount":"10.00"}]}'
  const OTHER = '{"page":[{"docId":"2","amount":"20.00"}]}'
  const GARBAGE = '{"error":"maintenance"}'

  /** Прогнать скрипт целиком, подсунув ему ответы банка на страницы 0 и 1. */
  function runProbe(page0: string, page1: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'alfa-probe-'))
    try {
      writeFileSync(join(dir, 'docker-compose.prod.yml'), '')
      writeFileSync(join(dir, 'page0.json'), page0)
      writeFileSync(join(dir, 'page1.json'), page1)
      const bin = join(dir, 'bin')
      mkdirSync(bin)
      // Стаб базы: отдаёт счёт и токен в том же формате `-At -F'|'`, что читает скрипт.
      writeFileSync(join(bin, 'docker'), '#!/bin/sh\necho "BY00TESTACCOUNT0000000000001|test-token"\n')
      // Стаб банка: читает конфиг `-K -` со stdin и отвечает фикстурой по номеру страницы.
      writeFileSync(join(bin, 'curl'), [
        '#!/bin/sh',
        'cfg="$(cat)"',
        'case "$cfg" in *"pageNo=1"*) cat "$FIXTURES/page1.json";; *) cat "$FIXTURES/page0.json";; esac'
      ].join('\n') + '\n')
      chmodSync(join(bin, 'docker'), 0o755)
      chmodSync(join(bin, 'curl'), 0o755)
      return execFileSync('bash', [SCRIPT_PATH], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, FIXTURES: dir, DAY: '2026-08-18' }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('день без операций: совпадение пустых тел не выдаётся за игнор pageNo', () => {
    // ⚠ Замерено на живом проде (2026-08-18, день без операций): обе страницы пусты, тела
    // совпадают по скучной причине — сравнивать нечего, — а проба уверенно печатала «банк
    // проигнорировал pageNo». Пятью строками ниже её же вердикт говорил «проба ничего не
    // доказывает», то есть скрипт противоречил сам себе, и первым читают верхнюю строку.
    const out = runProbe(EMPTY, EMPTY)
    expect(out, 'проба снова выдаёт совпадение пустых тел за игнор pageNo').not.toContain('проигнорировал pageNo')
    expect(out, 'на пустом дне молчание вместо объяснения').toContain('сравнивать было нечего')
    expect(out).toContain('операций нет вовсе')
  })

  it('день с операциями и совпавшими телами: игнор pageNo назван прямо', () => {
    const out = runProbe(OPS, OPS)
    expect(out, 'настоящий повтор страниц перестал опознаваться').toContain('проигнорировал pageNo')
    expect(out).toContain('«0» означает ВСЕ')
  })

  it('страницы РАЗЛИЧАЮТСЯ — потеря доказана, и повтор не объявляется', () => {
    // ⚠ Ловит мутацию «SAME всегда 1»: она превращала доказанную потерю операций в бодрое
    // «потерь не было, стоимость задачи можно вернуть к 1» — самая дорогая ошибка этой пробы.
    const out = runProbe(OPS, OTHER)
    expect(out).toContain('означает СТРАНИЦУ')
    expect(out).not.toContain('проигнорировал pageNo')
  })

  it('неразобравшийся ответ не выдаётся за пустую страницу', () => {
    // ⚠ Та же болезнь, что чинил #561, только тише: строкой выше проба говорит «банк ответил чем-то
    // другим», а строкой ниже прежняя редакция утверждала «обе страницы пусты» — они не пусты, их
    // не удалось разобрать.
    const out = runProbe(GARBAGE, GARBAGE)
    expect(out).toContain('нет ключа page[]')
    expect(out, 'неопознанный ответ снова назван пустой страницей').not.toContain('операций в ответе нет ни на той')
    expect(out).toContain('не разобрались одинаково')
  })
})
