import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { purgePortalStorage, portalPurgeReasonText, type PortalPurgeDeps } from '../server/utils/portalPurge'

// Гард полного стирания данных портала (#654).
//
// ⚠ Дефект, из которого это выросло, НЕ был опечаткой: список хранилищ существовал в двух
// экземплярах, и второй (аварийный путь приёма `ONAPPUNINSTALL`, работающий когда Redis недоступен)
// стирал ОДНУ таблицу из семи. Недостиранными оставались банковские креды, а продление намеренно
// вынесено из-под гейта Redis (#489) и обновляло их дальше — бессрочно, и ни один уборщик до них
// не дотягивался. Поэтому тест сторожит не текст, а СТРУКТУРУ: список должен быть один.

const ROOT = join(import.meta.dirname, '..')
const WORKER = readFileSync(join(ROOT, 'server/queue/worker.ts'), 'utf8')
const EVENTS = readFileSync(join(ROOT, 'server/api/b24/events.post.ts'), 'utf8')

/** Собирает порядок вызовов, чтобы проверять его, а не пересказывать. */
function recordingDeps(): { deps: PortalPurgeDeps, calls: string[] } {
  const calls: string[] = []
  const rec = (name: string) => async () => {
    calls.push(name)
    return undefined
  }
  return {
    calls,
    deps: {
      deleteBankTokensForPortal: rec('bank'),
      deleteToken: rec('portal'),
      deleteImportResultForPortal: rec('import-result'),
      deleteBatchesForPortal: rec('batches'),
      deleteMetricsForPortal: rec('metrics'),
      deleteRatingForPortal: rec('rating'),
      deleteLeasesForPortal: rec('leases')
    }
  }
}

describe('стирание портала — один список на все пути (#654)', () => {
  it('банковские креды стираются ПЕРВЫМИ', async () => {
    // ⚠ Порядок несущий, а не косметика. Транзакции нет; стой `portal_tokens` первым, портал после
    // частичного отказа никогда бы не попал в выборку уборщика (#574 читает именно эту таблицу),
    // а до банковских строк не дотянулся бы никто — утечка стала бы неустранимой.
    const { deps, calls } = recordingDeps()
    await purgePortalStorage((async () => []) as never, 'm1', 42, deps)
    expect(calls[0]).toBe('bank')
    expect(calls).toHaveLength(7)
  })

  it('стираются ВСЕ семь хранилищ', async () => {
    const { deps, calls } = recordingDeps()
    await purgePortalStorage((async () => []) as never, 'm1', 42, deps)
    expect(new Set(calls)).toEqual(
      new Set(['bank', 'portal', 'import-result', 'batches', 'metrics', 'rating', 'leases'])
    )
  })

  it('метка времени события доезжает до тумбстоуна (#77)', async () => {
    // Без неё «зависший» register воскресил бы портал после более свежего uninstall.
    let seen = -1
    const { deps } = recordingDeps()
    deps.deleteToken = async (_q, _m, eventTs) => {
      seen = eventTs
      return undefined
    }
    await purgePortalStorage((async () => []) as never, 'm1', 4242, deps)
    expect(seen).toBe(4242)
  })

  it('повод называется словами и различает два случая', () => {
    // Уборщик мёртвых грантов (#574) ходит сюда же, а клиент у него ничего не удалял: одинаковый
    // текст дал бы оператору уверенный неверный ответ на вопрос «куда делось подключение».
    expect(portalPurgeReasonText('uninstall')).toContain('ONAPPUNINSTALL')
    expect(portalPurgeReasonText('grant-dead')).toContain('исчез без уведомления')
    expect(portalPurgeReasonText('uninstall')).not.toBe(portalPurgeReasonText('grant-dead'))
  })

  it('ОБА пути зовут общий список, а не свой', () => {
    // ⚠ Ровно этого и не хватало: аварийный путь стирал `portal_tokens` в одиночку. Структурная
    // проверка, потому что поведенческая до роутов не доходит — они собираются Nitro.
    for (const [name, src] of [['worker', WORKER], ['events.post', EVENTS]] as const) {
      expect(src, `${name} обязан звать общий purgePortalStorage`).toContain('purgePortalStorage(')
      expect(src, `${name} обязан брать боевую проводку из одного места`).toContain('LIVE_PORTAL_PURGE_DEPS')
    }
  })

  it('ни один путь не держит СВОЮ копию списка', () => {
    // Вернуть копию «на всякий случай» — первое, что придёт в голову следующему: покажется, что
    // так надёжнее. Надёжнее ровно наоборот — разъезжается то, что записано дважды.
    const OWN_LIST = /delete(BankTokensForPortal|ImportResultForPortal|BatchesForPortal|MetricsForPortal|RatingForPortal|LeasesForPortal)\s*\(\s*dbQuery/
    for (const [name, src] of [['worker', WORKER], ['events.post', EVENTS]] as const) {
      expect(OWN_LIST.test(src), `${name} снова стирает хранилища сам — список должен быть один`).toBe(false)
    }
  })
})
