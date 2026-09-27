import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync as mkdtempRaw, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Временные каталоги файла убираются после прогона: иначе каждый запуск оставлял бы в /tmp
// десятки каталогов с подставными docker/flock.
const temps: string[] = []
const mkdtempSync = (prefix: string) => {
  const d = mkdtempRaw(prefix)
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

// Операторские цели на ВМ Битрикс24 (docs/DEPLOY_BITRIXVM.md).
//
// ⚠ Две поломки, обе молчаливые. Первая: все прод-цели передавали `-f docker-compose.prod.yml`, а
// явный `-f` отбрасывает `COMPOSE_FILE` из `.env`. На ВМ там перечислен оверлей (порт на
// 127.0.0.1, образы КЛИЕНТА), и `make prod-redeploy` поднял бы приложение без порта на loopback и
// backend из нашего образа. Вторая: `deploy-*` не знали варианта с cron под `bitrix` (теперь
// единственного — systemd-вариант снят), и оператору оставались сырые команды.
//
// ⚠ Проверяется ВЫЗОВОМ настоящего make, а не чтением текста: ветвление живёт в трёх слоях
// раскрытия (make → sh → условие), и текстовый гард подтвердил бы строку, которая не срабатывает.

const ROOT = join(import.meta.dirname, '..')
const MAKEFILE = readFileSync(join(ROOT, 'Makefile'), 'utf8')
const POLLER = join(ROOT, 'deploy/bitrixvm/git-poll-deploy.sh')

function stackDir(dotenv: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'mk-compose-'))
  writeFileSync(join(dir, 'Makefile'), MAKEFILE)
  if (dotenv !== null) writeFileSync(join(dir, '.env'), dotenv)
  return dir
}

/** Команды compose, которые make ВЫПОЛНИЛ БЫ (`-n` — только печать). */
function dryRun(dir: string, target: string): string[] {
  return execFileSync('make', ['--no-print-directory', '-n', target], { cwd: dir, encoding: 'utf8' })
    .split('\n').filter(l => l.includes('docker compose'))
}

// ⚠ У этих целей `docker compose` — не первое слово строки, а АРГУМЕНТ скрипту: `bash "$t" "$(DC)"`.
// Подмена `$(DC)` на жёсткий `-f` (хоть в рецепте, хоть целевой переменной над ним) текстовым
// поиском по рецепту не ловится — замерено мутацией, — поэтому проверка та же: настоящий make -n.
describe('цели, передающие $(DC) скрипту аргументом, тоже уважают COMPOSE_FILE', () => {
  const ARG_TARGETS = ['queue-stats', 'feedback-on', 'alfa-currency-probe']

  it.each(ARG_TARGETS)('%s: без COMPOSE_FILE — прежний -f docker-compose.prod.yml', (t) => {
    const lines = dryRun(stackDir('DOMAIN=x.by\n'), t)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some(l => l.includes('"docker compose -f docker-compose.prod.yml"'))).toBe(true)
  })

  it.each(ARG_TARGETS)('%s: с COMPOSE_FILE — без -f, оверлей не теряется', (t) => {
    const lines = dryRun(stackDir('COMPOSE_FILE=docker-compose.prod.yml:docker-compose.bitrixvm.yml\n'), t)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).not.toMatch(/docker compose -f /)
  })
})

describe('прод-цели собирают стек файлами из COMPOSE_FILE, если он задан', () => {
  const TARGETS = ['prod-up', 'prod-down', 'prod-pull', 'prod-redeploy', 'logs', 'ps', 'gw-stop', 'gw-start', 'reap-off']

  it.each(TARGETS)('%s: без COMPOSE_FILE — прежняя команда с -f', (t) => {
    const lines = dryRun(stackDir('DOMAIN=x.by\n'), t)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).toContain('docker compose -f docker-compose.prod.yml ')
  })

  it.each(TARGETS)('%s: с COMPOSE_FILE — без -f, оверлей не теряется', (t) => {
    const lines = dryRun(stackDir('COMPOSE_FILE=docker-compose.prod.yml:docker-compose.bitrixvm.yml\n'), t)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l).not.toMatch(/docker compose -f /)
  })

  it('закомментированная строка и отсутствие .env — как на классическом сервере', () => {
    expect(dryRun(stackDir('# COMPOSE_FILE=a.yml:b.yml\n'), 'ps')).toEqual(['docker compose -f docker-compose.prod.yml ps'])
    expect(dryRun(stackDir(null), 'ps')).toEqual(['docker compose -f docker-compose.prod.yml ps'])
  })

  it('ни одна цель не зашивает -f docker-compose.prod.yml мимо переменной', () => {
    const recipes = MAKEFILE.split('\n').filter(l => l.startsWith('\t'))
    expect(recipes.filter(l => l.includes('-f docker-compose.prod.yml'))).toEqual([])
  })
})

