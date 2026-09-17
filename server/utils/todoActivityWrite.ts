// Transport for the universal timeline activity (#495): create it, then stamp our dedup marker.
//
// ⚠ НОСИТЕЛЕЙ ДВА (#722). Основной — универсальное дело `crm.activity.todo.add`. Портал, где такого
// метода нет (старая коробка, не обновлённый модуль CRM), отвечает `ERROR_METHOD_NOT_FOUND`, и до
// этой правки не записывал НИ ОДНОЙ операции при полностью исправном всём остальном. Запасной —
// системное `crm.activity.add` (`legacyActivity.ts`), туда уходит то же описание и ТОТ ЖЕ маркер.
// Выбор делает сам портал своим ответом, результат кэшируется на процесс.
//
// Two calls, and that is forced, not chosen: `crm.activity.todo.add` accepts no external-source
// marker, and `DESCRIPTION_TYPE` (BB vs HTML) has no parameter there either — both live only on
// `crm.activity.update`. The builder explains why the carrier changed anyway; this module's job is
// to make the two-call sequence behave as much like one call as the API allows.
//
// THE WINDOW, AND WHAT WE DO ABOUT IT. Between `add` and `update` an activity exists with NO
// marker. If we stopped there, a retry would not find it and would write a SECOND activity, while
// the first stayed invisible to dedup forever — a duplicate in a client's timeline that nothing
// ever cleans up. So a failed update is COMPENSATED: we delete the activity we just created and
// let the error propagate, so BullMQ retries from a clean state.
//
// ⚠ What remains: a hard crash (process killed, container evicted) between `add` and the
// compensating `delete`. That leaves one orphan and one eventual duplicate. It cannot be closed
// from this side — only an atomic create-with-marker could, and the API does not offer one for
// this activity type. It is the accepted cost of a card that works, and it is bounded: one
// duplicate per crash, not per operation.

import type { BankProviderId, StatementItem } from '../../app/types/statement'
import {
  ACTIVITY_DELETE_METHOD, ACTIVITY_ORIGINATOR_ID, ACTIVITY_UPDATE_METHOD, TODO_ACTIVITY_ADD_METHOD,
  buildActivityMarkerUpdate, buildTodoActivity
} from '../../app/utils/todoActivity'
import {
  LEGACY_ACTIVITY_ADD_METHOD, buildLegacyActivity, extractLegacyActivityId
} from '../../app/utils/legacyActivity'
import { buildActivityBlocks, buildActivityBlocksCall } from '../../app/utils/activityBlocks'
import type { PortalCurrencyFormats } from '../../app/utils/currencyFormat'
import { CRM_OWNER_TYPE_COMPANY } from '../../app/utils/activity'
import { dedupKey } from '../../app/utils/statement'
import { findActivityByMarker } from './activityMarkerLookup'
import type { RestCall } from './companyLookup'
import { portalErrorCode } from './portalError'
import { useServerLogger } from './serverLogger'

const log = useServerLogger('activity')

/**
 * Portals whose marker mechanism has been proven ON THIS PROCESS. See `verifyMarkerOnce`.
 * In-memory by design: it is a probe, not a fact worth persisting, and a restart re-proving it
 * costs one REST call.
 */
const markerProven = new Set<string>()

/**
 * Порталы, у которых `crm.activity.todo.add` НЕТ (#722) — пишем им системное дело.
 *
 * ⚠ Определяется ОТВЕТОМ портала, а не опросом `methods` заранее: на здоровом портале (а их
 * подавляющее большинство) проба стоила бы лишнего REST-вызова ради заранее известного ответа,
 * тогда как отказ метода приходит сам и ровно один раз — дальше работает кэш.
 * ⚠ В памяти, а не в БД: наличие метода меняется обновлением Битрикса, то есть никогда — в пределах
 * жизни процесса; перезапуск стоит одной лишней пробы.
 */
const legacyPortals = new Set<string>()

/** Код, которым Битрикс отвечает на неизвестный метод. */
const METHOD_NOT_FOUND = 'ERROR_METHOD_NOT_FOUND'

/**
 * Отказал ли вызов именно из-за ОТСУТСТВИЯ метода.
 *
 * ⚠ Смотрим МАШИННЫЙ код, а не текст: описание портал отдаёт на своём языке, и разбор строки
 * перестал бы работать молча на первом же не-русском портале. `portalErrorCode` заодно
 * разворачивает обёртку SDK (#574).
 * ⚠ Условие УЗКОЕ намеренно: любой другой отказ (нет прав, портал лёг, кривые параметры) обязан
 * пробросить джобу в ретрай, а не увести запись на запасной носитель — иначе разовый сбой навсегда
 * переключил бы портал на устаревший метод.
 */
