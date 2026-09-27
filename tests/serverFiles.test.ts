import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

// Сервер ВМ Битрикс24 держит ВЫБОРОЧНУЮ копию клиентского репозитория: только файлы из
// deploy/bitrixvm/server-files.txt (решение владельца 2026-09-27 — «зачем тянуть весь репо»).
//
// ⚠ Отказ здесь молчаливый и отложенный: make-цель, чей скрипт не попал в список, на сервере
// падает с «файл не найден» — через месяц, у клиента, при первой диагностике. Поэтому список
// сверяется с тем, КТО файлы читает: Makefile (`$(RAW)/…`, `$(SRC)/…`) и инструкция (`src/…`).
// И в обратную сторону — лишнего в списке нет: «на сервере только нужное» тоже обещание.

const ROOT = join(import.meta.dirname, '..')
const LIST_PATH = 'deploy/bitrixvm/server-files.txt'
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')
const DOC = readFileSync(join(ROOT, 'docs/DEPLOY_BITRIXVM.md'), 'utf8')
const ENTRIES = readFileSync(join(ROOT, LIST_PATH), 'utf8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))

/** Покрыт ли путь (от корня репозитория, без ведущего «/») списком. */
const covered = (path: string) => ENTRIES.some(e => e.endsWith('/') ? `/${path}`.startsWith(e) : e === `/${path}`)

describe('server-files.txt: на сервере ровно то, что читается', () => {
  it('каждый скрипт, который зовёт Makefile, есть в списке', () => {
    const scripts = [...MAKEFILE.matchAll(/\$\(RAW\)\/([A-Za-z0-9_.-]+)/g)].map(m => `scripts/${m[1]}`)
    expect(scripts.length).toBeGreaterThan(5)
    for (const s of new Set(scripts)) expect(covered(s), s).toBe(true)
  })

  it('файлы, которые Makefile берёт через $(SRC), есть в списке', () => {
    const files = [...MAKEFILE.matchAll(/\$\(SRC\)\/([A-Za-z0-9_.-]+\.[A-Za-z]+|Makefile)/g)].map(m => m[1])
    expect(files).toContain('Makefile')
    for (const f of new Set(files)) expect(covered(f), f).toBe(true)
  })

  it('каждый путь src/… и /home/bitrix/bank-import/src/… из инструкции есть в списке', () => {
    const paths = [...DOC.matchAll(/(?:\/home\/bitrix\/bank-import\/)?\bsrc\/([A-Za-z0-9_./-]+)/g)]
      .map(m => m[1].replace(/[.,)]+$/, ''))
      .filter(p => !p.startsWith('.git'))
    expect(paths.length).toBeGreaterThan(3)
    for (const p of new Set(paths)) expect(covered(p), p).toBe(true)
  })

  it('каждая запись существует, а скрипты в списке — только те, что зовёт Makefile', () => {
    for (const e of ENTRIES) expect(existsSync(join(ROOT, e)), e).toBe(true)
    const called = new Set([...MAKEFILE.matchAll(/\$\(RAW\)\/([A-Za-z0-9_.-]+)/g)].map(m => `/scripts/${m[1]}`))
    expect(ENTRIES.filter(e => e.startsWith('/scripts/') && !called.has(e))).toEqual([])
  })
})

// ⚠ Проверяется ВЫЗОВОМ git и настоящего make: формат шаблонов (ведущий «/», каталог со «/»),
// порядок «сперва список, потом по списку» и повторное применение в `self-update` — три места,
// где текстовый гард подтвердил бы строку, которая не работает.
describe('выборочная копия: клонирование и self-update', () => {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })

  function origin(): string {
    const dir = mkdtempSync(join(tmpdir(), 'srv-origin-'))
    for (const e of ENTRIES) {
      const rel = e.slice(1).replace(/\/$/, '')
      mkdirSync(dirname(join(dir, rel)), { recursive: true })
      cpSync(join(ROOT, rel), join(dir, rel), { recursive: true })
    }
    mkdirSync(join(dir, 'app'))
    writeFileSync(join(dir, 'app', 'secret-source.ts'), 'исходник приложения\n')
    writeFileSync(join(dir, 'scripts', 'not-for-server.mjs'), 'dev\n')
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'config', 'uploadpack.allowFilter', 'true')
    git(dir, 'add', '-A')
    git(dir, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
    return dir
  }

  const files = (src: string) =>
    execFileSync('find', ['.', '-type', 'f', '-not', '-path', './.git/*'], { cwd: src, encoding: 'utf8' })
      .split('\n').filter(Boolean).map(f => f.slice(2)).sort()

  it('шаг 1b кладёт только файлы из списка, self-update доносит новый', () => {
    const repo = origin()
    const stack = mkdtempSync(join(tmpdir(), 'srv-stack-'))
    // Та же последовательность, что в шаге 1b инструкции.
    git(stack, 'clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', `file://${repo}`, 'src')
    const src = join(stack, 'src')
    git(src, 'sparse-checkout', 'set', '--no-cone', `/${LIST_PATH}`)
    git(src, 'checkout', '-q')
    execFileSync('sh', ['-c', `git -C src sparse-checkout set --no-cone --stdin < src/${LIST_PATH}`], { cwd: stack })

    const got = files(src)
    expect(got).toContain('Makefile')
    expect(got).toContain('scripts/prod-doctor.sh')
    expect(got).not.toContain('app/secret-source.ts')
    expect(got).not.toContain('scripts/not-for-server.mjs')
    for (const e of ENTRIES.filter(x => !x.endsWith('/'))) expect(got, e).toContain(e.slice(1))

    // Новая версия добавила скрипт в список — `make self-update` обязан его донести.
    writeFileSync(join(repo, 'scripts', 'new-target.sh'), 'echo new\n')
    writeFileSync(join(repo, LIST_PATH), readFileSync(join(repo, LIST_PATH), 'utf8') + '/scripts/new-target.sh\n')
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'new target')

    cpSync(join(src, 'Makefile'), join(stack, 'Makefile'))
    execFileSync('make', ['--no-print-directory', 'self-update'], { cwd: stack, encoding: 'utf8' })
    const after = files(src)
    expect(after).toContain('scripts/new-target.sh')
    expect(after).not.toContain('app/secret-source.ts')
  })
})
