import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { bankRefreshLockKey, isLockTimeout, PG_LOCK_TIMEOUT } from '../server/utils/bankRefreshLock'

// Лок, сериализующий двух писателей в одну строку `bank_tokens` (#509).
//
// Стороны две и они НЕ похожи друг на друга: обновление токена меняет секреты, а выбор счёта
// меняет `account_key` — то самое поле, по которому первая сторона находит свою строку. Общий у
// них только ключ лока, и именно он — единственное, что мешает им разъехаться. Поэтому здесь
// проверяется не столько сама функция (она в одну строку), сколько то, что её НИКТО НЕ ОБХОДИТ.

describe('bankRefreshLockKey', () => {
  it('различает портал, банк и счёт', () => {
    // Пер-портальный лок сериализовал бы независимые счета и растянул часовой скан на сумму
    // сетевых задержек; пер-банковский склеил бы два счёта одного банка.
    const base = bankRefreshLockKey('m1', 'alfa-by', 'BY01')
    expect(base).not.toBe(bankRefreshLockKey('m2', 'alfa-by', 'BY01'))
    expect(base).not.toBe(bankRefreshLockKey('m1', 'prior-by', 'BY01'))
    expect(base).not.toBe(bankRefreshLockKey('m1', 'alfa-by', 'BY02'))
  })

  it('устойчив: одинаковый вход — одинаковый ключ', () => {
    expect(bankRefreshLockKey('m1', 'alfa-by', '~pending:n1')).toBe(bankRefreshLockKey('m1', 'alfa-by', '~pending:n1'))
  })
})

describe('isLockTimeout', () => {
  it('узнаёт именно ожидание лока, а не любую ошибку БД', () => {
    // Спутать значит превратить настоящий сбой БД в бодрое «повторите через несколько секунд» —
    // человек будет жать кнопку, пока не надоест, а причина всё это время в другом месте.
    expect(isLockTimeout({ code: PG_LOCK_TIMEOUT })).toBe(true)
    expect(isLockTimeout({ code: '57014' })).toBe(false) // statement_timeout
    expect(isLockTimeout({ code: '23505' })).toBe(false) // unique_violation
    expect(isLockTimeout(new Error('connection lost'))).toBe(false)
    expect(isLockTimeout(null)).toBe(false)
    expect(isLockTimeout(undefined)).toBe(false)
  })
})

describe('ключ лока строится ТОЛЬКО хелпером', () => {
  it('ни один модуль не собирает строку `bankrefresh:` сам', () => {
    // ⚠ Ровно тот дефект, о котором предупреждает issue: разойдись стороны в написании ключа хоть
    // на символ — лок формально взят, а стороны не пересеклись. Ошибка невидима полностью: тесты
    // зелёные, ошибок нет, подключение умирает через сутки. Поэтому нарушение ловится структурно,
    // а не чтением ревью.
    const ROOT = join(import.meta.dirname, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const rel = join(dir, entry.name)
        if (entry.isDirectory()) walk(rel)
        else if (entry.name.endsWith('.ts')) {
          // Литерал ключа легален только в самом хелпере — там он и определён.
          if (rel === join('server', 'utils', 'bankRefreshLock.ts')) continue
          const text = readFileSync(join(ROOT, rel), 'utf8')
          for (const line of text.split('\n')) {
            // Интересует ПОДСТАНОВКА в строку (`bankrefresh:${…}`), а не упоминание в комментарии:
            // и хелпер, и оба вызывающих объясняют правило словами, и наивный поиск по подстроке
            // объявил бы нарушителем объяснение.
            if (/`bankrefresh:\$\{/.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 70)}`)
          }
        }
      }
    }
    walk('server')
    walk('app')
    expect(offenders).toEqual([])
  })

  it('обе стороны действительно берут лок этим ключом', () => {
    // Обратная проверка к предыдущей: без неё «нарушителей нет» достигалось бы и тем, что лок
    // перестали брать вовсе. Сторон ровно две — обновление секретов и смена ключа.
    const ROOT = join(import.meta.dirname, '..')
    for (const file of ['server/utils/ensureBankToken.ts', 'server/utils/bankAccountRename.ts']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toContain('bankRefreshLockKey')
    }
  })

  it('роут выбора счёта не ходит в хранилище мимо лока', () => {
    // Проводка — единственное место, где лок можно потерять целиком, не тронув ни одной из сторон:
    // достаточно вернуть в роут прямой вызов `renameBankTokenAccount(dbQuery, …)`, и всё снова
    // «работает», молча и до первой ротации refresh.
    const ROOT = join(import.meta.dirname, '..')
    const route = readFileSync(join(ROOT, 'server/api/bank/set-account.post.ts'), 'utf8')
    expect(route).toContain('makeLockedRename')
    expect(route).not.toMatch(/renameBankTokenAccount\s*\(\s*dbQuery/)
  })
})
