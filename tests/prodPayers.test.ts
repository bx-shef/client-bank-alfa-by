import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import type { StatementItem } from '../app/types/statement'
import { buildOpLogLine } from '../server/utils/opLogLine'

// Гард отчёта «кого не опознали» (#501).
//
// ⚠ Скрипт разбирает строку, которую печатает НЕ он. Формат живёт в `buildOpLogLine`, и разойдись
// они — отчёт продолжит «работать», показывая пустой список. А пустой список здесь означает
// «все платежи приземлились к клиентам», то есть ровно противоположное правде. Это худший вид
// отказа диагностики: молчание, похожее на успех, в задаче, которая открыта из-за того, что
// НИ ОДИН платёж к клиенту не приземлился.
//
// Поэтому вход теста — не выдуманная строка, а вывод настоящего билдера.

const ROOT = join(import.meta.dirname, '..')
const SCRIPT_PATH = join(ROOT, 'scripts', 'prod-payers.sh')
const SCRIPT = readFileSync(SCRIPT_PATH, 'utf8')

function item(counterpartyAccount: string): StatementItem {
  return {
    account: 'BY09ALFA111',
    docId: 'D1',
    acceptDate: '2026-08-25',
    direction: 'credit',
    amount: 10,
    currency: 'BYN',
    purpose: 'оплата',
    counterparty: { name: 'X', account: counterpartyAccount, unp: '', bank: '' }
  }
}

/**
 * Строка лога, собранная ТЕМ ЖЕ кодом, что печатает её на проде.
 *
 * ⚠ `revealPii` по умолчанию ВКЛЮЧЁН: без него номера счетов в строку не попадают вовсе (#617), и
 * отчёту нечего разбирать. Выключенный флаг — отдельный проверяемый случай, а не фон для всех.
 */
function opLine(
  counterpartyAccount: string, owner: 'client' | 'my-company' | 'none', revealPii = true
): string {
  const line = buildOpLogLine(
    item(counterpartyAccount),
    { owner, recognized: 0, activityId: owner === 'none' ? null : '1' },
    'M1',
    'all',
    revealPii
  )
  expect(line, 'билдер обязан вернуть строку в режиме all').not.toBeNull()
  return `[op] INFO: ${line}`
}

/** Прогнать конвейер извлечения РОВНО так, как он записан в скрипте. */
function extract(lines: string[]): string[] {
  // ⚠ Берём команду ИЗ ФАЙЛА, а не копируем сюда: копия — это второй источник истины, и он
  // разойдётся со скриптом молча, оставив тест зелёным при сломанном отчёте.
  const pipeline = /\| grep -E 'NO OWNER[\s\S]*?\| sort \| uniq -c \| sort -rn/.exec(SCRIPT)?.[0]
  expect(pipeline, 'конвейер извлечения не найден в скрипте — его переписали').toBeTruthy()
  const cmd = `printf '%s\\n' "$LINES" ${pipeline!.replace(/\\\n\s*/g, ' ')}`
  const out = execFileSync('bash', ['-c', cmd], {
    env: { ...process.env, LINES: lines.join('\n') },
    encoding: 'utf8'
  })
  return out.split('\n').map(s => s.trim()).filter(Boolean)
}

describe('отчёт «кого не опознали» разбирает НАСТОЯЩУЮ строку лога (#501)', () => {
  it('счёт плательщика вырезается из фолбэка и из «нет владельца»', () => {
    const got = extract([
      opLine('BY11PAYER0001', 'none'),
      opLine('BY11PAYER0001', 'my-company'),
      opLine('BY22OTHER0002', 'my-company')
    ])
    expect(got).toEqual(['2 BY11PAYER0001', '1 BY22OTHER0002'])
  })

  it('приземлившийся к КЛИЕНТУ платёж в отчёт не попадает', () => {
    // Иначе отчёт предлагал бы чинить то, что уже работает.
    expect(extract([opLine('BY33CLIENT003', 'client')])).toEqual([])
  })

  it('НАШ счёт под шаблон не попадает — иначе владелец впишет его контрагенту', () => {
    // В строке есть и наш счёт (в `op <наш>|<докид>`), и валюта, и направление. Шаблон обязан
    // брать ровно то, что стоит между стрелками.
    const got = extract([opLine('BY11PAYER0001', 'none')])
    expect(got).toEqual(['1 BY11PAYER0001'])
    expect(got.join(' ')).not.toContain('BY09ALFA111')
    expect(got.join(' ')).not.toContain('BYN')
  })

  it('операция без счёта плательщика отчёт не засоряет', () => {
    // Приложение печатает там «счёт не указан» — три слова с пробелами. Вписать в реквизит нечего.
    const got = extract([opLine('', 'none')])
    expect(got).toEqual([])
  })

  it('без опт-ина отчёт ГОВОРИТ об этом, а не печатает пустой список', () => {
    // ⚠ Самый опасный отказ этой диагностики, и он уже случался: #617 убрал номера счетов из `[op]`
    // под опт-ин, и отчёт стал молча возвращать пусто — то есть «чинить нечего» ровно тогда, когда
    // он не видит данных. Замерено, не выведено: этот тест падал на настоящем билдере.
    const lines = [opLine('BY11PAYER0001', 'none', false), opLine('BY22OTHER0002', 'my-company', false)]
    // Стрелка `←` печатается ТОЛЬКО под опт-ином — по ней скрипт и различает два случая.
    expect(lines.join('\n')).not.toContain('←')
    expect(extract(lines)).toEqual([])
    expect(SCRIPT).toContain('grep -q \'←\'')
    expect(SCRIPT).toMatch(/STATEMENT_DEBUG_LOG выключен/)
    expect(SCRIPT).toMatch(/НЕ значит «все плательщики опознаны»/)
  })

  it('отчёт напоминает вернуть опт-ин обратно', () => {
    // Номер счёта — персональные данные, а docker режет лог по ОБЪЁМУ, а не по сроку: включённый
    // и забытый флаг оставляет IBAN в логе на годы.
    // ⚠ Напоминаний в скрипте ДВА — в ветке «флаг выключен» и в итоговой подсказке, — и
    // проверяются они по отдельности. Первая редакция теста склеила их альтернативой в регулярке,
    // и удаление одного проходило зелёным (замерено мутацией): альтернатива проверяет «есть хоть
    // где-то», а нужно «есть в обоих местах» — человек читает ровно одно из них.
    expect(SCRIPT, 'подсказка после включения флага').toContain('ВЕРНИТЕ обратно')
    expect(SCRIPT, 'подсказка в конце разбора').toContain('Верните STATEMENT_DEBUG_LOG обратно')
  })

  it('скрипт не ходит ни в портал, ни в банк — только чтение лога', () => {
    // Границы #501: прогон ничего не меняет в чужой CRM. Реквизит вписывает человек.
    expect(SCRIPT).not.toMatch(/crm\.|curl|wget|psql/)
    expect(SCRIPT).toContain('docker compose')
  })

  it('подсказка предупреждает про пробелы — на них молча ломается поиск', () => {
    // Сравнение посимвольное (#494, состояние `looks-same`): реквизит с пробелами не найдётся
    // НИКОГДА и без единой ошибки. Это единственный способ выполнить инструкцию и не получить
    // результата, поэтому предупреждение обязано быть в выводе, а не только в комментарии.
    expect(SCRIPT).toMatch(/без пробелов/)
  })
})
