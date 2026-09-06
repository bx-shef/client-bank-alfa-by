// «Последние операции» для главного экрана (#5/#36) — читаем элементы смарт-процесса «Платежи»
// (реестр #575) и разворачиваем их обратно в `StatementItem`, которым живёт `OperationList`.
//
// ⚠ ЗАЧЕМ. Список «Последние операции» на `/app` был жёстко пуст в портале (`app.vue`: реальный
// фид не был подключён), хотя реестр распределения в настройках уже показывал данные — у него свой
// endpoint. Источник для витрины уже есть: `paymentRegistryWrite` (#575) пишет КАЖДУЮ операцию в
// СП «Платежи» восемью полями (дата/направление/контрагент/счёт/УНП/назначение/наш счёт/банк).
// Здесь — обратный маппинг тех же полей. Чистый (без I/O), поэтому тестируется на голых объектах.
//
// ⚠ Это ВИТРИНА, а не источник истины: элемент СП мог быть отредактирован в CRM руками, поэтому
// маппер защитный — нет валидной суммы ⇒ строка пропускается (это не наш элемент реестра), а не
// показывается нулём.

import { PAYMENT_SP_FIELDS, buildUfFieldNameCamel, type SpRef } from '~/config/distributionSp'
import type { StatementItem, OperationDirection } from '~/types/statement'
import type { DayRange } from '~/utils/operationPeriod'
import { round2 } from '~/utils/money'

/**
 * `crm.item.list` для последних операций ЗА ПЕРИОД (#42), свежие сверху.
 *
 * ⚠ **Отбор по ДАТЕ ОПЕРАЦИИ** (`OP_DATE`), а не по времени создания элемента: ручная загрузка
 * старой выписки создаёт свежие элементы старых операций, и «за неделю» по времени создания
 * показало бы платежи годичной давности. Сортировка — по тому же полю, вторым ключом `id` убыв.:
 * у операций одного дня даты равны, а порядок ничьей PostgreSQL/портал не определяют, и без
 * второго ключа строки прыгали бы между запросами.
 * ⚠ Пустая граница — условие НЕ ставится вовсе (то же «без ограничения», что в очистке).
 * ⚠ Замерено на живом портале 2026-08-26: `>=`/`<=` по UF-полю типа `date` работают и включают
 * обе границы (`>=26.08` + `<=26.08` вернуло ровно операции 26 августа), сортировка по нему — тоже.
 * ⚠ Элементы, записанные ДО появления полей реестра (#575), несут пустой `OP_DATE` и под ЛЮБОЙ
 * фильтр не попадают. Это честно (даты у них нет), а заполняет их дозапись #45.
 *
 * ⚠ **`select: ['*']`, а НЕ перечисление наших полей (#41).** Прежде мы перечисляли РОВНО свои поля —
 * и на живом портале `crm.item.list` возвращал деньги (`TOTAL`/`CURRENCY`/`MARKER`), но НЕ поля
 * реестра #575 (контрагент/назначение/дата/направление). По документации `select` принимает имена
 * полей ИЛИ `'*'`, и именно `'*'` возвращает ВСЕ поля под их истинными camel-именами — что снимает
 * вопрос «попало ли поле в select». Плата — чуть больший ответ на 50 строк, приемлемо для витрины.
 * ⚠ Опускать `select` вовсе НЕЛЬЗЯ: без него метод не гарантирует возврат UF-полей — тогда пропали
 * бы и сумма/валюта.
 *
 * ⚠ Размер страницы НЕ задаём: у `crm.item.list` его нет как параметра — портал отдаёт фиксированную
 * страницу (50), а пагинацию мы не листаем. Поэтому длинный период может не поместиться, и витрина
 * обязана сказать об этом (`total` из ответа), а не показывать часть за целое.
 */
