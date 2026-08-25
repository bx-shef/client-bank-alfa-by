import { describe, expect, it, vi } from 'vitest'
import { probeSubscriptionVia, SUBSCRIPTION_PROBE_METHOD } from '../server/utils/subscriptionProbe'

// Живой перезапрос перед необратимым отключением (#614).
//
// ⚠ Исходов ТРИ, и `unknown` здесь несущий: он единственный отделяет «портал сказал, что подписки
// нет» от «мы не смогли спросить». За второе рвать связь с банком нельзя.

describe('перезапрос подписки', () => {
  it('вызов прошёл — подписка жива', async () => {
    const call = vi.fn(async () => ({ result: {} }))
    expect(await probeSubscriptionVia(call)).toBe('alive')
    expect(call).toHaveBeenCalledWith(SUBSCRIPTION_PROBE_METHOD, {})
  })

  it('отказ говорит именно о подписке — мертва', async () => {
    const call = vi.fn(async () => {
      throw new Error('Subscription has been ended')
    })
    expect(await probeSubscriptionVia(call)).toBe('dead')
  })

  it('ЛЮБОЙ другой отказ — «не знаем», а не «мертва»', async () => {
    // У недовыданных прав, исчерпанного лимита и мёртвого гранта свои механизмы. Отключать банк
    // за них нельзя — иначе автоотключение стало бы реакцией на что угодно.
    for (const msg of ['QUERY_LIMIT_EXCEEDED', 'ACCESS_DENIED', 'invalid_grant', 'socket hang up']) {
      const call = vi.fn(async () => {
        throw new Error(msg)
      })
      expect(await probeSubscriptionVia(call), msg).toBe('unknown')
    }
  })

  it('токена нет — судить не по чему, «не знаем»', async () => {
    expect(await probeSubscriptionVia(null)).toBe('unknown')
  })

  it('запрос ПУСТОЙ — иначе наш же текст мог бы вернуться эхом и подтвердить сам себя', async () => {
    // Метку ставит регулярка по тексту ошибки, а тексты мы иногда отправляем сами (назначение
    // платежа пишет плательщик). Перезапрос обязан не нести НИЧЕГО, что может отразиться обратно.
    const call = vi.fn(async (_m: string, params: Record<string, unknown>) => {
      sent.push(params)
      return { result: {} }
    })
    const sent: Record<string, unknown>[] = []
    await probeSubscriptionVia(call)
    expect(JSON.stringify(sent[0])).toBe('{}')
  })
})
