import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Архитектурный гард той же формы, что `paymentListParamsChokePoint` (#542).
//
// Кодировку файла выписки ОПРЕДЕЛЯЕТ одна точка — `decodeUploadText` (#700): у нас три формата с
// тремя кодировками (windows-1251 у 1С и client-bank, CP866 у звёздочного Паритетбанка, UTF-8), и
// вторая копия правила расходится МОЛЧА.
//
// ⚠ Дефект был не гипотетическим: `scripts/parse-statement.ts` декодировал жёстко windows-1251 ещё
// долго после #700. Отказ молчаливый и вывернутый в худшую сторону — файл CP866 разбирается
// СТРУКТУРНО ВЕРНО (звёздочки, цифры, счета и суммы это ASCII), мусором выходит только кириллица.
// То есть инструмент диагностики показывал «Ћ Ї« в  Ї® бзсвг» там, где приложение показывает
// «Оплата по счёту», и врал ПРОТИВ нас: человек, проверяющий новый файл, читал это как поломку
// парсера. Замерено на `public/samples/vypiska-paritet.txt` до и после правки.
//
// ⚠ Гард смотрит на ФОРМУ, а не на поведение: «файл не строит свой декодер и зовёт общую точку».
// Что сама точка выбирает кодировку верно, проверяет `tests/statementEncoding.test.ts` — без него
// эта половина не проверена ничем.
//
// ⚠ ГЕНЕРАТОР ФИКСТУР ИСКЛЮЧЁН НАМЕРЕННО (`scripts/make-test-statement.mjs`): он не читает, а
// ПИШЕТ файл в конкретной кодировке банка, то есть жёсткое `windows-1251` там и есть его задача.
// Смешать их значило бы запретить генерировать выписку в той кодировке, в которой её отдаёт банк.

const ROOT = join(import.meta.dirname, '..')

/** Читатели файла выписки: каждый обязан идти через общую точку. */
const READERS = [
  'scripts/parse-statement.ts',
  'server/utils/importIngest.ts',
  'app/utils/importUpload.ts'
]

/** Свой декодер — то, чем подменяют общую точку. `statementEncoding.ts` его и содержит по смыслу. */
const OWN_DECODER = /new TextDecoder\(\s*['"](windows-1251|cp866|ibm866)['"]/i

describe('кодировку выписки выбирает ОДНА точка (#700)', () => {
  for (const file of READERS) {
    it(`${file} не строит свой декодер`, () => {
      const src = readFileSync(join(ROOT, file), 'utf8')
      expect(src).not.toMatch(OWN_DECODER)
    })
  }

  it('scripts/parse-statement.ts зовёт decodeUploadText, а не декодирует сам', () => {
    const src = readFileSync(join(ROOT, 'scripts/parse-statement.ts'), 'utf8')
    expect(src).toContain('decodeUploadText(')
  })

  it('общая точка живёт в importUpload.ts и опирается на detectStatementEncoding', () => {
    const src = readFileSync(join(ROOT, 'app/utils/importUpload.ts'), 'utf8')
    expect(src).toMatch(/export function decodeUploadText/)
    expect(src).toContain('detectStatementEncoding(')
  })
})
