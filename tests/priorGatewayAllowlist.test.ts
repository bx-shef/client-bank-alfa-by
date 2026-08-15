import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Список разрешённых маршрутов крипто-шлюза живёт в ЧЕТЫРЁХ местах, и ни одно из них не ссылается
// на другие:
//
//   - `docker-compose.prod.yml` — узкое умолчание (токен + ресурсный API), то, с чем шлюз работает
//     каждый день;
//   - `.env.example` и `docs/OPERATIONS.md` — расширенный список на время РАЗОВОЙ регистрации
//     приложения через DCR;
//   - `scripts/prod-doctor.sh` — путь, которым диагностика проверяет, что трафик доходит до банка.
//
// ⚠ Расхождение здесь опаснее, чем выглядит, потому что переменная у шлюза ЗАМЕНЯЕТ список, а не
// дополняет его. Кто-то оформит расширенный список без прежних двух записей — и разовая операция
// молча остановит ежедневный опрос выписки. Оба документа об этом предупреждают текстом; тест
// проверяет, что предупреждение соблюдено.
//
// Тот же приём, что в `bankRouteTimeouts.test.ts`: сверяем статические файлы между собой там, где
// связь есть по смыслу, но её никто не выражает кодом.

const ROOT = join(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/** Узкое умолчание — подстановка внутри `GW_ALLOW` в compose (блок может быть закомментирован). */
const narrow = /GW_ALLOW:\s*\$\{PRIOR_GW_ALLOW:-(.+?)\}/.exec(read('docker-compose.prod.yml'))?.[1] ?? ''
/** Расширенный список из примера окружения. */
const fromEnv = /^#\s*PRIOR_GW_ALLOW=(.+)$/m.exec(read('.env.example'))?.[1]?.trim() ?? ''
/** Он же из рантбука. */
const fromOps = /^\s*PRIOR_GW_ALLOW=(.+)$/m.exec(read('docs/OPERATIONS.md'))?.[1]?.trim() ?? ''
// Пробы достаём ПО ИМЕНИ переменной, а не по порядку в файле: проб теперь две, и позиционный
// поиск однажды уже вытащил не ту.
const doctor = read('scripts/prod-doctor.sh')
const probeUrl = (varName: string) =>
  new RegExp(`${varName}=\\$\\(.*crypto-gw:1080(/[^'"]*)`).exec(doctor)?.[1] ?? ''
/** Путь, которым проверяется, что банк ОТВЕЧАЕТ через шлюз. */
const probePath = probeUrl('probe')
/** Путь, который шлюз обязан ОТБИТЬ, — иначе список не применяется. */
const deniedPath = probeUrl('denied')

/** Пути из записи вида `POST =/точный/путь` или `GET,POST /префикс/`. */
function paths(list: string): string[] {
  return list.split(';').map(e => e.trim()).filter(Boolean)
    .map(e => e.split(/\s+/).pop() ?? '')
    .map(p => p.replace(/^=/, ''))
    .filter(Boolean)
}

describe('список маршрутов крипто-шлюза согласован между файлами', () => {
  it('все четыре источника вообще нашлись — иначе тест зелен на пустоте', () => {
    // Регулярка, переставшая находить свою строку, молча превратила бы каждую проверку ниже в
    // сравнение двух пустых строк. Поэтому наличие проверяется первым и отдельно.
    expect(narrow, 'умолчание в docker-compose.prod.yml').not.toBe('')
    expect(fromEnv, 'расширенный список в .env.example').not.toBe('')
    expect(fromOps, 'расширенный список в docs/OPERATIONS.md').not.toBe('')
    expect(probePath, 'позитивная проба в scripts/prod-doctor.sh').not.toBe('')
    expect(deniedPath, 'негативная проба в scripts/prod-doctor.sh').not.toBe('')
  })

  it('расширенный список ДОПОЛНЯЕТ умолчание, а не заменяет его', () => {
    // Ровно та ошибка, о которой предупреждают оба документа: оформить DCR-список без прежних
    // записей — и опрос выписки встанет ради разовой операции, причём молча.
    expect(fromEnv.startsWith(narrow)).toBe(true)
    for (const p of paths(narrow)) expect(paths(fromEnv)).toContain(p)
  })

  it('пример окружения и рантбук несут ОДНУ строку — расходиться им нельзя', () => {
    // Их читают в разное время и разные люди: `.env.example` при развёртывании, рантбук в момент
    // процедуры. Разойдутся — кто-то возьмёт устаревшую.
    expect(fromEnv).toBe(fromOps)
  })

  it('проба диагностики бьёт в путь, который открыт УМОЛЧАНИЕМ', () => {
    // Если проба уедет на маршрут из расширенного списка, `prod-doctor` начнёт ругаться на любом
    // стенде, где расширение снято, — то есть на всех, где всё в порядке.
    expect(paths(narrow).some(p => probePath.startsWith(p))).toBe(true)
  })

  it('негативная проба бьёт в путь, которого нет НИ В ОДНОМ списке', () => {
    // Иначе она однажды начнёт получать 404 не потому, что enforcement работает, а потому что
    // путь и правда открыт — и проверка станет зелёной по неверной причине.
    for (const list of [narrow, fromEnv]) {
      expect(paths(list).some(p => deniedPath.startsWith(p))).toBe(false)
    }
  })
})