describe('deploy-*: автообновление cron под bitrix', () => {
  function cronHome(): { dir: string, home: string } {
    const dir = stackDir(null)
    const home = join(dir, 'home')
    mkdirSync(join(home, 'bank-app-deploy'), { recursive: true })
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, 'bank-app-deploy', 'deploy.env'), '')
    const fake = join(home, 'bin', 'bank-app-deploy')
    writeFileSync(fake, '#!/bin/sh\necho "RUN ignore=$BANK_APP_DEPLOY_IGNORE_PAUSE wait=$BANK_APP_DEPLOY_LOCK_WAIT cfg=$BANK_APP_DEPLOY_CONFIG state=$BANK_APP_DEPLOY_STATE"\n')
    chmodSync(fake, 0o755)
    return { dir, home }
  }
  const run = (dir: string, home: string, t: string) =>
    spawnSync('make', ['--no-print-directory', t], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: home } })

  it('ничего не настроено — отказ с указанием на шаг 6, а не тишина', () => {
    const dir = stackDir(null)
    const r = run(dir, join(dir, 'nohome'), 'deploy-status')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('шаг 6')
  })

  it('пауза — файл state/paused; resume его снимает; status о ней говорит', () => {
    const { dir, home } = cronHome()
    const paused = join(home, 'bank-app-deploy', 'state', 'paused')
    expect(run(dir, home, 'deploy-pause').status).toBe(0)
    expect(existsSync(paused)).toBe(true)
    expect(run(dir, home, 'deploy-status').stdout).toContain('на паузе')
    expect(run(dir, home, 'deploy-resume').status).toBe(0)
    expect(existsSync(paused)).toBe(false)
    expect(run(dir, home, 'deploy-status').stdout).not.toContain('на паузе')
  })

  it('deploy-now зовёт скрипт с путями шага 6, в обход паузы, дожидаясь идущего прогона, и пишет в лог расписания', () => {
    const { dir, home } = cronHome()
    const r = run(dir, home, 'deploy-now')
    expect(r.status).toBe(0)
    const cfg = join(home, 'bank-app-deploy')
    expect(r.stdout).toContain(`RUN ignore=1 wait=900 cfg=${cfg}/deploy.env state=${cfg}/state`)
    expect(readFileSync(join(cfg, 'deploy.log'), 'utf8')).toContain('RUN ignore=1')
  })

  it('упавший прогон — make тоже падает: код выхода скрипта, а не tee', () => {
    const { dir, home } = cronHome()
    writeFileSync(join(home, 'bin', 'bank-app-deploy'), '#!/bin/sh\necho "[deploy] ОШИБКА: откачено"\nexit 3\n')
    const r = run(dir, home, 'deploy-now')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('откачено')
    expect(readFileSync(join(home, 'bank-app-deploy', 'deploy.log'), 'utf8')).toContain('откачено')
  })

  // #766: скрипт сам себя не обновляет, а старый не держит `:latest` на развёрнутой версии.
  it('deploy-install ставит скрипт из копии репозитория и прогоняет его обычным тиком — паузу соблюдает', () => {
    const { dir, home } = cronHome()
    const src = join(dir, 'src', 'deploy', 'bitrixvm')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'git-poll-deploy.sh'), '#!/bin/sh\n# git ls-remote\necho "NEW ignore=$BANK_APP_DEPLOY_IGNORE_PAUSE cfg=$BANK_APP_DEPLOY_CONFIG"\n')
    const r = run(dir, home, 'deploy-install')
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const cfg = join(home, 'bank-app-deploy')
    expect(readFileSync(join(home, 'bin', 'bank-app-deploy'), 'utf8')).toContain('echo "NEW')
    expect(r.stdout).toContain(`NEW ignore= cfg=${cfg}/deploy.env`)
    expect(readFileSync(join(cfg, 'deploy.log'), 'utf8')).toContain('NEW ignore=')
  })

  // Годный новый скрипт — разбирается и несёт опрос git (пустой файл тоже «разбирается»).
  const NEW_SCRIPT = '#!/bin/sh\n# git ls-remote\necho NEW\n'
  const withSrc = (dir: string, body: string) => {
    const src = join(dir, 'src', 'deploy', 'bitrixvm')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'git-poll-deploy.sh'), body)
  }
  const backups = (home: string) => readdirSync(join(home, 'bin')).filter(f => f.startsWith('bank-app-deploy.bak-'))

  it.each([
    ['не разбирается', '#!/bin/sh\n# git ls-remote\nif then\n'],
    ['пустой', ''],
    ['без опроса git (обрезан)', '#!/bin/sh\necho half\n']
  ])('deploy-install: скрипт %s — не ставит, работающий остаётся на месте', (_, body) => {
    const { dir, home } = cronHome()
    withSrc(dir, body)
    const r = run(dir, home, 'deploy-install')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('не годится')
    expect(readFileSync(join(home, 'bin', 'bank-app-deploy'), 'utf8')).toContain('echo "RUN')
    expect(backups(home)).toEqual([])
  })

  it('deploy-install оставляет прежний скрипт копией с отметкой времени и называет её', () => {
    const { dir, home } = cronHome()
    withSrc(dir, NEW_SCRIPT)
    const r = run(dir, home, 'deploy-install')
    expect(r.status).toBe(0)
    expect(backups(home)).toHaveLength(1)
    expect(readFileSync(join(home, 'bin', backups(home)[0]), 'utf8')).toContain('echo "RUN')
    expect(r.stdout).toContain(`прежний скрипт сохранён: ${join(home, 'bin', backups(home)[0])}`)
  })

  it('deploy-install повторно — копию рабочей версии не затирает и новой не заводит', () => {
    const { dir, home } = cronHome()
    withSrc(dir, NEW_SCRIPT)
    expect(run(dir, home, 'deploy-install').status).toBe(0)
    const r = run(dir, home, 'deploy-install')
    expect(r.status).toBe(0)
    expect(backups(home)).toHaveLength(1)
    expect(readFileSync(join(home, 'bin', backups(home)[0]), 'utf8')).toContain('echo "RUN')
    expect(r.stdout).not.toContain('сохранён')
  })

  it('deploy-install впервые — копии нет, и о ней не говорится', () => {
    const { dir, home } = cronHome()
    rmSync(join(home, 'bin', 'bank-app-deploy'))
    withSrc(dir, NEW_SCRIPT)
    const r = run(dir, home, 'deploy-install')
    expect(r.status).toBe(0)
    expect(backups(home)).toEqual([])
    expect(r.stdout).not.toContain('сохранён')
  })

  it('deploy-install: новый скрипт упал — make сообщает отказом, а не «установлен» и успехом', () => {
    const { dir, home } = cronHome()
    const src = join(dir, 'src', 'deploy', 'bitrixvm')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'git-poll-deploy.sh'), '#!/bin/sh\n# git ls-remote\necho broken\nexit 2\n')
    const r = run(dir, home, 'deploy-install')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('broken')
  })

  it('deploy-install без копии репозитория — отказ с указанием на self-update, установленный скрипт цел', () => {
    const { dir, home } = cronHome()
    const r = run(dir, home, 'deploy-install')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('сперва make self-update')
    expect(readFileSync(join(home, 'bin', 'bank-app-deploy'), 'utf8')).toContain('echo "RUN')
  })
})

