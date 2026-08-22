import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TOKEN_EXCHANGE_TIMEOUT_MS } from '../server/utils/bankConnectCallback'

// Guard for a drift that is invisible from either side alone (#482).
//
// The bank callback waits `TOKEN_EXCHANGE_TIMEOUT_MS` for the code→token exchange. That number is
// only real if every proxy in front of it waits longer. The default backend profile caps a request
// at 30s — right for the fast routes it was written for — and a location inherits that silently. So
// raising the constant alone changes NOTHING in production: nginx still cuts at 30s, the account
// holder gets a bare `504` instead of our page, and the backend keeps running and may save the token
// seconds AFTER they were told it failed and went to retry.
//
// Neither half is wrong by itself and neither file names the other, which is why this is a test and
// not a comment. Three reviewers found it by reading; nothing would have caught it the next time.
//
// ⚠ Not covered here: the SHARED edge proxy (nginx-proxy) in front of this container. Its default is
// nginx's own 60s and this repository does not configure it — hence the upper bound below, which
// keeps our timeout the one that fires.

const ROOT = join(import.meta.dirname, '..')
const NGINX = readFileSync(join(ROOT, 'nginx.conf'), 'utf8')

/** Seconds from the single `proxy_read_timeout` in a snippet profile. */
function profileSec(file: string): number {
  const src = readFileSync(join(ROOT, 'snippets', file), 'utf8')
  return Number(/proxy_read_timeout\s+(\d+)s\s*;/.exec(src)?.[1] ?? '')
}

/** The snippet an exact-match location includes. */
function includedProfile(path: string): string | null {
  const start = NGINX.indexOf(`location = ${path} {`)
  if (start < 0) return null
  const end = NGINX.indexOf('\n    }', start)
  return /include\s+snippets\/(\S+?)\s*;/.exec(NGINX.slice(start, end < 0 ? undefined : end))?.[1] ?? null
}

/** The edge proxy is not ours to configure; nginx's compiled-in default is what we must fit under. */
const EDGE_DEFAULT_SEC = 60

const BANK_ROUTES = ['/api/bank/callback', '/api/bank/connect']

describe('таймауты банковских маршрутов согласованы между кодом и nginx (#482)', () => {
  const fastSec = profileSec('proxy-backend.conf')
  const slowSec = profileSec('proxy-backend-slow.conf')

  it('профиля два, и быстрый действительно короче нашего ожидания', () => {
    // Если сравнять их, «терпеливый» профиль станет украшением: банковский маршрут будет резаться
    // ровно там же, где и раньше, а имя файла будет утверждать обратное.
    expect(fastSec).toBeGreaterThan(0)
    expect(slowSec).toBeGreaterThan(fastSec)
    expect(fastSec * 1000).toBeLessThan(TOKEN_EXCHANGE_TIMEOUT_MS)
  })

  it.each(BANK_ROUTES)('%s включает терпеливый профиль, а не общий', (path) => {
    expect(includedProfile(path)).toBe('proxy-backend-slow.conf')
  })

  it('порядок бюджета: наш код < наш nginx < чужой edge', () => {
    // Каждое звено должно ждать дольше предыдущего, иначе отказ придёт от того, кто выше по
    // цепочке, и человек увидит чужую страницу вместо нашей — на шаге, где он уже ввёл пароль
    // от своего банка.
    expect(TOKEN_EXCHANGE_TIMEOUT_MS).toBeLessThan(slowSec * 1000)
    expect(slowSec).toBeLessThanOrEqual(EDGE_DEFAULT_SEC)
  })

  it('ядро профилей не задаёт таймаут само — nginx отвергает дубль директивы', () => {
    // Это не стилистика: `proxy_read_timeout` дважды в одном контексте — «directive is duplicate»,
    // и образ не собирается (`nginx -t` в Dockerfile). Ровно так и выяснилось, что переопределить
    // значение поверх include нельзя, и появились два профиля.
    // ⚠ Считаем ДИРЕКТИВЫ, а не слова: все три файла обсуждают таймаут в комментариях, и наивный
    // поиск по тексту объявил бы ядро нарушителем за то, что оно объясняет правило.
    const directives = (file: string): string[] =>
      readFileSync(join(ROOT, 'snippets', file), 'utf8')
        .split('\n')
        .filter(line => /^\s*proxy_read_timeout\s/.test(line))

    expect(directives('proxy-backend-core.conf')).toEqual([])
    for (const file of ['proxy-backend.conf', 'proxy-backend-slow.conf']) {
      expect(readFileSync(join(ROOT, 'snippets', file), 'utf8')).toContain('include snippets/proxy-backend-core.conf;')
      expect(directives(file)).toHaveLength(1)
    }
  })
})

describe('каждый админский маршрут в портал дросселируется nginx (#576, находка ревью)', () => {
  // ⚠ Гард заведён потому, что новый маршрут `/api/bank/pause` его НЕ имел, и это никто не заметил:
  // без своего `location =` он проваливается в общий `location /api/`, где `limit_req` нет вовсе.
  // А каждый из этих маршрутов на запрос делает вызов `profile` В ПОРТАЛ КЛИЕНТА и обращение к
  // нашей БД — то есть незадросселированный роут это усилитель нагрузки и на нас, и на портал.
  //
  // ⚠ Список ОТКРЫТЫЙ намеренно, в отличие от `adminGatedRoutes`: там требуется решение «кто может»,
  // а здесь решение одно на всех — троттл нужен каждому. Поэтому проверяем ВСЕ файлы маршрутов,
  // какие есть на диске, а не перечисленные руками: перечисление руками и есть тот способ, которым
  // следующий маршрут снова окажется без защиты.
  const nginx = readFileSync(join(process.cwd(), 'nginx.conf'), 'utf8')
  const bank = readdirSync(join(process.cwd(), 'server/api/bank'))
    .filter(f => /\.(get|post)\.ts$/.test(f))
    .map(f => `bank/${f.replace(/\.(get|post)\.ts$/, '')}`)
  // ⚠ Стирание дел (#576 п.4) — не банковский маршрут, но тот же класс: админский, ходит в портал,
  // а стирание вдобавок НЕОБРАТИМО. Правило одно, поэтому и проверка одна.
  const activities = readdirSync(join(process.cwd(), 'server/api/activities'))
    .filter(f => /\.(get|post)\.ts$/.test(f))
    .map(f => `activities/${f.replace(/\.(get|post)\.ts$/, '')}`)
  const routes = [...bank, ...activities]

  it('на диске есть маршруты — иначе тест ничего не проверяет', () => {
    expect(routes.length).toBeGreaterThan(0)
  })

  for (const name of routes) {
    it(`/api/${name} — свой location с limit_req`, () => {
      const block = new RegExp(`location = /api/${name}\\s*\\{([^}]*)\\}`)
      const m = block.exec(nginx)
      expect(m, `нет блока location = /api/${name} в nginx.conf`).not.toBeNull()
      expect(m![1]).toMatch(/limit_req\s+zone=/)
    })
  }
})