export function isMethodNotFound(e: unknown): boolean {
  return portalErrorCode(e).toUpperCase() === METHOD_NOT_FOUND
}

/** Для тестов: модульный кэш иначе протекает между случаями. */
export function resetCarrierProbe(): void {
  legacyPortals.clear()
}

/** How hard the proof tries before calling the marker absent — see the retry note in
 *  `verifyMarkerOnce`. Runs once per portal per process, so the budget is generous on purpose. */
export const MARKER_VERIFY_ATTEMPTS = 3
export const MARKER_VERIFY_DELAY_MS = 1000

/** Exposed for tests — a module-level cache would otherwise leak between cases. */
export function resetMarkerProof(): void {
  markerProven.clear()
}

/**
 * Ключ доказательства маркера — портал ПЛЮС носитель (#722).
 *
 * ⚠ Один ключ на портал был бы дырой: маркер на универсальном деле ставится ВТОРЫМ вызовом и
 * доказан отдельно, а на системном приходит внутри создающего вызова — это разные механизмы, и
 * доказательство одного не ручается за другой. Портал носитель не меняет (метод либо есть, либо
 * нет), поэтому на практике ключ один; но инвариант «доказали ровно то, чем пишем» должен
 * держаться конструкцией, а не совпадением.
 */
function proofKey(memberId: string, carrier: 'todo' | 'legacy'): string {
  return `${memberId}|${carrier}`
}

/**
 * Prove — ONCE per portal per process — that the marker we just stamped is actually findable.
 *
 * WHY THIS EXISTS. The marker is set by a SECOND call (`crm.activity.update`), because `todo.add`
 * does not accept it. The compensating delete above covers an update that ERRORS. It does not cover
 * an update that reports success while the field does not stick — and that failure is silent,
 * total, and unbounded: `findActivityByMarker` finds nothing on the next run, so EVERY operation is
 * written again, every poll, forever, into a client's CRM. Unit tests cannot rule it out (they do
 * not know what a real portal does with these fields on this activity type), which is exactly why
 * the smoke script existed as a manual pre-deploy gate.
 *
 * So the code proves it itself, on the first real write: read the marker back the same way the next
 * run would. If it is not there, throw — the job retries, the operation is not silently duplicated,
 * and the message says what to check. One extra REST call per portal per process is a rounding
 * error next to a timeline nobody can clean up.
 *
 * ⚠ Failure to VERIFY (transport error) is not failure to mark: it is rethrown by `call` and
 * handled as any other transient error. Only a definite «not found» is treated as proof of absence.
 */
async function verifyMarkerOnce(
  item: StatementItem,
  memberId: string,
  call: RestCall,
  carrier: 'todo' | 'legacy' = 'todo',
  sleep: (ms: number) => Promise<void> = ms => new Promise(r => setTimeout(r, ms))
): Promise<void> {
  const proof = proofKey(memberId, carrier)
  if (markerProven.has(proof)) return
  const key = dedupKey(item)
  // ⚠ RETRIED, because «not found immediately» and «not settable» are different facts and only the
  // second one deserves a thrown job. We are reading back a field written a moment ago through a
  // different method; if the portal needs a beat to make it searchable, a single-shot check would
  // fail the FIRST job of every healthy portal — turning a safety net into an outage. Three tries
  // over a couple of seconds cost nothing (this runs once per portal per process) and leave only
  // the genuine case: the update reported success and the field is simply not there.
  for (let attempt = 1; attempt <= MARKER_VERIFY_ATTEMPTS; attempt += 1) {
    if (await findActivityByMarker(ACTIVITY_ORIGINATOR_ID, key, call)) {
      markerProven.add(proof)
      return
    }
    if (attempt < MARKER_VERIFY_ATTEMPTS) await sleep(MARKER_VERIFY_DELAY_MS)
  }
  throw new Error(
    '[activity] the dedup marker did not stick: the activity was created and updated without error, '
    + 'but a search by ORIGINATOR_ID/ORIGIN_ID does not find it. Every operation would be written '
    + 'again on every run. Check that crm.activity.update may set these fields on this portal '
    + '(pnpm activity:test --company <id> --apply).'
  )
}