// #766: на ВМ с автообновлением `prod-pull`/`prod-redeploy` тянули бы `:latest` из реестра — в том
// числе версию, которую автообновление откатило по проверке здоровья. ⚠ Проверяется ВЫЗОВОМ: под
// `make -n` отказ не исполняется, и текстовая проверка подтвердила бы строку, которая не срабатывает.
// ⚠ Стек кладётся в `<база>/bank-import`, а автообновление — рядом, в `<база>/bank-app-deploy`, как
// на ВМ (`/home/bitrix/…`). База своя у каждого теста: соседний каталог общей `/tmp` задел бы
// чужие прогоны.
describe('на ВМ с автообновлением prod-pull/prod-redeploy отказывают, а prod-up идёт под замком', () => {
  type Where = 'none' | 'home' | 'sibling'
  function vm(where: Where, busy = false, ran = true) {
    const base = mkdtempSync(join(tmpdir(), 'mk-vm-'))
    const dir = join(base, 'bank-import')
    mkdirSync(dir)
    writeFileSync(join(dir, 'Makefile'), MAKEFILE)
    const home = join(base, 'home')
    const bin = join(base, 'bin')
    mkdirSync(home)
    mkdirSync(bin)
    const deploy = where === 'home' ? join(home, 'bank-app-deploy') : join(base, 'bank-app-deploy')
    if (where !== 'none') {
      mkdirSync(join(deploy, 'state'), { recursive: true })
      writeFileSync(join(deploy, 'deploy.env'), '')
      // Файл замка создаёт сам скрипт обновления при первом запуске.
      if (ran) writeFileSync(join(deploy, 'state', 'deploy.lock'), '')
    }
    const log = join(base, 'calls.log')
    writeFileSync(join(bin, 'docker'), `#!/bin/sh\necho "docker $*" >> "${log}"\n`)
    // `flock -n замок true` — проверка занятости; `flock -w N замок команда…` — выполнить под замком.
    writeFileSync(join(bin, 'flock'), `#!/bin/sh\necho "flock $*" >> "${log}"\n`
    + `if [ "$1" = -n ]; then ${busy ? 'exit 1' : 'exit 0'}; fi\nshift 3\nexec "$@"\n`)
    chmodSync(join(bin, 'docker'), 0o755)
    chmodSync(join(bin, 'flock'), 0o755)
    const call = (t: string) => spawnSync('make', ['--no-print-directory', t], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }
    })
    const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
    return { call, calls, deploy }
  }

  it.each(['prod-pull', 'prod-redeploy'])('%s: автообновление настроено — отказ до реестра, с верным путём', (t) => {
    const { call, calls } = vm('home')
    const r = call(t)
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('make deploy-now')
    expect(r.stdout).toContain('make prod-up')
    expect(calls()).toEqual([])
  })

  it.each(['prod-pull', 'prod-redeploy'])('%s: запущено не из-под bitrix (другой HOME) — отказ всё равно, по каталогу рядом со стеком', (t) => {
    const { call, calls } = vm('sibling')
    expect(call(t).status).not.toBe(0)
    expect(calls()).toEqual([])
  })

  it.each(['prod-pull', 'prod-redeploy'])('%s: автообновления нет — работает как прежде', (t) => {
    const { call, calls } = vm('none')
    expect(call(t).status).toBe(0)
    expect(calls()[0]).toBe('docker compose -f docker-compose.prod.yml pull')
  })

  it('prod-up без автообновления — прежняя команда, без замка', () => {
    const { call, calls } = vm('none')
    expect(call('prod-up').status).toBe(0)
    expect(calls()).toEqual(['docker compose -f docker-compose.prod.yml up -d'])
  })

  it.each(['home', 'sibling'] as const)('prod-up с автообновлением (%s) — под замком скрипта обновления', (where) => {
    const { call, calls, deploy } = vm(where)
    const r = call('prod-up')
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(calls()).toContain(`flock -w 900 ${deploy}/state/deploy.lock docker compose -f docker-compose.prod.yml up -d`)
    expect(calls()).toContain('docker compose -f docker-compose.prod.yml up -d')
    expect(r.stdout).not.toContain('жду')
  })

  it('каталог есть и в HOME, и рядом со стеком — берётся домашний, как у целей deploy-*', () => {
    const { call, calls, deploy } = vm('home')
    // Рядом со стеком — второй, никогда не запускавшийся (без замка): выбери его — замка бы не было.
    const sibling = join(deploy, '..', '..', 'bank-app-deploy')
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'deploy.env'), '')
    expect(call('prod-up').status).toBe(0)
    expect(calls()).toContain(`flock -w 900 ${deploy}/state/deploy.lock docker compose -f docker-compose.prod.yml up -d`)
  })

  it('prod-up, когда скрипт ещё не запускался (замка нет) — без замка и без его создания', () => {
    const { call, calls, deploy } = vm('sibling', false, false)
    expect(call('prod-up').status).toBe(0)
    expect(calls()).toEqual(['docker compose -f docker-compose.prod.yml up -d'])
    expect(existsSync(join(deploy, 'state', 'deploy.lock'))).toBe(false)
  })

  // Поведение замка проверено на prod-up выше; здесь — что ни одна цель Makefile, поднимающая стек,
  // его не обходит. Исключения названы: шлюз не несёт образов приложения, а prod-redeploy на такой
  // ВМ отказывает раньше. ⚠ Охват — только Makefile: скрипты, которые поднимают стек сами
  // (`prior-switch-host.sh`), сюда не попадают — это отдельная задача (#764).
  it('каждая цель Makefile, поднимающая стек, идёт через замок — кроме названных исключений', () => {
    const ups = MAKEFILE.split('\n').filter(l => l.startsWith('\t') && l.includes('$(DC) up -d'))
    expect(ups.filter(l => !l.includes('$(DEPLOY_LOCKED)')).map(l => l.trim()))
      .toEqual(['$(DC) up -d && \\', '@$(DC) up -d crypto-gw \\'])
    expect(ups.filter(l => l.includes('$(DEPLOY_LOCKED)')).length).toBe(3)
  })

  it('prod-up при идущем прогоне — говорит, что ждёт, и всё равно идёт под замком', () => {
    const { call, calls } = vm('home', true)
    const r = call('prod-up')
    expect(r.stdout).toContain('идёт прогон автообновления — жду его окончания')
    expect(calls().some(l => l.startsWith('flock -w 900 '))).toBe(true)
  })
})

