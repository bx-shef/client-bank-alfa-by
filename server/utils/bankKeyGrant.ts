// Подписанный ГРАНТ на ввод ключа API (#19): чем экран `/bank-key` доказывает, что его открыл
// именно тот сотрудник, которому администратор передал подключение.
//
// ⚠ ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, А НЕ ПОЛЕ В `bankConnectState`. Там state описывает возврат ИЗ БАНКА и
// живёт минуты; здесь — право ввести ключ, живёт сутки и адресовано ЧЕЛОВЕКУ. Общий тип означал бы
// общий домен подписи, то есть значение одного назначения проверялось бы как значение другого:
// грант на сутки стал бы валидным `state` для колбэка. Разделение доменов — единственное, что это
// запрещает, поэтому у модуля СВОЙ тег, как у `bankConnectState` относительно сессионной куки.
//
// ⚠ ГРАНТ НЕ СЕКРЕТ И НЕ ДОСТАТОЧЕН САМ ПО СЕБЕ. Он едет в сообщении чата портала, то есть его
// видит и получатель, и любой, кому тот перешлёт. Поэтому сервер проверяет ТРИ вещи: подпись,
// совпадение портала с доменом фрейм-токена и совпадение `userId` с тем, кто реально открыл экран.
// Без фрейм-токена нужного сотрудника грант не даёт ничего.

import { createHmac } from 'node:crypto'
import { safeEqual } from '../../app/utils/b24Events'
import type { BankProviderId } from '../../app/types/statement'

export interface BankKeyGrant {
  /** Портал, которому принадлежит подключение (из НАШЕЙ базы, не от клиента). */
  memberId: string
  /** Какой банк подключаем — сейчас ключом API подключается только Альфа (#488). */
  provider: BankProviderId
  /** Кому выдан грант: id сотрудника портала из штатного диалога выбора. */
  userId: string
  /** Абсолютный срок, epoch ms. */
  exp: number
}

const b64url = (buf: Buffer | string): string =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** Свой тег домена подписи — см. шапку. Версию поднимать при смене формы тела. */
const DOMAIN_TAG = 'cba.bankkey.v1|'

function hmac(input: string, secret: string): string {
  return b64url(createHmac('sha256', secret).update(input).digest())
}

/** Подписать грант. Пустой секрет ⇒ `''` (fail-closed: проверка такое отвергнет). */
export function signKeyGrant(grant: BankKeyGrant, secret: string): string {
  if (!secret) return ''
  const body = b64url(JSON.stringify(grant))
  return `${body}.${hmac(DOMAIN_TAG + body, secret)}`
}

/**
 * Проверить грант: подпись (сравнение постоянного времени) и срок. Любая беда ⇒ `null`, никогда
 * не бросает — вызывающему нужен один ответ «годен/нет», а не разбор способа подделки.
 *
 * ⚠ Проверка ЛИЧНОСТИ (совпал ли `userId` с открывшим экран) здесь НЕ делается намеренно: она
 * требует похода в портал, то есть I/O, а этот модуль чистый. Её делает вызывающий — и без неё
 * грант не даёт ничего (см. шапку).
 */
export function verifyKeyGrant(value: string, secret: string, nowMs: number): BankKeyGrant | null {
  if (!secret) return null
  const raw = (value ?? '').trim()
  const dot = raw.indexOf('.')
  if (dot <= 0 || dot === raw.length - 1) return null
  const body = raw.slice(0, dot)
  const sig = raw.slice(dot + 1)
  if (!safeEqual(sig, hmac(DOMAIN_TAG + body, secret))) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const g = parsed as Record<string, unknown>
  const memberId = typeof g.memberId === 'string' ? g.memberId : ''
  const provider = typeof g.provider === 'string' ? g.provider as BankProviderId : null
  const userId = typeof g.userId === 'string' ? g.userId : ''
  const exp = typeof g.exp === 'number' ? g.exp : 0
  if (!memberId || !provider || !userId || !exp) return null
  if (exp <= nowMs) return null
  return { memberId, provider, userId, exp }
}
