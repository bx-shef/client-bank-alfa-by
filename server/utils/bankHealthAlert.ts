// Умирающие банковские подключения — В ТОТ ЖЕ КАНАЛ, ЧТО И ПОЛОМКИ КОНВЕЙЕРА (#497 §3).
//
// ЗАЧЕМ ЭТОТ ФАЙЛ ВООБЩЕ ЕСТЬ. Карточка на `/queues` показывает состояние подключений — но её надо
// ОТКРЫТЬ, а ночью её никто не открывает. Refresh Альфы живёт ~10 часов и умирает под утро (#488),
// то есть ровно тогда, когда на экран никто не смотрит; к моменту, когда кто-то посмотрит, клиент
// уже позвонил сам. Пул-дашборд не может закрыть критерий «МЫ видим его проблемы» — его закрывает
// только канал, который стучится сам. Такой канал в проекте один (Telegram, `queueAlertDeliver.ts`),
// и правильный ход — доложить в него, а не заводить второй.
//
// ЧТО СЧИТАЕТСЯ ПОВОДОМ. Только состояния, которые чинит ЧЕЛОВЕК: `expired` и `no-refresh`. `due` —
// это «мы уже обновляем сами», `unknown` — «срок неизвестен», `pending` — «админ не дописал
// настройку». Разбудить оператора ради любого из них значит научить его не читать канал.
//
// ⚠ ЭПИЗОД — НА ПРОВАЙДЕРА, а не один на всё. Хронически мёртвая Альфа иначе маскировала бы
// свежую поломку Приора: эпизод уже объявлен, и «не повторяться» замолчало бы новую проблему.
//
// ⚠ В СООБЩЕНИЕ НЕ ИДУТ НИ МЕТКИ ПОРТАЛОВ, НИ ДОМЕНЫ — только числа и название банка. Экран
// `/queues` за нашей сессией может показать метки, Telegram — внешний сервис, и отправленное туда
// уже не отозвать. Числа отвечают на вопрос «идти ли смотреть», а смотреть идут на экран.

import type { BankProviderId } from '../../app/types/statement'
import { BANK_LABELS } from '../../app/utils/bankLabels'
import { connectionHealth } from '../../app/utils/bankTokenLifetime'
import { isPendingAccountKey } from '../../app/utils/bankAccountKey'
import { pluralRu } from '../../app/utils/importStatus'
import type { BankHealthRow } from '../../app/utils/bankHealthOverview'
import { pulseAgeMs, pulseState, type KeepAlivePulse } from '../../app/utils/keepAlivePulse'
import type { QueueAlert } from './queueAlert'

/** Состояния, которые не рассосутся сами: их чинит владелец счёта, зайдя в интернет-банк. */
const NEEDS_HUMAN = new Set(['expired', 'no-refresh'])

/**
 * Свернуть строки подключений в тревоги для пуш-канала.
 *
 * Возвращает `QueueAlert`, потому что доставку (один раз на эпизод, пол на переобъявление,
 * «объявлено» = реально доставлено) уже умеет `planAlertDelivery`, и заводить второй такой
 * механизм — значит завести второй набор его ошибок.
 */
export function evaluateBankHealth(rows: readonly BankHealthRow[], nowMs: number): QueueAlert[] {
  const byProvider = new Map<BankProviderId, { connections: number, portals: Set<string> }>()

  for (const row of rows) {
    // Незавершённая настройка — не поломка: у банка нет такого «номера», опрашивать нечего, и
    // будить по ней некого. Она видна на экране готовности у самого админа.
    if (isPendingAccountKey(row.accountKey)) continue
    if (!NEEDS_HUMAN.has(connectionHealth(row, nowMs))) continue
    const acc = byProvider.get(row.provider) ?? { connections: 0, portals: new Set<string>() }
    acc.connections += 1
    acc.portals.add(row.memberId)
    byProvider.set(row.provider, acc)
  }

  const out: QueueAlert[] = []
  // Порядок фиксирован сортировкой: иначе две одинаковые по смыслу проверки давали бы сообщения в
  // разном порядке, а в тесте — плавающее ожидание.
  for (const provider of [...byProvider.keys()].sort()) {
    const { connections, portals } = byProvider.get(provider)!
    const bank = BANK_LABELS[provider] ?? provider
    out.push({
      kind: 'bank-dead',
      queue: provider,
      text: `${bank}: ${connections} ${pluralRu(connections, ['подключение не работает', 'подключения не работают', 'подключений не работают'])} на ${portals.size} ${pluralRu(portals.size, ['портале', 'порталах', 'порталах'])} — импорт у них стоит, владельцу счёта нужно заново войти в интернет-банк`
    })
  }
  return out
}

/**
 * Dead man's switch продления токенов (#504): механизм не подаёт признаков жизни.
 *
 * ⚠ Это ДРУГОЙ диагноз, чем «подключения мертвы» выше, и потому отдельный эпизод. Там банк нас
 * отверг — чинит владелец счёта, зайдя в интернет-банк. Здесь встала НАША машинерия — чиним мы, и
 * подключения ещё живы, но начнут умирать через полосу обновления. Слить их в один эпизод значило
 * бы отправить оператора не туда.
 *
 * ⚠ `never` тревогой НЕ считается: сразу после старта процесса прогонов ещё не было, и это норма.
 * Отличить «только запустились» от «таймер не завёлся вовсе» по одному этому значению нельзя —
 * судить надо по возрасту процесса, а такого знания у чистой функции нет. Первый же прогон
 * (он идёт при старте, `void runBankKeepAliveTick()`) снимает неопределённость.
 */
export function evaluateKeepAlivePulse(
  pulse: KeepAlivePulse | null,
  nowMs: number,
  intervalMs: number
): QueueAlert[] {
  if (pulseState(pulse, nowMs, intervalMs) !== 'stale') return []
  const age = pulseAgeMs(pulse, nowMs) ?? 0
  const hours = Math.max(1, Math.round(age / 3_600_000))
  return [{
    kind: 'keepalive-stale',
    queue: 'bank-keepalive',
    text: `продление банковских токенов не отрабатывало ${hours} ${pluralRu(hours, ['час', 'часа', 'часов'])} — подключения клиентов начнут умирать, чинить нам (это НЕ отказ банка)`
  }]
}