/**
 * Remove an activity we created but could not make findable. Best-effort: if the delete ITSELF
 * fails we log and let the caller surface the ORIGINAL error, because that is the one that explains
 * what happened — and the surviving orphan is exactly what the log line warns about.
 */
async function deleteOrphan(id: string, call: RestCall): Promise<void> {
  try {
    await call(ACTIVITY_DELETE_METHOD, { id: Number(id) })
  } catch (deleteError) {
    log.error(`could not delete the unmarked activity ${id} — a duplicate will appear on the next run: ${(deleteError as Error)?.message}`)
  }
}

/**
 * Pull the created activity id out of the `todo.add` response.
 *
 * ⚠ The shape differs from the configurable path: `todo.add` answers `{result:{id}}` (and some
 * portals `{result: id}`), while `configurable.add` nested it as `{result:{activity:{id}}}`.
 * Both spellings are accepted here because getting this wrong is silent — a null id reads as
 * «nothing was written», the marker never gets stamped, and every poll re-creates the activity.
 */
export function extractTodoActivityId(resp: Record<string, unknown>): string | null {
  const result = resp?.result
  if (result === undefined || result === null) return null
  const raw = typeof result === 'object' ? (result as Record<string, unknown>).id : result
  if (raw === undefined || raw === null || `${raw}` === '') return null
  const id = `${raw}`
  // A non-numeric id means we misread the envelope; treating it as valid would stamp the marker
  // onto nothing and hide the problem behind a successful-looking job.
  return /^\d+$/.test(id) ? id : null
}

/**
 * Create the activity for `item` on CRM company `companyId`, stamp the dedup marker, and return
 * the new id (or null when the API returned none). `note` prepends a reason block (the
 * unmatched-client fallback, #91). Transport errors propagate — BullMQ retries the job.
 */
export async function writeTodoActivityViaRest(
  item: StatementItem,
  companyId: string,
  call: RestCall,
  note?: string,
  /** Portal id — used only to prove the marker mechanism once per process (`verifyMarkerOnce`).
   *  Omitted ⇒ no verification (keeps the smoke script and older callers working unchanged). */
  memberId?: string,
  /** Injected only by tests, so the retry loop does not spend real seconds. */
  sleep?: (ms: number) => Promise<void>,
  /** Откуда приехала операция — показывается блоком «Источник» (#729). Необязателен: без него
   *  блок honest-fallback'ом говорит «Импорт выписки», а не выдумывает банк. */
  providerId?: BankProviderId
): Promise<string | null> {
  // Портал уже показал, что нового метода у него нет — второй раз не спрашиваем (#722).
  if (memberId && legacyPortals.has(memberId)) {
    return writeLegacyActivityViaRest(item, companyId, call, note, memberId, sleep)
  }

  // ⚠ Справочник валют берётся ДО создания дела, а не только для блоков: заголовок обязан
  // подписывать сумму так же, как таблица под ним (#729). Вызов кэширован на портал и не бросает.
  const currencies = await loadPortalCurrencies(call, memberId)
  const params = buildTodoActivity(item, { id: Number(companyId) }, note, currencies)
  let added: Record<string, unknown>
  try {
    added = await call(TODO_ACTIVITY_ADD_METHOD, params as unknown as Record<string, unknown>)
  } catch (addError) {
    // ⚠ Переключаемся ТОЛЬКО на «метода нет». Любой другой отказ — это состояние портала или сети,
    // и он обязан уронить джобу в ретрай: увести запись на устаревший метод из-за разовой ошибки
    // значило бы молча и навсегда сменить носитель здоровому порталу.
    if (!isMethodNotFound(addError)) throw addError
    if (memberId) legacyPortals.add(memberId)
    log.warning(
      `crm.activity.todo.add is not available on this portal — falling back to ${LEGACY_ACTIVITY_ADD_METHOD}; `
      + 'дела будут создаваться системными (без цвета), направление видно в заголовке и описании'
    )
    return writeLegacyActivityViaRest(item, companyId, call, note, memberId, sleep)
  }
  const id = extractTodoActivityId(added)
  // No id ⇒ nothing to mark and nothing to clean up. Returning null keeps the caller's existing
  // contract («not written»), which counts the op unmatched and retries it on the next poll.
  if (!id) return null

  try {
    await call(ACTIVITY_UPDATE_METHOD, { id: Number(id), fields: buildActivityMarkerUpdate(item) })
  } catch (updateError) {
    // Compensate: an unmarked activity is worse than none — it is a permanent duplicate-in-waiting.
    await deleteOrphan(id, call)
    throw updateError
  }

  // Проверяется ПОСЛЕ успешной маркировки и только один раз на портал: см. `verifyMarkerOnce`.
  //
  // ⚠ Провал проверки КОМПЕНСИРУЕТСЯ так же, как провал маркировки, и по той же причине. Без этого
  // на сломанном портале каждая попытка BullMQ оставляла бы по одному ненаходимому делу: джоба
  // падает, ретрай не находит маркер, пишет заново, снова падает. Ограниченно (числом попыток, а не
  // числом операций) — но ноль лучше, чем «немного». А если маркер на самом деле стоял и мы просто
  // не смогли его прочитать, удаление тоже безвредно: повторный прогон создаст дело заново.
  if (memberId) {
    try {
      await verifyMarkerOnce(item, memberId, call, 'todo', sleep)
    } catch (verifyError) {
      await deleteOrphan(id, call)
      throw verifyError
    }
  }

  await attachBlocks(item, id, companyId, call, providerId, currencies)
  return id
}

