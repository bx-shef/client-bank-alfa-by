// Владелец сохранённого токена портала — «человек, который всё установил».
//
// Приложение пишет в портал от имени того, чей токен у нас лежит, а лежит токен из события установки
// (`ONAPPINSTALL`) — то есть установившего (`PERMISSIONS.md`). Его id нужен в двух местах, и оба —
// запасные ответственные:
//  - системное дело (`crm.activity.add`, #722), когда у компании-владельца нет ответственного: там
//    поле обязательное;
//  - элементы смарт-процессов, когда портал не прислал служебного пользователя приложения
//    (решение владельца 2026-09-29: «там где нет такой поддержки — пусть будет везде человек,
//    который всё установил»).
//
// ⚠ Один кэш на оба пути и один вызов `profile` на портал на процесс: вторая копия кэша спросила бы
// портал второй раз о том же и однажды разошлась бы с первой.
//
// ⚠ Явный id, а не «не передадим — портал сам поставит того, от чьего имени запрос»: как портал
// заполняет ответственного элемента без этого поля, документация `crm.item.add` не говорит, а мы не
// замеряли. Правило владельца «везде установивший» не должно держаться на незамеренном умолчании.

import type { RestCall } from './companyLookup'
import { portalUserId } from '../../app/utils/activity'

const ownerByPortal = new Map<string, number>()

/**
 * id владельца сохранённого токена (`profile` → `ID`), один вызов на портал на процесс.
 *
 * ⚠ Отказ ПРОБРАСЫВАЕТСЯ, как и «портал не назвал id»: подставленная единица (id 1 есть не на каждом
 * портале) означала бы «свалить записи клиента на случайного человека», а честный повтор задачи
 * такого не делает. `purpose` — что именно не удалось заполнить: по тексту ошибки в логе должно быть
 * видно, какой путь записи споткнулся.
 */
export async function tokenOwnerId(call: RestCall, memberId: string | undefined, purpose: string): Promise<number> {
  const cached = memberId ? ownerByPortal.get(memberId) : undefined
  if (cached) return cached
  const resp = await call('profile', {})
  const result = (resp as Record<string, unknown>)?.result
  const raw = result && typeof result === 'object' ? (result as Record<string, unknown>).ID : undefined
  const id = portalUserId(raw)
  if (id === null) throw new Error(`portal profile returned no usable ID — cannot set ${purpose}`)
  if (memberId) ownerByPortal.set(memberId, id)
  return id
}

/**
 * Забыть владельца токена портала — при переустановке и удалении приложения.
 *
 * ⚠ Без этого переустановка ДРУГИМ администратором оставляла бы до перезапуска процесса прежнего
 * установившего ответственным за новые записи: токен у нас уже новый, а кэш помнит старого.
 */
export function forgetTokenOwner(memberId: string): void {
  ownerByPortal.delete(memberId)
}

/** Для тестов: модульный кэш иначе протекает между случаями. */
export function resetTokenOwnerCache(): void {
  ownerByPortal.clear()
}