describe('скрипт обновления уважает паузу', () => {
  function pollerEnv(paused: boolean, ignore: boolean) {
    const dir = mkdtempSync(join(tmpdir(), 'poller-'))
    const state = join(dir, 'state')
    mkdirSync(state)
    if (paused) writeFileSync(join(state, 'paused'), '')
    // Заведомо недоступный git: если скрипт дошёл до опроса — он упадёт, и это видно по коду выхода.
    writeFileSync(join(dir, 'deploy.env'), [
      `GIT_URL=${join(dir, 'no-such-repo')}`, `STACK_DIR=${dir}`, 'IMAGE_APP=x', 'IMAGE_BACKEND=y', ''
    ].join('\n'))
    return spawnSync('bash', [POLLER], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BANK_APP_DEPLOY_CONFIG: join(dir, 'deploy.env'),
        BANK_APP_DEPLOY_STATE: state,
        BANK_APP_DEPLOY_IGNORE_PAUSE: ignore ? '1' : '0'
      }
    })
  }

  it('на паузе — выходит успешно, до опроса git', () => {
    const r = pollerEnv(true, false)
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('на паузе')
    expect(r.stdout).not.toContain('опрашиваю')
  })

  it('ручной запуск паузу обходит — идёт дальше, к опросу', () => {
    const r = pollerEnv(true, true)
    expect(r.stdout).toContain('опрашиваю')
    expect(r.status).not.toBe(0)
  })

  it('без паузы — идёт к опросу', () => {
    expect(pollerEnv(false, false).stdout).toContain('опрашиваю')
  })
})

