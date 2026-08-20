import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Гард операторского входа (замечание владельца, 2026-08-20).
//
// ⚠ `Makefile` — единственный интерфейс к серверу: репозитория там нет, только он, `.env` и
// `docker-compose.prod.yml`. Пока цель не описана и не видна в `make help`, оператор о ней не
// узнает и наберёт сырую команду руками — что и происходило: я раз за разом диктовал
// `docker compose …` и `curl … | bash` там, где уже была готовая цель.
//
// Ловушка не гипотетическая: описание `##` и сама цель разъезжаются молча. Вставь новый блок между
// ними — и цель пропадает из справки, оставаясь рабочей. Так уже случилось дважды за одну правку.

const ROOT = join(import.meta.dirname, '..')
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')

/** Цели, объявленные в файле (левая часть до двоеточия, в начале строки). */
function targets(): string[] {
  return [...MAKEFILE.matchAll(/^([a-z][a-z-]*):/gm)].map(m => m[1]!)
}

/** Цели, у которых описание `## …` стоит ВПЛОТНУЮ (тем же приёмом, что и `make help`: последняя
 *  строка `##` достаётся ближайшей следующей цели). */
function documented(): string[] {
  const out: string[] = []
  let desc = ''
  for (const line of MAKEFILE.split('\n')) {
    if (line.startsWith('## ')) desc = line.slice(3)
    else {
      const m = /^([a-z][a-z-]*):/.exec(line)
      if (m && desc) {
        out.push(m[1]!)
        desc = ''
      }
    }
  }
  return out
}

describe('операторские цели Makefile видны в `make help`', () => {
  it('файл читается и цели находятся', () => {
    expect(targets().length).toBeGreaterThan(8)
    expect(targets()).toContain('doctor')
  })

  it('каждая операторская цель ОПИСАНА и попадёт в справку', () => {
    // ⚠ Список закрытый: цель, которую оператор запускает на сервере, обязана быть в справке.
    // Служебные (`dev`, `build-local`) сюда не входят — их запускают из репозитория.
    const OPERATOR = ['prod-up', 'prod-down', 'prod-pull', 'prod-redeploy', 'logs', 'ps',
      'doctor', 'queue-stats', 'prior-probe', 'prior-switch', 'poll-check', 'self-update', 'help',
      'gw-stop', 'gw-start', 'compose-update']
    const shown = documented()
    for (const t of OPERATOR) {
      expect(targets(), `цели ${t} нет в Makefile`).toContain(t)
      expect(shown, `цель ${t} не попадёт в make help — описание оторвано от цели`).toContain(t)
    }
  })

  it('`self-update` существует — без него остальные цели на сервер не доедут', () => {
    // ⚠ Корень исходной проблемы. Makefile кладётся на сервер один раз и дальше живёт своей
    // жизнью, поэтому новая цель в репозитории на сервере просто не существует.
    expect(MAKEFILE).toContain('self-update:')
    // Обновление обязано сохранять копию и проверять скачанное ДО замены: битый Makefile лишает
    // сервер единственного интерфейса. Чем именно проверяет — в отдельном тесте ниже.
    expect(MAKEFILE).toMatch(/Makefile\.bak-/)
  })

  it('обновляющие цели проверяют скачанное ДО замены', () => {
    // ⚠ Обе тянут файл, от которого зависит управляемость сервера. Битый ответ прокси (HTML вместо
    // файла) молча оставил бы стенд без рабочего Makefile или без валидного compose — и выяснилось
    // бы это в следующий раз, когда что-то понадобится срочно.
    const su = MAKEFILE.slice(MAKEFILE.indexOf('\nself-update:'), MAKEFILE.indexOf('\n## Остановить крипто-шлюз'))
    expect(su, 'self-update не проверяет скачанное').toMatch(/grep -q '\^\\\.PHONY:'/)
    // ⚠ Проверка обязана переживать ЛЮБУЮ версию файла: первая редакция сверялась по цели `help`,
    // добавленной той же правкой, и bootstrap на живом сервере отказался ставить обновление,
    // потому что для установки новой цели ему требовалась новая цель.
    expect(su, 'self-update сверяется по свежей цели, а не по давней').toMatch(/prod-redeploy/)
    expect(su).not.toMatch(/make -n -f "\$\$t" help/)
    const cu = MAKEFILE.slice(MAKEFILE.indexOf('\ncompose-update:'))
    expect(cu, 'compose-update не валидирует compose').toMatch(/config -q/)
    // Замена только по явному подтверждению: файл правят руками, слепая замена уничтожила бы
    // настройку, о которой никто не помнит.
    // ⚠ Пинится САМО УСЛОВИЕ, а не упоминание переменной: слово `CONFIRM` встречается ещё и в
    // подсказке «Применить: make compose-update CONFIRM=1», поэтому проверка на вхождение
    // проходила даже при условии, выключённом в `if true` (поймано мутацией).
    expect(cu, 'compose-update заменяет без подтверждения').toMatch(/if \[ "\$\(CONFIRM\)" = "1" \]; then/)
    expect(cu).toMatch(/\.bak-/)
  })

  it('цели, зовущие скрипты, тянут их из того же REF', () => {
    // Иначе `self-update` обновит Makefile из одной ветки, а скрипты приедут из другой.
    for (const t of ['prior-probe', 'prior-switch', 'poll-check']) {
      const i = MAKEFILE.indexOf(`\n${t}:`)
      const body = MAKEFILE.slice(i, i + 400)
      expect(body, `${t} не использует $(RAW)`).toMatch(/\$\(RAW\)/)
    }
  })
})
