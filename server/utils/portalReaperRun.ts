// Уборщик порталов с мёртвым грантом (#574) — сшивка чистого правила с базой.
//
// ⚠ ЕДИНСТВЕННЫЙ механизм в приложении, который стирает данные клиента без его действия. Всё
// остальное удаление событийное (`ONAPPUNINSTALL`) или возрастное по агрегатам. Поэтому здесь
// важнее не «поймать всех», а «не тронуть живого» — обоснование каждого решения в
// `app/utils/portalReaper.ts`.
//
// ⚠ Зачем: портал может исчезнуть не по-штатному (удалён без доставки события, сменил домен), и
// тогда агрегаты уйдут по TTL, а `portal_tokens` и особенно `bank_tokens` останутся — и продление
// (#175) будет их ОБНОВЛЯТЬ. То есть мы держим и освежаем банковские доступы клиента, который уже
// не наш. Это приватность (`docs/PRIVACY.md`), а не уборка мусора.

import { MAX_REAP_PER_RUN, reaperLogLine, reapVerdict } from '../../app/utils/portalReaper'

/** Инъектируемые side-effects — чтобы правило тестировалось без базы. */
export interface PortalReaperDeps {
  now: () => number
  /** Сколько порталов помечено мёртвым грантом дольше порога (для строки лога). */
  countRevoked: (beforeMs: number) => Promise<number>
  /** Кандидаты на удаление: самые давние первыми, не больше `limit`. Возвращает и МЕТКУ, потому
   *  что решение перепроверяется чистым правилом — см. `runPortalReaper`. */
  selectReapable: (beforeMs: number, limit: number) => Promise<{ memberId: string, revokedAtMs: number }[]>
  /** Полная чистка портала — ТОТ ЖЕ путь, что у штатного `ONAPPUNINSTALL`. */
  deletePortal: (memberId: string, eventTs: number) => Promise<void>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

export interface PortalReaperSummary {
  /** Сколько строк подошло под порог. */
  candidates: number
  /** Сколько реально стёрто в этот прогон. */
  reaped: number
  /** Упёрлись в потолок за прогон. */
  capped: boolean
  /** Сколько удалений не прошло (изолированы, прогон не падает). */
  failed: number
}

/**
 * Один прогон уборщика.
 *
 * @param days порог в днях (уже прошедший `resolveReapDays` — с полом и умолчанием).
 *
 * ⚠ Стираем ТЕМ ЖЕ `deletePortal`, что и штатное удаление. Своя «облегчённая» чистка означала бы
 * второй список того, что надо удалить, и он разошёлся бы с первым — а цена расхождения тут
 * наивысшая: недоудалённые банковские креды это ровно то, ради чего уборщик написан.
 *
 * ⚠ `eventTs` — СЕКУНДЫ текущего момента, как у события Б24. Тумбстоун пишет тот же
 * `deleteToken`, и метка «сейчас» верна: настоящая переустановка произойдёт ПОЗЖЕ, её событие
 * будет новее, и наш тумбстоун её не заблокирует.
 *
 * ⚠ Отказ удаления ОДНОГО портала изолирован: прогон продолжается, а сбой считается и попадает в
 * лог. Один битый портал не должен оставлять в базе остальных — это тот же принцип, что у
 * продления (#175).
 *
 * ⚠ Строка лога печатается ВСЕГДА, даже когда стирать нечего. Уборщик, который молчит, неотличим
 * от невзведённого, а узнать об этом хочется до проверки приватности, а не после.
 */
export async function runPortalReaper(deps: PortalReaperDeps, days: number): Promise<PortalReaperSummary> {
  const nowMs = deps.now()
  // Граница считается ЗДЕСЬ и передаётся в SQL готовой: база не должна знать про политику, а тест —
  // подсовывать в неё часы.
  const beforeMs = nowMs - days * 86_400_000
  const candidates = await deps.countRevoked(beforeMs)
  const ids = await deps.selectReapable(beforeMs, MAX_REAP_PER_RUN)
  const s: PortalReaperSummary = { candidates, reaped: 0, capped: candidates > ids.length, failed: 0 }
  const eventTs = Math.floor(nowMs / 1000)
  for (const row of ids) {
    const memberId = row.memberId
    // ⚠ ВТОРАЯ, независимая проверка тем же чистым правилом, что описывает политику. Без неё
    // правило жило бы только в SQL-условии выборки, а чистая функция была бы мёртвым кодом — то
    // есть двумя источниками одной истины, которые однажды разойдутся. Здесь цена расхождения
    // максимальна: удаление необратимо. Не сошлось — НЕ удаляем и говорим об этом громко.
    if (reapVerdict(row.revokedAtMs, nowMs, days) !== 'reap') {
      s.failed++
      deps.warn?.(`портал ${logSafeMember(memberId)} НЕ стёрт: выборка и правило разошлись (метка ${row.revokedAtMs}, порог ${days} дн.)`)
      continue
    }
    try {
      await deps.deletePortal(memberId, eventTs)
      s.reaped++
      // ⚠ Каждое удаление — отдельной ГРОМКОЙ строкой, а не только числом в итоге. Это
      // необратимое стирание чужих данных: если оно однажды сработает не на том портале, узнать,
      // на каком именно, надо будет из лога, и «стёрто 3» на этот вопрос не отвечает.
      deps.warn?.(`портал ${logSafeMember(memberId)} стёрт: грант мёртв дольше ${days} дн.`)
    } catch (e) {
      s.failed++
      deps.warn?.(`не удалось стереть портал ${logSafeMember(memberId)}: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  deps.log?.(reaperLogLine(s.candidates, s.reaped, s.capped, days))
  return s
}

/** `member_id` — hex-идентификатор от Б24; чистим и капим перед логом (эшелонированная защита). */
function logSafeMember(id: string): string {
  return id.replace(/[^\w.-]/g, '').slice(0, 64)
}
