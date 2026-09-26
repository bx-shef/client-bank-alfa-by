import { describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Операторские цели на ВМ Битрикс24 (docs/DEPLOY_BITRIXVM.md).
//
// ⚠ Две поломки, обе молчаливые. Первая: все прод-цели передавали `-f docker-compose.prod.yml`, а
// явный `-f` отбрасывает `COMPOSE_FILE` из `.env`. На ВМ там перечислен оверлей (порт на
// 127.0.0.1, образы КЛИЕНТА), и `make prod-redeploy` поднял бы приложение без порта на loopback и
// backend из нашего образа. Вторая: `deploy-*` знали только systemd, и в варианте с cron под
// `bitrix` оператору оставались сырые команды.
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

// ⚠ Ветка systemd проверяется только отсутствием таймера на машине прогона — её признак это файл в
// /etc, подменять его ради теста значило бы открыть параметр, которого оператору давать нельзя.
describe.skipIf(existsSync('/etc/systemd/system/bank-app-deploy.timer'))('deploy-*: вариант с cron под bitrix', () => {
  function cronHome(): { dir: string, home: string } {
    const dir = stackDir(null)
    const home = join(dir, 'home')
    mkdirSync(join(home, 'bank-app-deploy'), { recursive: true })
    mkdirSync(join(home, 'bin'))
    writeFileSync(join(home, 'bank-app-deploy', 'deploy.env'), '')
    const fake = join(home, 'bin', 'bank-app-deploy')
    writeFileSync(fake, '#!/bin/sh\necho "RUN ignore=$BANK_APP_DEPLOY_IGNORE_PAUSE cfg=$BANK_APP_DEPLOY_CONFIG state=$BANK_APP_DEPLOY_STATE"\n')
    chmodSync(fake, 0o755)
    return { dir, home }
  }
  const run = (dir: string, home: string, t: string) =>
    spawnSync('make', ['--no-print-directory', t], { cwd: dir, encoding: 'utf8', env: { ...process.env, HOME: home } })

  it('ничего не настроено — отказ с указанием на шаги 6/6b, а не тишина', () => {
    const dir = stackDir(null)
    const r = run(dir, join(dir, 'nohome'), 'deploy-status')
    expect(r.status).not.toBe(0)
    expect(r.stdout).toContain('шаги 6/6b')
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

  it('deploy-now зовёт скрипт с путями шага 6b, в обход паузы, и пишет в лог расписания', () => {
    const { dir, home } = cronHome()
    const r = run(dir, home, 'deploy-now')
    expect(r.status).toBe(0)
    const cfg = join(home, 'bank-app-deploy')
    expect(r.stdout).toContain(`RUN ignore=1 cfg=${cfg}/deploy.env state=${cfg}/state`)
    expect(readFileSync(join(cfg, 'deploy.log'), 'utf8')).toContain('RUN ignore=1')
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
})