/**
 * Повесить на дело нашу таблицу блоков (#729).
 *
 * ⚠ ЛУЧШИЕ УСИЛИЯ И НИКОГДА НЕ БРОСАЕТ, и это не «на всякий случай». Вызов идёт ПОСЛЕ маркера,
 * то есть операция уже записана и уже зачтена дедупом: проброс отменил бы обработку всей оставшейся
 * пачки, ничего не починив — повтор упрётся в маркер и до этой строки не дойдёт. Ровно тот же довод,
 * по которому не бросают привязки дела (#579).
 *
 * ⚠ Цена отказа названа и она мала: блоки не несут НИЧЕГО, чего нет больше нигде — сумма,
 * направление и контрагент дублируются заголовком дела, назначение лежит в описании. Карточка
 * станет беднее, сведения не потеряются.
 *
 * ⚠ Ошибка пишется в лог, но НЕ в чат ошибок клиента: это оформление карточки, а не платёж,
 * требующий человека, и звать бухгалтера сюда значило бы приучить его не читать тот канал.
 */
async function attachBlocks(
  item: StatementItem,
  activityId: string,
  companyId: string,
  call: RestCall,
  providerId?: BankProviderId,
  currencies?: PortalCurrencyFormats
): Promise<void> {
  try {
    const { method, params } = buildActivityBlocksCall(
      activityId, CRM_OWNER_TYPE_COMPANY, Number(companyId), buildActivityBlocks(item, providerId, currencies)
    )
    await call(method, params)
  } catch (blocksError) {
    log.warning(`дело ${activityId}: блоки карточки не поставлены — ${(blocksError as Error).message}`)
  }
}

/**
 * Запасной носитель: СИСТЕМНОЕ дело `crm.activity.add` (#722) — для порталов без
 * `crm.activity.todo.add`.
 *
 * ⚠ ОДИН вызов вместо двух, и окна «дело без маркера» здесь НЕТ: `ORIGINATOR_ID`/`ORIGIN_ID`
 * принимает сам создающий метод. Поэтому нет ни компенсирующего удаления после маркировки, ни
 * остаточного риска дубля при падении процесса между вызовами — то есть по идемпотентности этот
 * путь строго лучше основного. Ценой цвета в ленте (см. `legacyActivity.ts`).
 *
 * ⚠ Самопроверка маркера ОСТАЁТСЯ, хотя вызов один. Она отвечает не на вопрос «дошёл ли второй
 * вызов», а на вопрос «находится ли записанное тем же поиском, каким его будет искать дедуп», —
 * и молчаливый отказ здесь стоил бы ровно того же: каждая операция писалась бы заново, каждый
 * опрос, навсегда. Поля системного дела мы на живой старой коробке не мерили, так что повод
 * проверить тут даже весомее.
 */
export async function writeLegacyActivityViaRest(
  item: StatementItem,
  companyId: string,
  call: RestCall,
  note?: string,
  memberId?: string,
  sleep?: (ms: number) => Promise<void>
): Promise<string | null> {
  const responsibleId = await resolveResponsibleId(call, memberId)
  const currencies = await loadPortalCurrencies(call, memberId)
  const params = buildLegacyActivity(item, { id: Number(companyId) }, responsibleId, note, currencies)
  const added = await call(LEGACY_ACTIVITY_ADD_METHOD, params as unknown as Record<string, unknown>)
  const id = extractLegacyActivityId(added)
  if (!id) return null

  if (memberId) {
    try {
      await verifyMarkerOnce(item, memberId, call, 'legacy', sleep)
    } catch (verifyError) {
      await deleteOrphan(id, call)
      throw verifyError
    }
  }
  return id
}