export function buildRecentOperationsListCall(
  paymentSp: SpRef,
  range: DayRange = { from: '', to: '' }
): { method: string, params: Record<string, unknown> } {
  const dateField = buildUfFieldNameCamel(paymentSp.id, PAYMENT_SP_FIELDS.operationDate.postfix)
  const filter: Record<string, unknown> = {}
  if (range.from) filter[`>=${dateField}`] = range.from
  if (range.to) filter[`<=${dateField}`] = range.to
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      select: ['*'],
      filter,
      order: { [dateField]: 'DESC', id: 'DESC' },
      start: 0
    }
  }
}

/** Наш `docId` из маркера операции (`<наш счёт>|<docId>`), если он не хеш-сигнатура пустого docId
 *  (`~sig:` — там документа нет вовсе). Пустая строка — маркер не той формы. */
function docIdFromMarker(marker: string): string {
  const i = marker.indexOf('|')
  if (i <= 0) return ''
  const tail = marker.slice(i + 1)
  return tail.startsWith('~sig:') ? '' : tail
}

/**
 * Развернуть один элемент СП «Платежи» в `StatementItem`. `null`, если у элемента нет валидной
 * суммы — значит это не строка нашего реестра (или её испортили руками), и в витрину она не идёт.
 *
 * ⚠ Направление: `'Расход'` → `debit`, всё остальное → `credit`. Значения пишем МЫ
 * (`DIRECTION_LABELS`), поэтому карта точная; асимметрия («иначе приход») безопасна, потому что
 * единственное другое наше значение — `'Приход'`, а неизвестное (ручная правка) в витрине лучше
 * показать приходом, чем потерять строку.
 * ⚠ Поле `bank` в реестре — это НАШ банк-провайдер (Альфа/Приор), а не банк контрагента, поэтому в
 * `counterparty.bank` оно НЕ кладётся: там банк плательщика, которого в реестре нет.
 */
export function paymentElementToStatementItem(item: Record<string, unknown>, paymentSp: SpRef): StatementItem | null {
  const uf = (postfix: string) => item[buildUfFieldNameCamel(paymentSp.id, postfix)]
  // ⚠ Сумма платежа всегда положительная (знак несёт направление, реестр так и пишет). Ноль/пусто/
  // мусор ⇒ это не строка нашего реестра (или её испортили руками) — строку в витрину не берём.
  // Тонкость: `Number(null)` и `Number('')` дают 0 (finite), поэтому проверяем именно `> 0`.
  const amount = Number(uf(PAYMENT_SP_FIELDS.total.postfix))
  if (!Number.isFinite(amount) || amount <= 0) return null

  const str = (postfix: string) => {
    const v = uf(postfix)
    return typeof v === 'string' ? v : (v == null ? '' : String(v))
  }
  const direction: OperationDirection = str(PAYMENT_SP_FIELDS.direction.postfix).trim() === 'Расход' ? 'debit' : 'credit'
  const marker = str(PAYMENT_SP_FIELDS.marker.postfix)
  // Дата операции — календарная часть (поле типа `date`; портал может отдать её с временем).
  const acceptDate = str(PAYMENT_SP_FIELDS.operationDate.postfix).slice(0, 10)

  return {
    account: str(PAYMENT_SP_FIELDS.ownAccount.postfix),
    docId: docIdFromMarker(marker),
    direction,
    amount: round2(amount),
    currency: str(PAYMENT_SP_FIELDS.currency.postfix),
    purpose: str(PAYMENT_SP_FIELDS.purpose.postfix),
    acceptDate,
    counterparty: {
      name: str(PAYMENT_SP_FIELDS.counterparty.postfix),
      unp: str(PAYMENT_SP_FIELDS.counterpartyUnp.postfix),
      account: str(PAYMENT_SP_FIELDS.counterpartyAccount.postfix)
    }
  }
}

/** Развернуть страницу `crm.item.list` (реестр «Платежи») в список операций для витрины. Битые/
 *  чужие элементы (без суммы) отбрасываются. */
export function mapRecentOperations(items: readonly Record<string, unknown>[], paymentSp: SpRef): StatementItem[] {
  const out: StatementItem[] = []
  for (const it of items) {
    const mapped = paymentElementToStatementItem(it, paymentSp)
    if (mapped) out.push(mapped)
  }
  return out
}
