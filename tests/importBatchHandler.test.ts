import { describe, expect, it, vi } from 'vitest'
import { handleImportBatch, parseBatchIds, type ImportBatchDeps } from '../server/utils/importBatchHandler'
import { MAX_BATCH_IDS } from '../server/utils/importBatchStore'

// Гейт чтения итогов загрузки (#417). Ключ загрузки — sha256 ФАЙЛА, то есть не секрет: его знает
// всякий, у кого есть такой же файл. Поэтому важно, что доступ держат домен+токен, а скоуп по
// порталу уходит в запрос — иначе чужой портал читал бы наши счётчики по угаданному ключу.

const ID_A = 'a'.repeat(64)
const ID_B = 'b'.repeat(64)

function deps(over: Partial<ImportBatchDeps> = {}): ImportBatchDeps {
  return {
    memberIdByDomain: vi.fn(async () => 'M1'),
    validateFrame: vi.fn(async () => '7'),
    getBatches: vi.fn(async () => []),
    ...over
  }
}

const input = { accessToken: 'T', domain: 'p.bitrix24.by', ids: ID_A }

describe('parseBatchIds', () => {
  it('пропускает только sha256-hex', () => {
    // Иначе в запрос уехал бы произвольный текст из строки запроса.
    expect(parseBatchIds(`${ID_A},мусор,123`)).toEqual([ID_A])
  })

  it('снимает дубли и приводит к нижнему регистру', () => {
    expect(parseBatchIds(`${ID_A},${ID_A.toUpperCase()}`)).toEqual([ID_A])
  })

  it('ограничивает количество', () => {
    const many = Array.from({ length: MAX_BATCH_IDS + 5 }, (_, i) => i.toString(16).padStart(64, '0')).join(',')
    expect(parseBatchIds(many)).toHaveLength(MAX_BATCH_IDS)
  })

  it('пустая строка — пусто', () => {
    expect(parseBatchIds('')).toEqual([])
  })
})

describe('handleImportBatch', () => {
  it('отдаёт итоги установленного портала по проверенному токену', async () => {
    const getBatches = vi.fn(async () => [])
    const res = await handleImportBatch(deps({ getBatches }), { ...input, ids: `${ID_A},${ID_B}` })
    expect(res.status).toBe(200)
    // Скоуп по порталу уходит В ЗАПРОС, а не фильтруется после — иначе чужие строки успели бы
    // покинуть БД.
    // Скоуп уходит В ЗАПРОС — и по порталу, и по СОТРУДНИКУ: ключ это хеш файла, значит коллега
    // с той же выпиской иначе прочитал бы имя файла и счётчики чужой загрузки.
    expect(getBatches).toHaveBeenCalledWith('M1', [ID_A, ID_B], '7')
  })

  it('пустой userId от портала — тоже 403 (усечённый конверт не должен проезжать гейт)', async () => {
    const getBatches = vi.fn(async () => [])
    const d = deps({ validateFrame: vi.fn(async () => ''), getBatches })
    expect((await handleImportBatch(d, input)).status).toBe(403)
    expect(getBatches).not.toHaveBeenCalled()
  })

  it('без токена/домена — 400', async () => {
    expect((await handleImportBatch(deps(), { ...input, accessToken: '' })).status).toBe(400)
    expect((await handleImportBatch(deps(), { ...input, domain: '' })).status).toBe(400)
  })

  it('портал не установлен — 409', async () => {
    const d = deps({ memberIdByDomain: vi.fn(async () => null) })
    expect((await handleImportBatch(d, input)).status).toBe(409)
  })

  it('чужой/битый фрейм-токен — 403 и БЕЗ чтения БД', async () => {
    const getBatches = vi.fn(async () => [])
    const reject = vi.fn(async () => {
      throw new Error('nope')
    })
    const d = deps({ validateFrame: reject, getBatches })
    expect((await handleImportBatch(d, input)).status).toBe(403)
    expect(getBatches).not.toHaveBeenCalled()
  })

  it('пустой список ключей — 200 и НИ ОДНОГО обращения наружу', async () => {
    // UI зовёт роут по таймеру и мог остаться без ключей; дёргать за это портал незачем.
    const memberIdByDomain = vi.fn(async () => 'M1')
    const validateFrame = vi.fn(async () => '7')
    const res = await handleImportBatch(deps({ memberIdByDomain, validateFrame }), { ...input, ids: '' })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ batches: [] })
    expect(memberIdByDomain).not.toHaveBeenCalled()
    expect(validateFrame).not.toHaveBeenCalled()
  })
})
