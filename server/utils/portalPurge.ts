// Полное стирание данных портала — ОДИН список на все пути (#654).
//
// ⚠ ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Список хранилищ существовал в двух экземплярах, и они разошлись:
// путь через очередь (`worker.ts`) стирал семь таблиц, а аварийный путь приёма `ONAPPUNINSTALL`
// (`server/api/b24/events.post.ts`, работает когда Redis недоступен) — ОДНУ, `portal_tokens`.
// Комментарий рядом с аварийной веткой при этом обещал обратное: «this sync fallback is the only
// chance to purge when Redis is down».
//
// Цена расхождения несимметрична и не убывает со временем: недостиранными оставались БАНКОВСКИЕ
// КРЕДЫ, а `bankTokenKeepAlive` намеренно вынесен из-под гейта Redis (#489) и продолжал их
// обновлять каждый час — бессрочно. Ни один уборщик до них не дотягивался: #574 выбирает
// кандидатов из `portal_tokens` (строки уже нет), #599 хоронит по возрасту токена (токен свежий,
// его же и продлевают). То есть приложение удалено, портала у нас нет, а доступ к счёту клиента
// лежит и поддерживается живым.
//
// ⚠ Поэтому список ЗДЕСЬ, а не «аккуратно продублирован»: следующее хранилище припишут к одному
// из двух списков, и разойдётся снова. Инвариант стережёт `tests/portalPurge.test.ts`.

import type { QueryFn } from './tokenStore'
import { deleteBankTokensForPortal } from './bankTokenStore'
import { deleteToken } from './tokenStore'
import { deleteImportResultForPortal } from './importResultStore'
import { deleteBatchesForPortal } from './importBatchStore'
import { deleteMetricsForPortal } from './metricsStore'
import { deleteRatingForPortal } from './appRatingStore'
import { deleteLeasesForPortal } from './singleFlightLease'

/**
 * Почему стираем. Различает их только вызывающий, и различать обязательно: сюда ходит и штатное
 * удаление приложения, и уборщик мёртвых грантов (#574), у которого клиент ничего не удалял.
 */
export type PortalPurgeReason = 'uninstall' | 'grant-dead'

/** Стирающие функции хранилищ — инъекцией, чтобы порядок проверялся тестом без базы. */
export interface PortalPurgeDeps {
  deleteBankTokensForPortal: (q: QueryFn, memberId: string) => Promise<unknown>
  deleteToken: (q: QueryFn, memberId: string, eventTs: number) => Promise<unknown>
  deleteImportResultForPortal: (q: QueryFn, memberId: string) => Promise<unknown>
  deleteBatchesForPortal: (q: QueryFn, memberId: string) => Promise<unknown>
  deleteMetricsForPortal: (q: QueryFn, memberId: string) => Promise<unknown>
  deleteRatingForPortal: (q: QueryFn, memberId: string) => Promise<unknown>
  deleteLeasesForPortal: (q: QueryFn, memberId: string) => Promise<unknown>
}

/** Человеческая причина для журнала — одна формулировка на оба пути. */
export function portalPurgeReasonText(reason: PortalPurgeReason): string {
  return reason === 'uninstall'
    ? 'приложение удалено из портала (ONAPPUNINSTALL)'
    : 'грант портала мёртв, портал исчез без уведомления (#574)'
}

/**
 * Стереть ВСЁ, что мы держим о портале.
 *
 * ⚠ БАНКОВСКИЕ КРЕДЫ — ПЕРВЫМИ, и порядок несущий (#574). Шагов семь, транзакции нет, и при отказе
 * на середине удалённое остаётся удалённым, а прочее — на месте. Стой `deleteToken` первым, портал
 * после частичного отказа никогда бы не попал в выборку уборщика (тот читает `portal_tokens`), а
 * до банковских строк не дотянулся бы никто — утечка стала бы НЕУСТРАНИМОЙ тем самым инструментом,
 * который её и должен закрывать.
 */
export async function purgePortalStorage(
  q: QueryFn,
  memberId: string,
  eventTs: number,
  deps: PortalPurgeDeps
): Promise<void> {
  await deps.deleteBankTokensForPortal(q, memberId) // креды банка — удалённое приложение не держит ни одного
  await deps.deleteToken(q, memberId, eventTs)
  await deps.deleteImportResultForPortal(q, memberId)
  await deps.deleteBatchesForPortal(q, memberId)
  await deps.deleteMetricsForPortal(q, memberId)
  await deps.deleteRatingForPortal(q, memberId) // состояние «оцените приложение» — рядом с авторизацией
  // ⚠ Аренда single-flight (#538) сама не исчезнет: свипа у неё нет, а рассуждение «просроченную
  // перезапишет следующий захват» держится на том, что захват когда-нибудь будет. У удалённого
  // портала его не будет никогда, и строка с его member_id жила бы в базе и бэкапах вечно.
  await deps.deleteLeasesForPortal(q, memberId)
}

/**
 * Боевая проводка — ОДНА на все пути стирания.
 *
 * ⚠ Экспортируется готовым объектом, а не собирается у каждого вызывающего: собери его на месте, и
 * список снова окажется в двух экземплярах, только теперь в виде двух литералов. Вся суть модуля в
 * том, что забыть хранилище негде.
 */
export const LIVE_PORTAL_PURGE_DEPS: PortalPurgeDeps = {
  deleteBankTokensForPortal,
  deleteToken,
  deleteImportResultForPortal,
  deleteBatchesForPortal,
  deleteMetricsForPortal,
  deleteRatingForPortal,
  deleteLeasesForPortal
}
