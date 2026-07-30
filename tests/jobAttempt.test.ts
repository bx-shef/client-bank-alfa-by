import { describe, expect, it } from 'vitest'
import { isFinalAttempt } from '../server/utils/jobAttempt'

// От этого зависит, увидит ли сотрудник «не разобралось» преждевременно (#417): на промежуточной
// попытке BullMQ ещё переспросит, и показывать провал рано — через минуту пришлось бы передумать.

describe('isFinalAttempt', () => {
  it('первая из трёх — не последняя', () => {
    expect(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } })).toBe(false)
    expect(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } })).toBe(false)
  })

  it('последняя из трёх — последняя', () => {
    expect(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } })).toBe(true)
  })

  it('очередь без ретраев: первая попытка и есть последняя', () => {
    // Так устроен `crm-sync` — `attempts` ему не задаётся. Считай мы иначе, терминальный сбой
    // не пометился бы вовсе, и загрузка осталась бы «в обработке» навсегда.
    expect(isFinalAttempt({ attemptsMade: 0 })).toBe(true)
    expect(isFinalAttempt({ attemptsMade: 0, opts: {} })).toBe(true)
  })
})
