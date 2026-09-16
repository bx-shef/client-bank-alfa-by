// Прогон автоудаления дел по всему флоту (#722) — сшивка чистого правила с базой и порталами.
//
// ⚠ ОПТИМАЛЬНОСТЬ ЗДЕСЬ — ЭТО «СКОЛЬКО ВЫЗОВОВ В ЧУЖОЙ ПОРТАЛ», а не «сколько строк кода». Порядок
// выбран так, чтобы портал, которому автоудаление не нужно, стоил РОВНО ОДНОГО вызова, а портал,
// который никогда ничего не импортировал, — НИ ОДНОГО:
//   1. кандидаты берутся из НАШЕЙ базы (след импорта), а не из списка всех порталов — у портала
//      без импорта наших дел не существует в принципе, и спрашивать его не о чем;
//   2. первым делом читается настройка (`app.option`) — выключено ⇒ выходим, один вызов;
//   3. и только у согласившихся идёт список дел и удаление.
//
// ⚠ ЧИТАТЬ НАСТРОЙКУ ИЗ `app.option`, А НЕ ХРАНИТЬ ФЛАГ У СЕБЯ — решение, а не умолчание. У паузы
// опроса (#576) флаг лежит в нашей базе, и там это верно: её читает планировщик КАЖДЫЕ ПЯТЬ МИНУТ,
// то есть хранение в портале стоило бы REST на портал на тик. Здесь прогон РАЗ В СУТКИ, цена —
// один вызов на портал в день, а взамен настройка живёт там же, где все остальные, и сохраняется
// той же кнопкой. Второе хранилище означало бы второй ответ на вопрос «включено ли», и они
// разъехались бы молча.
//
// ⚠ НЕ СМОГЛИ ПРОЧИТАТЬ НАСТРОЙКУ ⇒ НЕ УДАЛЯЕМ. Единственный безопасный исход: «портал не ответил»
// и «портал разрешил» обязаны различаться, иначе мёртвый токен или кончившаяся подписка (#614)
// читались бы как согласие на необратимое действие.

import {
  autoEraseCutoff,
  autoEraseLogLine,
  MAX_AUTO_ERASE_PORTALS,
  type AutoEraseCutoff,
  type AutoEraseFacts,
  type AutoErasePortalResult
} from '../../app/utils/autoEraseActivities'
import { portalHash } from './telemetryAttributes'

/** Что портал отвечает про настройку. `unknown` — НЕ синоним «выключено», см. шапку. */
export type AutoEraseVerdict = 'on' | 'off' | 'unknown'

/** Инъектируемые side-effects — правило тестируется без базы и без портала. */
export interface AutoEraseDeps {
  now: () => number
  /**
   * Порталы-кандидаты: те, у кого есть след импорта (значит, могли появиться наши дела).
   * Порядок обязан быть стабильным — остаток берётся следующим прогоном.
   */
  listCandidates: () => Promise<string[]>
  /** Включено ли автоудаление у портала. Бросок трактуется как `unknown` вызывающим. */
  isEnabled: (memberId: string) => Promise<AutoEraseVerdict>
  /** Удалить у портала дела старше границы. */
  erase: (memberId: string, cutoff: AutoEraseCutoff) => Promise<AutoErasePortalResult>
  log?: (msg: string) => void
  warn?: (msg: string) => void
}

/**
 * Один прогон по флоту.
 *
 * @param lookbackDays окно опроса (`CRON_LOOKBACK_DAYS`) — из него выводится порог.
 *
 * ⚠ Предохранителя «по доле флота», как у уборщиков #574/#599/#614, здесь НЕТ, и это осознанно.
 * Там сигнал наш (регулярка по тексту, оценка возраста токена), и массовое срабатывание означало
 * бы нашу поломку. Здесь сигнал — ЯВНАЯ галка клиента в его собственных настройках, а объём
 * удаления ограничен самим смыслом отбора («наши дела старше N суток»): доля согласившихся
 * порталов ничего не говорит о правильности. От НАШЕЙ ошибки защищает другое — перепроверка
 * возраста по ответу портала (`selectAutoErasable`), то есть граница стоит на каждой строке, а не
 * на статистике.
 */
export async function runAutoErase(deps: AutoEraseDeps, lookbackDays: number): Promise<AutoEraseFacts> {
  const cutoff = autoEraseCutoff(deps.now(), lookbackDays)
  const f: AutoEraseFacts = {
    considered: 0, enabled: 0, unreadable: 0, touched: 0,
    deleted: 0, withRemainder: 0, failed: 0, capped: false,
    thresholdDays: cutoff.thresholdDays
  }

  const candidates = await deps.listCandidates()
  f.considered = candidates.length
  if (candidates.length > MAX_AUTO_ERASE_PORTALS) f.capped = true

  for (const memberId of candidates.slice(0, MAX_AUTO_ERASE_PORTALS)) {
    let verdict: AutoEraseVerdict
    try {
      verdict = await deps.isEnabled(memberId)
    } catch {
      verdict = 'unknown'
    }
    if (verdict === 'unknown') {
      // ⚠ Тихо считаем, но НЕ предупреждаем поштучно: нечитаемая настройка — штатное состояние
      // портала с кончившейся подпиской или удалённым приложением, и строка на каждый такой
      // портал каждые сутки забила бы лог тем, что не требует действия. Число — в итоге.
      f.unreadable++
      continue
    }
    if (verdict === 'off') continue
    f.enabled++

    try {
      const res = await deps.erase(memberId, cutoff)
      f.deleted += res.deleted
      if (res.deleted > 0) {
        f.touched++
        // ⚠ Отдельная строка на портал, у которого что-то удалили. Как и у автоотключения банка
        // (#614): мы необратимо убираем данные клиента без участия человека, и вопрос «у кого
        // именно» встанет позже, когда клиент придёт с вопросом. «Удалено 120» на него не отвечает.
        // Портал назван необратимой меткой — тот же ключ корреляции, что в телеметрии (`PRIVACY.md`).
        deps.log?.(`портал ${portalHash(memberId)}: удалено дел ${res.deleted}`
          + (res.remaining > 0 ? `, осталось ${res.remaining} на следующий прогон` : ''))
      }
      if (res.remaining > 0) f.withRemainder++
    } catch (e) {
      f.failed++
      deps.warn?.(`не удалось удалить дела у портала ${portalHash(memberId)}: ${(e as Error)?.message ?? String(e)}`)
    }
  }

  deps.log?.(autoEraseLogLine(f))
  return f
}
