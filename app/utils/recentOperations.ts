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
import { round2 } from '~/utils/money'

/**
 * `crm.item.list` для последних операций: сорт по `id` убыв. (свежие сверху), первая страница.
 *
 * ⚠ **`select: ['*']`, а НЕ перечисление наших полей (#41).** Прежде мы перечисляли РОВНО свои поля —
 * и на живом портале `crm.item.list` возвращал доденьги (`TOTAL`/`CURRENCY`/`MARKER`), но НЕ поля
 * реестра #575 (контрагент/назначение/дата/направление), хотя на карточке элемента они заполнены
 * (её рисует `crm.item.get`, отдающий все поля). ⚠ ПОЧЕМУ именно эти поля терялись — точно НЕ
 * установлено: `TOTAL`/`CURRENCY`/`MARKER` тоже пользовательские (UF), поэтому «select не отдавал
 * UF» объяснением быть не может; вероятнее рассинхрон camel-имени конкретных полей. По документации
 * `select` принимает имена полей ИЛИ `'*'`, и именно `'*'` возвращает ВСЕ поля (включая множественные
 * и UF) под их ИСТИННЫМИ camel-именами — что снимает вопрос «попало ли поле в select». Маппер
 * разбирает нужные поля по именам; если рассинхрон в camel-имени остаётся, keys-only лог в
 * `operations.get.ts` покажет истинные ключи, и правим уже их. Плата — чуть больший ответ на 50
 * строк, приемлемо для витрины.
 * ⚠ Опускать `select` вовсе НЕЛЬЗЯ: без него метод не гарантирует возврат UF-полей (документация
 * оговаривает `'*'` отдельно) — тогда пропали бы и сумма/валюта.
 *
 * ⚠ Размер страницы НЕ задаём: у `crm.item.list` его нет как параметра — портал отдаёт фиксированную
 * страницу (50), а пагинацию мы не листаем (нужны только последние).
 * ⚠ `id DESC` — это «последние ИМПОРТИРОВАННЫЕ», а не «последние по дате операции»: ручная загрузка
 * старой выписки поставит свежесозданные элементы старых операций сверху. `OperationList` группирует
 * по дню, так что для витрины это приемлемо; знать про компромисс стоит.
 */
export function buildRecentOperationsListCall(paymentSp: SpRef): { method: string, params: Record<string, unknown> } {
  return {
    method: 'crm.item.list',
    params: {
      entityTypeId: paymentSp.entityTypeId,
      select: ['*'],
      order: { id: 'DESC' },
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
