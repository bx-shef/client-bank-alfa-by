import { afterAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// #669: лестница пауз и проба обязаны РАЗЛИЧАТЬ «банк отказал» и «обмена не было вовсе».
//
// ⚠ Ради чего тест. 2026-09-07 лестница решала вердикт грепом слова «ОБНОВЛЕНИЕ ПРОШЛО» в выводе
// пробы. Подключения Альфы в базе не было, проба честно написала «строк нет» — и лестница
// объявила «ступень 1 (1m): ОТКАЗ. Банк НЕ терпит 1m», то есть выдала уверенный вердикт о банке,
// которого не спрашивали. Ответ опыта («какой простой банк терпит») получился выдуманным.
//
// ⚠ Проверяем ИСПОЛНЕНИЕМ, а не наличием слов: греп по скрипту не отличает работающую ветку от
// выпотрошенной (тот же довод, что в prodAlfaPageProbe.test.ts).

const LADDER = resolve(import.meta.dirname, '../scripts/oauth-refresh-ladder.sh')
const PROBE = resolve(import.meta.dirname, '../scripts/oauth-refresh-probe.sh')

/** Вызвать функцию скрипта, вырезав её `sed`-диапазоном. Отдаёт вывод и код возврата. */
function callFn(script: string, fn: string, ...args: string[]): { out: string, code: number } {
  const res = execFileSync('bash', ['-c',
    `source <(sed -n '/^${fn}()/,/^}/p' "$1"); ${fn} "\${@:2}"; echo "RC=$?"`, '_', script, ...args
  ], { encoding: 'utf8' })
  const m = res.match(/RC=(\d+)\s*$/)
  return { out: res.replace(/RC=\d+\s*$/, ''), code: Number(m?.[1]) }
}

const report = (rc: string) => callFn(LADDER, 'report_step', rc, '3', '1h')
const verdict = (out: string) => callFn(PROBE, 'verdict_code', out).code

describe('#669 проба: код возврата по машинной метке', () => {
  it('метка ok — успех', () => {
    expect(verdict('ЧТО ОТВЕТИЛИ\nHTTP 200\nVERDICT|ok\nРЕЗУЛЬТАТ: ✅ ОБНОВЛЕНИЕ ПРОШЛО.')).toBe(0)
  })

  it('метка bank-refused — отказ банка', () => {
    expect(verdict('HTTP 400\nVERDICT|bank-refused\nРЕЗУЛЬТАТ: банк ОТВЕТИЛ отказом.')).toBe(1)
  })

  it('метка not-attempted — обмена не было', () => {
    expect(verdict('VERDICT|not-attempted\nподключения нет в базе')).toBe(2)
  })

  it('МЕТКИ НЕТ ВОВСЕ — тоже «не состоялось», а не отказ банка', () => {
    // ⚠ Так падает стенд: `docker compose` пишет свою ошибку и отдаёт 1. Прочитай мы код возврата
    // самого compose, авария стенда была бы неотличима от отказа банка — ровно та подмена,
    // из-за которой тест и написан.
    expect(verdict('service "backend" is not running')).toBe(2)
    expect(verdict('')).toBe(2)
  })

  it('«ОБНОВЛЕНИЕ ПРОШЛО» в прозе БЕЗ метки успехом не считается', () => {
    // Прежний греп сказал бы «успех» на любом упоминании фразы — например в тексте ошибки.
    expect(verdict('РЕЗУЛЬТАТ: ОБНОВЛЕНИЕ ПРОШЛО.')).toBe(2)
  })
})

describe('#669 лестница: вердикт ступени', () => {
  it('0 — успех, лестница идёт дальше', () => {
    const r = report('0')
    expect(r.code).toBe(0)
    expect(r.out).toContain('УСПЕХ')
  })

  it('1 — отказ банка: это ответ опыта, лестница встаёт', () => {
    const r = report('1')
    expect(r.code).toBe(1)
    expect(r.out).toContain('ОТКАЗ БАНКА')
    expect(r.out).toContain('НЕ терпит 1h')
  })

  it.each(['2', '7', ''])('код %s — «замер не состоялся», и о банке НИ СЛОВА', (rc) => {
    // ⚠ Неизвестный код приравнен к «не состоялось» намеренно: единственный исход, который вправе
    // говорить о банке, — тот, где HTTP-статус банка реально прочитан.
    const r = report(rc)
    expect(r.code).toBe(1)
    expect(r.out).toContain('ЗАМЕР НЕ СОСТОЯЛСЯ')
    expect(r.out).not.toContain('ОТКАЗ БАНКА')
    expect(r.out).not.toContain('НЕ терпит')
  })
})

describe('#669 регрессия: вердикт не выводится из прозы', () => {
  it('лестница не грепает вывод пробы на слова', () => {
    // Единственная структурная проверка: ровно этот приём и сломался. Остальное — исполнением.
    const src = readFileSync(LADDER, 'utf8')
    expect(src).not.toMatch(/grep[^\n]*ОБНОВЛЕНИЕ ПРОШЛО/)
    expect(src).toMatch(/report_step "\$rc"/)
  })

  it('проба прячет машинные метки от человека', () => {
    // Метка — канал для лестницы; в терминале оператора она только сбивала бы.
    expect(readFileSync(PROBE, 'utf8')).toMatch(/grep -vE '\^\(SAVE\|VERDICT\)\\\|'/)
  })
})

describe('#669 сторож: две лестницы на один грант', () => {
  // ⚠ Проверяем НАСТОЯЩИМ прогоном, а не подделкой процесса. 2026-09-07 сторож на pid-файле
  // пропустил второй запуск Альфы поверх идущего — а две лестницы на одном гранте дают выдуманную
  // границу: пока одна спит 30 минут, вторая обновляет токен на третьей, и «пауза 30m» на деле
  // оказывается 27-минутной. Замер молча отвечает не про ту паузу, про которую отчитывается.
  //
  // ⚠ Подделка процесса тут не годится, и это измерено: `bash -c 'МЕТКА=x; sleep 30'` НЕ содержит
  // метки в командной строке — bash подменяет собой последнюю команду (implicit exec), и метка
  // исчезает. У настоящей лестницы последняя команда — функция, подменить её нечем, поэтому метка
  // и держится. Тест на подделке был бы зелёным ни о чём.

  const dir = mkdtempSync(join(tmpdir(), 'ladder-'))
  const stub = join(dir, 'oauth-refresh-probe.sh')
  writeFileSync(stub, '#!/usr/bin/env bash\necho "заглушка пробы"\nexit 0\n')

  const run = (p: string, ...args: string[]) => execFileSync('bash', [LADDER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, P: p, BASE: dir, RAW_URL: `file://${dir}`, GAPS: '30' }
  })
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

  afterAll(() => {
    for (const p of ['dupA', 'dupB', 'dupC']) {
      try {
        run(p, '--stop')
      } catch { /* не запускалась */ }
    }
    rmSync(dir, { recursive: true, force: true })
  })

  it('второй запуск поверх идущего ОТКЛОНЯЕТСЯ', async () => {
    expect(run('dupA')).toContain('запущена')
    await wait(500)
    const second = run('dupA')
    expect(second).toContain('УЖЕ идёт')
    expect(second).toContain('ИСПОРТИЛ БЫ ЗАМЕР')
  })

  it('останавливается даже без pid-файла', async () => {
    expect(run('dupB')).toContain('запущена')
    await wait(500)
    rmSync(join(dir, 'refresh-ladder-dupB.pid'), { force: true }) // как после чужого --stop
    expect(run('dupB', '--stop')).toContain('остановлена')
    await wait(500)
    expect(run('dupB', '--stop')).toContain('не нашёл')
  })

  it('останов чужого поставщика идущую лестницу не трогает', async () => {
    expect(run('dupC')).toContain('запущена')
    await wait(500)
    expect(run('dupZ', '--stop')).toContain('не нашёл') // dupZ не запускали вовсе
    expect(run('dupC')).toContain('УЖЕ идёт') // dupC пережила чужой останов
  })
})
