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
  it('каждый ПИСАТЕЛЬ в bank_tokens классифицирован явно', () => {
    // ⚠ Проверки ниже ловят НЕВЕРНО НАПИСАННЫЙ ключ, но не ловят ОТСУТСТВИЕ лока: писатель, который
    // просто не зовёт хелпер, для них невидим — он ничего не пишет неправильно, он молчит. А
    // писателей у строки больше двух, и третий уже существует: `saveBankToken` (OAuth-колбэк)
    // делает `INSERT … ON CONFLICT DO UPDATE` по тем же колонкам, что и обновление токена.
    //
    // Сегодня он безопасен: подключение всегда заводит НОВУЮ `~pending:`-строку (UI не передаёт
    // `accountKey`), поэтому конкурировать за живой ключ ему не с кем. Но серверный контракт
    // `accountKey` принимает, и первая же кнопка «переподключить именно этот счёт» сделает его
    // настоящим третьим писателем — с той же тихой потерей ротированного refresh.
    //
    // Поэтому список писателей ЗАКРЫТ: новый (или изменивший поведение) писатель роняет тест и
    // требует решения — берёт лок или объясняет, почему не должен. Это единственное место, где
    // такое решение вообще кто-то примет осознанно.
    const ROOT = join(import.meta.dirname, '..')
    const store = readFileSync(join(ROOT, 'server/utils/bankTokenStore.ts'), 'utf8')
    const writers = new Set<string>()
    for (const m of store.matchAll(/^export (?:async )?function (\w+)/gm)) {
      const start = m.index!
      const next = store.indexOf('\nexport ', start + 1)
      const body = store.slice(start, next < 0 ? undefined : next)
      if (/(?:INSERT INTO|UPDATE|DELETE FROM)\s+bank_tokens/.test(body)) writers.add(m[1]!)
    }

    // Каждому — своя причина. Менять список молча нельзя: это и есть решение.
    const CLASSIFIED: Record<string, string> = {
      // Под локом (`ensureBankToken`) — сериализован с переименованием.
      updateBankTokenSecrets: 'locked',
      // Под тем же локом (`makeLockedRename`) — меняет ключ, по которому ищет предыдущий.
      renameBankTokenAccount: 'locked',
      // ⚠ БЕЗ лока и пока безопасно: заводит новую `~pending:`-строку, за живой ключ не борется.
      // Появится «переподключить этот счёт» — обязан взять лок.
      saveBankToken: 'unlocked-creates-new-row',
      // Удаление под локом не нуждается: строки не станет в любом порядке, и обновление это
      // увидит (UPDATE-only вернёт `false`) — ровно исход #505, он правильный.
      deleteBankToken: 'unlocked-delete-is-terminal',
      deleteBankTokensForPortal: 'unlocked-delete-is-terminal'
    }
    expect([...writers].sort()).toEqual(Object.keys(CLASSIFIED).sort())
  })

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
            // Интересует ПОСТРОЕНИЕ ключа, а не упоминание в комментарии: и хелпер, и оба
            // вызывающих объясняют правило словами, и наивный поиск по подстроке объявил бы
            // нарушителем объяснение.
            //
            // ⚠ Форм построения ДВЕ. Шаблонная строка — идиома репозитория, но конкатенация даёт
            // ТО ЖЕ значение, и функциональные тесты разницы не увидят по построению: ключ-то
            // совпал. То есть обход через `'bankrefresh:' + a` не ловился бы вообще ничем —
            // проверено мутацией (ревью тестировщика). Ловим обе.
            if (/`bankrefresh:\$\{/.test(line) || /['"]bankrefresh:['"]\s*\+/.test(line)) {
              offenders.push(`${rel}: ${line.trim().slice(0, 70)}`)
            }
          }
        }
      }
    }
    walk('server')
    walk('app')
    expect(offenders).toEqual([])
  })

  it('обе стороны ссылаются на хелпер ключа', () => {
    // Обратная проверка к предыдущей: без неё «нарушителей нет» достигалось бы и тем, что лок
    // перестали брать вовсе. Сторон ровно две — обновление секретов и смена ключа.
    //
    // ⚠ Это проверка ПРИСУТСТВИЯ идентификатора в файле, не поведения: обход, при котором импорт
    // остался, а `withLock` больше не зовётся, здесь не виден (проверено мутацией). Его ловит
    // поведенческий `tests/bankAccountRename.test.ts`. Название теста говорит ровно то, что он
    // делает, — обещать больше значит создать ложное чувство покрытия.
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