/**
 * Ответственный за системное дело.
 *
 * ⚠ Поле ОБЯЗАТЕЛЬНОЕ именно у системного дела («The field RESPONSIBLE_ID is not defined or
 * invalid»), тогда как `todo.add` обходится без него и мы его не шлём вовсе. Значит на запасном
 * пути значение нужно взять откуда-то, а человека у фоновой обработки нет.
 *
 * ⚠ Берём владельца СОХРАНЁННОГО токена (`profile` → `ID`) — того, от чьего имени приложение и так
 * пишет всё остальное в этот портал (`PERMISSIONS.md`). Это не выбор «правильного» ответственного,
 * а единственное значение, которое у нас есть и которое заведомо существует на портале; назначать
 * дела по-другому — работа админа в самой CRM.
 *
 * ⚠ Один вызов на портал на процесс, и только на запасном пути: здоровый портал за это не платит
 * ничего. Отказ ПРОБРАСЫВАЕТСЯ — без ответственного вызов всё равно был бы отвергнут, и честный
 * ретрай лучше, чем подставленная единица (id 1 существует не на каждом портале и означал бы
 * «свалить дела клиента на случайного человека»).
 */
const responsibleByPortal = new Map<string, number>()

/** Для тестов: модульный кэш иначе протекает между случаями. */
export function resetResponsibleCache(): void {
  responsibleByPortal.clear()
}

/**
 * Справочник валют портала для блока суммы (#729) — ОДИН вызов на портал на процесс.
 *
 * ⚠ Ходим в портал, потому что формат валюты — его настройка, а не мировая константа: замерено,
 * что BYN там подписан «руб.», RUB отдаётся HTML-сущностью, а у USD символ стоит ПЕРЕД суммой.
 * Штатный `Intl` про это не знает и печатал «1 840,50 BYN» рядом с «29,00 ₽».
 *
 * ⚠ ОТКАЗ НЕ БРОСАЕТ, и это несущее: справочник нужен для ОФОРМЛЕНИЯ, а не для записи. Пустой
 * ответ кэшируется наравне с удачным — иначе портал, у которого метод закрыт правами, спрашивался
 * бы на КАЖДОЙ операции выписки в сотни строк.
 */
const currenciesByPortal = new Map<string, PortalCurrencyFormats>()

/** Для тестов: модульный кэш иначе протекает между случаями. */
export function resetCurrencyCache(): void {
  currenciesByPortal.clear()
}

async function loadPortalCurrencies(call: RestCall, memberId?: string): Promise<PortalCurrencyFormats> {
  if (!memberId) return {}
  const cached = currenciesByPortal.get(memberId)
  if (cached) return cached
  const formats: PortalCurrencyFormats = {}
  try {
    const resp = await call('crm.currency.list', {})
    const rows = (resp as Record<string, unknown>)?.result
    if (Array.isArray(rows)) {
      for (const raw of rows as Record<string, unknown>[]) {
        const code = String(raw?.CURRENCY ?? '').trim().toUpperCase()
        const formatString = String(raw?.FORMAT_STRING ?? '').trim()
        if (!code || !formatString) continue
        const decimals = Number(raw?.DECIMALS)
        formats[code] = { formatString, decimals: Number.isInteger(decimals) && decimals >= 0 ? decimals : 2 }
      }
    }
  } catch (currencyError) {
    log.warning(`справочник валют портала недоступен, сумма покажется кодом — ${(currencyError as Error).message}`)
  }
  currenciesByPortal.set(memberId, formats)
  return formats
}

async function resolveResponsibleId(call: RestCall, memberId?: string): Promise<number> {
  const cached = memberId ? responsibleByPortal.get(memberId) : undefined
  if (cached) return cached
  const resp = await call('profile', {})
  const result = (resp as Record<string, unknown>)?.result
  const raw = result && typeof result === 'object' ? (result as Record<string, unknown>).ID : undefined
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error('[activity] portal profile returned no usable ID — cannot set RESPONSIBLE_ID for crm.activity.add')
  }
  if (memberId) responsibleByPortal.set(memberId, id)
  return id
}
