// Ключ кросс-прогонной памяти «про эту операцию уже сказали» (#696).
//
// ⚠ Смысл теста — не «функция что-то возвращает», а ДВА инварианта, каждый из которых легко
// сломать незаметно: ключ операции не должен попадать в Redis открытым текстом (в нём номер нашего
// расчётного счёта), и два разных портала не должны делить одну отметку.

import { describe, expect, it } from 'vitest'
import { UNMATCHED_NOTICE_TTL_SEC, unmatchedNoticeKey } from '../server/utils/unmatchedNoticeClaim'

describe('unmatchedNoticeKey', () => {
  const KEY = 'BY09ALFA30132120160130270000|133513697'

  it('НЕ содержит ключ дедупа открытым текстом — ни целиком, ни номером счёта', () => {
    const k = unmatchedNoticeKey('M1', KEY)
    expect(k).not.toContain(KEY)
    expect(k).not.toContain('BY09ALFA30132120160130270000')
    expect(k).not.toContain('133513697')
  })

  it('один и тот же портал и операция дают один и тот же ключ', () => {
    expect(unmatchedNoticeKey('M1', KEY)).toBe(unmatchedNoticeKey('M1', KEY))
  })

  it('разные операции одного портала — разные ключи', () => {
    expect(unmatchedNoticeKey('M1', KEY)).not.toBe(unmatchedNoticeKey('M1', `${KEY}9`))
  })

  it('один и тот же платёж у РАЗНЫХ порталов — разные ключи (отметку они не делят)', () => {
    expect(unmatchedNoticeKey('M1', KEY)).not.toBe(unmatchedNoticeKey('M2', KEY))
  })

  it('пространство имён отделено от соседних ключей Redis', () => {
    expect(unmatchedNoticeKey('M1', KEY).startsWith('unmatched-notice:M1:')).toBe(true)
  })

  it('срок покрывает окно опроса — и не превращается в кучу мусора', () => {
    // ⚠ Границы с ОБЕИХ сторон, и обе содержательные. Снизу: окно перекрывает максимум выходные
    // плюс рабочий день — трое суток, и короче этого отметка теряла бы смысл на каждой операции.
    // Сверху: значений вроде 10 или 30 суток не бывает, они означают лишь месяц мусора в Redis
    // (решение владельца, 2026-09-15). Запаса над окном НЕТ намеренно — цена ровно одно повторное
    // сообщение на границе, и она названа в модуле.
    const day = 24 * 60 * 60
    expect(UNMATCHED_NOTICE_TTL_SEC).toBeGreaterThanOrEqual(3 * day)
    expect(UNMATCHED_NOTICE_TTL_SEC).toBeLessThanOrEqual(7 * day)
  })
})
