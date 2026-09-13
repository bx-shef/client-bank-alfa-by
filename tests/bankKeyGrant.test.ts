import { describe, expect, it } from 'vitest'
import { signKeyGrant, verifyKeyGrant } from '../server/utils/bankKeyGrant'
import { signConnectState, verifyConnectState } from '../server/utils/bankConnectState'
import { signSession, verifySession } from '../server/utils/session'

// Подписанный грант на ввод ключа API (#19).

const SECRET = 's'.repeat(48)
const NOW = Date.UTC(2026, 8, 13, 6, 0)
const grant = { memberId: 'M1', provider: 'alfa-by' as const, userId: '7', exp: NOW + 86_400_000 }

describe('круговой рейс', () => {
  it('подписанный грант читается обратно', () => {
    expect(verifyKeyGrant(signKeyGrant(grant, SECRET), SECRET, NOW)).toEqual(grant)
  })

  it('просроченный отвергается', () => {
    const v = signKeyGrant({ ...grant, exp: NOW - 1 }, SECRET)
    expect(verifyKeyGrant(v, SECRET, NOW)).toBeNull()
  })

  it('чужая подпись, мусор и обрезки отвергаются, ничего не бросая', () => {
    const v = signKeyGrant(grant, SECRET)
    for (const bad of ['', '.', 'abc', v.slice(0, -2), `${v}x`, v.replace('.', '.x')]) {
      expect(verifyKeyGrant(bad, SECRET, NOW), JSON.stringify(bad)).toBeNull()
    }
    expect(verifyKeyGrant(v, 'другой-секрет'.repeat(4), NOW)).toBeNull()
  })

  // Пустой секрет ⇒ подписать нечем; проверка обязана отвергать, а не «пропускать без подписи».
  it('без секрета fail-closed в обе стороны', () => {
    expect(signKeyGrant(grant, '')).toBe('')
    expect(verifyKeyGrant(signKeyGrant(grant, SECRET), '', NOW)).toBeNull()
  })

  it('неполное тело отвергается', () => {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    // тело без userId, подписанное ВЕРНО — проверка обязана смотреть не только на подпись
    const body = b64({ memberId: 'M1', provider: 'alfa-by', exp: NOW + 1000 })
    const crypto = require('node:crypto') as typeof import('node:crypto')
    const sig = crypto.createHmac('sha256', SECRET).update(`cba.bankkey.v1|${body}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(verifyKeyGrant(`${body}.${sig}`, SECRET, NOW)).toBeNull()
  })
})

describe('РАЗДЕЛЕНИЕ ДОМЕНОВ ПОДПИСИ', () => {
  // ⚠ Главный инвариант модуля. Секрет один на три вида значений (сессия оператора, connect-state,
  // грант), и без отдельного тега грант на СУТКИ проверялся бы как `state` возврата из банка или
  // как сессионная кука. Проверяем в ОБЕ стороны каждой пары: односторонняя проверка пропустила бы
  // ровно половину способов подмены.
  const key = signKeyGrant(grant, SECRET)
  const state = signConnectState(
    { memberId: 'M1', provider: 'alfa-by', nonce: 'n', exp: NOW + 60_000 }, SECRET
  )
  const session = signSession({ sub: 'operator', exp: Math.floor(NOW / 1000) + 3600 }, SECRET)

  it('грант не читается как connect-state и наоборот', () => {
    expect(verifyConnectState(key, SECRET, NOW)).toBeNull()
    expect(verifyKeyGrant(state, SECRET, NOW)).toBeNull()
  })

  it('грант не читается как сессия оператора и наоборот', () => {
    expect(verifySession(key, SECRET, NOW)).toBeNull()
    expect(verifyKeyGrant(session, SECRET, NOW)).toBeNull()
  })
})