// Сервер КЛИЕНТА работает только со своим репозиторием (docs/DEPLOY_BITRIXVM.md, шаг 1b): его
// копия лежит рядом со стеком в `./src`, и служебные файлы берутся из неё, а не из нашего
// репозитория. ⚠ Проверяется напечатанной командой настоящего make: источник выбирается при
// разборе файла, и текстовый гард подтвердил бы строку, которая не срабатывает.
describe('источник служебных файлов — копия клиентского репозитория, если она есть', () => {
  const curlOf = (dir: string, target: string, args: string[] = []) =>
    execFileSync('make', ['--no-print-directory', '-n', target, ...args], { cwd: dir, encoding: 'utf8' })
      .split('\n').find(l => l.includes('curl -fsSL')) ?? ''

  it('копии нет — наш репозиторий (наш сервер, как было)', () => {
    expect(curlOf(stackDir(null), 'poll-check')).toContain('https://raw.githubusercontent.com/bx-shef/client-bank-alfa-by/main/scripts/prod-poll-check.sh')
  })

  it('копия есть — только она, наш репозиторий не упоминается вовсе', () => {
    const dir = stackDir(null)
    mkdirSync(join(dir, 'src', '.git'), { recursive: true })
    for (const t of ['poll-check', 'self-update', 'compose-update']) {
      const line = curlOf(dir, t)
      expect(line, t).toContain(`file://${dir}/src/`)
      expect(line, t).not.toContain('bx-shef')
    }
  })

  it('self-update и compose-update сперва обновляют копию', () => {
    const dir = stackDir(null)
    mkdirSync(join(dir, 'src', '.git'), { recursive: true })
    for (const t of ['self-update', 'compose-update']) {
      const out = execFileSync('make', ['--no-print-directory', '-n', t], { cwd: dir, encoding: 'utf8' })
      expect(out, t).toContain('git -C ./src pull -q --ff-only')
    }
  })

  it('источник НЕ задаётся из командной строки', () => {
    const dir = stackDir(null)
    const line = curlOf(dir, 'poll-check', ['SRC=https://evil.example', 'RAW=https://evil.example'])
    expect(line).not.toContain('evil')
  })

  // `deploy-install` ставит скрипт, который cron запускает каждые пять минут, из `./$(SRC_DIR)`:
  // заданный из командной строки каталог подменил бы его, а `$(shell …)` исполнился бы даже под `-n`.
  it('каталог копии (SRC_DIR) тоже НЕ задаётся из командной строки', () => {
    const dir = stackDir(null)
    const out = spawnSync('make', ['--no-print-directory', '-n', 'deploy-install', 'SRC_DIR=../evil'], { cwd: dir, encoding: 'utf8' })
    expect(out.stdout).toContain('./src/deploy/bitrixvm/git-poll-deploy.sh')
    expect(out.stdout).not.toContain('evil')
    const shell = spawnSync('make', ['--no-print-directory', '-n', 'deploy-install', 'SRC_DIR=$(shell echo PWNED >&2; echo src)'], { cwd: dir, encoding: 'utf8' })
    expect(shell.stderr).not.toContain('PWNED')
  })
})

// ⚠ Путь автообновления ОДИН (решение владельца 2026-09-27): systemd-вариант снят, потому что два
// пути давали инструкцию с «или» на каждом шаге и путаницу, какой каталог настоящий. Вернуть его
// «для полноты» — первое, что придёт в голову; гард делает это видимым решением.
describe('автообновление — один путь, без systemd', () => {
  it('ни Makefile, ни скрипт, ни примеры настроек не ссылаются на systemd и /etc/bank-app-deploy', () => {
    const files = ['Makefile', 'deploy/bitrixvm/git-poll-deploy.sh', 'deploy/bitrixvm/deploy.env.client.example',
      'deploy/bitrixvm/deploy.env.upstream.example', 'scripts/bitrixvm-check.sh', 'docs/DEPLOY_BITRIXVM.md']
    for (const f of files) {
      const text = readFileSync(join(ROOT, f), 'utf8')
      expect(text, f).not.toMatch(/\/etc\/bank-app-deploy|\/var\/lib\/bank-app-deploy|bank-app-deploy\.(timer|service)|journalctl/)
    }
    expect(existsSync(join(ROOT, 'deploy/bitrixvm/systemd'))).toBe(false)
  })
})
