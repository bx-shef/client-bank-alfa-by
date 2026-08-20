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
      'doctor', 'queue-stats', 'prior-probe', 'prior-switch', 'poll-check', 'self-update', 'help']
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
    // сервер единственного интерфейса.
    expect(MAKEFILE).toMatch(/Makefile\.bak-/)
    expect(MAKEFILE).toMatch(/make -n -f "\$\$t" help/)
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
