import { onScopeDispose, ref } from 'vue'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'

// Manual «Опросить сейчас» (#54): trigger an on-demand bank poll of the portal's connected accounts
// from the in-portal admin UI. POSTs to /api/poll-now with the FRAME token (Bearer + X-B24-Domain) —
// the backend gates on the feature flag + admin + a per-portal cooldown, then enqueues the fetch
// jobs. Outside a portal frame there is no token → inert. Frame-auth helpers are shared (useFrameAuth),
// same as useBankConnect. UI показывает ответ сервера (кулдаун / поставлено N), а не прячет кнопку.

export interface PollNowResponse {
  enqueued?: number
  accounts?: number
  cooldownSec?: number
  /** День, за который ушла задача (эхо запроса) — интерфейс подтверждает выбор человеку. */
  day?: string
  /** Банк и счёт, по которым ушла задача (эхо запроса, #19) — без них «опрос запущен» не говорит,
   *  ЧТО именно опрошено, а на портале с двумя банками это и есть весь вопрос. */
  provider?: string
  accountKey?: string
  error?: string
}

/** Сколько ждём появления итога прогона и как часто спрашиваем. */
// ⚠ Окно и шаг подобраны под ЦЕНУ запроса, а не под нетерпение: `/api/import/status` проверяет
// фрейм-токен вызовом `profile` в портал клиента, то есть каждый наш опрос тратит его же лимит
// (2 запроса в секунду на портал), деля его с идущим `crm-sync`. 80 с по 8 с — это десять
// проверок вместо тридцати.
const OUTCOME_TIMEOUT_MS = 80_000
// ⚠ Шаг 5 с, а не 3: зона nginx `import` даёт 20 запросов в минуту на IP, то есть ровно один в
// три секунды, и опрос с таким шагом съедал бы её целиком — соседний бухгалтер из того же офиса
// получал бы 429 на экране готовности.
const OUTCOME_STEP_MS = 8_000

export function useManualPoll() {
  const polling = ref(false)
  /** Итог ИМЕННО этого забора: null — ещё не дождались или ждать нечего. */
  const outcome = ref<string>('')
  const waiting = ref(false)
  /** Номер текущего ожидания: старые циклы себя опознают и молчат. */
  let runSeq = 0
  // ⚠ Уход со страницы обрывает ожидание: иначе закрытый слайдер настроек продолжал бы 90 секунд
  // спрашивать сервер и писать в состояние мёртвого компонента.
  onScopeDispose(() => {
    runSeq++
  })
  const error = ref('')
  const message = ref('')
  /** True only in the in-portal frame (a token exists). Resolve on mount via syncEnabled(). */
  const enabled = ref(false)

  function syncEnabled(): void {
    enabled.value = frameAuth() !== null
  }

  /** Trigger the poll. `day` (`ГГГГ-ММ-ДД`) — точечный забор за один день (#592); пусто ⇒ обычное
   *  скользящее окно. Sets `message` on success, `error` on any failure. */
  async function poll(day = '', target?: { provider: string, accountKey: string }): Promise<void> {
    const a = frameAuth()
    enabled.value = a !== null
    error.value = ''
    message.value = ''
    if (!a) {
      error.value = 'Опрос доступен только внутри портала Bitrix24'
      return
    }
    polling.value = true
    outcome.value = ''
    // Метка последнего прогона ДО запуска — по её смене узнаём СВОЙ исход.
    // ⚠ Сравниваем отметку ОБРАЩЕНИЯ К БАНКУ (`lastFetchAt`), а не сводку прогона: прогон бывает
    // только когда операции есть, и пустой забор по ней неотличим от «ничего не произошло».
    // ⚠ Не прочитали базовую отметку — ждать НЕЛЬЗЯ: без неё любое существующее значение сойдёт за
    // наш исход, и человеку покажут чужой прогон («пришло 40 операций») как итог его нажатия.
    let before: string | null = null
    let baseKnown = false
    try {
      const prev = await $fetch<{ lastFetchAt?: string | null }>('/api/import/status', { headers: authHeaders(a) })
      before = prev?.lastFetchAt ?? null
      baseKnown = true
    } catch { /* базовой отметки нет — исход показывать не будем, см. ниже */ }
    try {
      const res = await $fetch<PollNowResponse>('/api/poll-now', {
        method: 'POST',
        headers: authHeaders(a),
        body: { ...(day ? { day } : {}), ...(target ?? {}) }
      })
      const n = res?.enqueued ?? 0
      const forDay = res?.day ? ` за ${res.day}` : ''
      // ⚠ Адресный забор называет СЧЁТ (#19): «опрос запущен: счетов — 1» не отвечает на вопрос
      // «а какой именно», а на портале с двумя банками это и есть весь вопрос.
      const forAccount = res?.accountKey ? ` по счёту ${res.accountKey}` : ''
      message.value = n > 0
        ? (forAccount
            ? `Опрос запущен${forDay}${forAccount}. Операции появятся в CRM через минуту-другую.`
            : `Опрос запущен${forDay}: счетов — ${res?.accounts ?? n}. Операции появятся в CRM через минуту-другую.`)
        : 'Опрос запущен, но подключённых счетов нет — сначала подключите счёт.'
      // ⚠ Исход показываем ТОЛЬКО когда счёт один. Отметка обращения к банку одна на портал, а
      // задача ставится НА КАЖДЫЙ счёт: при двух счетах пустой ответ по первому пришёл бы раньше
      // и был бы предъявлен как исход — «операций нет» о заборе, который по второму счёту принёс
      // сорок. Соврать про деньги хуже, чем промолчать; при нескольких счетах отправляем в
      // «Последние операции», где виден настоящий результат.
      if (n > 0 && baseKnown && (res?.accounts ?? n) === 1) void awaitOutcome(a, before, day)
    } catch (e) {
      // Map the backend's typed rejections to friendly copy; fall back to the generic message.
      const status = (e as { statusCode?: number, status?: number })?.statusCode ?? (e as { status?: number })?.status
      // ⚠ 400 несёт ОСМЫСЛЕННЫЙ текст (день в будущем, кривая дата) — его и показываем, иначе
      // человек видел бы «не удалось запустить опрос» про собственную опечатку в календаре.
      const said = (e as { data?: { error?: unknown } })?.data?.error
      if (status === 400 && typeof said === 'string' && said) error.value = said
      else if (status === 429) error.value = 'Слишком часто — подождите немного и повторите.'
      // ⚠ 503 больше не значит «функция выключена» (свой выключатель снят 2026-08-23) — он значит
      // «очередь недоступна», то есть сбой на нашей стороне, и текст обязан вести к действию.
      // ⚠ 503 приходит при недоступных очередях, а это и «Redis лёг» (пройдёт само), и «Redis не
      // настроен на этом контуре» (не пройдёт никогда). Текст должен быть верен в обоих: обещание
      // «повторите через пару минут» во втором случае отправляет админа ждать вечно.
      else if (status === 503) error.value = 'Обработка сейчас недоступна. Если повторяется — сообщите администратору сервиса.'
      else if (status === 403) error.value = 'Опрос может запустить только администратор портала.'
      // Адресный забор (#19): счёт исчез между отрисовкой и кликом либо не опрашивается.
      else if (status === 404) error.value = 'Подключение не найдено — обновите страницу.'
      else if (status === 409 && typeof said === 'string' && said) error.value = said
      else error.value = frameFetchError(e, 'Не удалось запустить опрос')
    } finally {
      polling.value = false
    }
  }

  /**
   * Дождаться итога запущенного прогона и рассказать о нём.
   *
   * ⚠ Без этого кнопка отвечала «опрос запущен» и ЗАМОЛКАЛА навсегда: исход был виден только в
   * логах сервера, то есть человеку в портале — никак. Именно поэтому забор за день нельзя было
   * ни принять, ни опровергнуть.
   *
   * ⚠ Сравниваем с меткой ДО запуска, а не просто «есть ли результат»: у портала он почти всегда
   * уже есть от планового опроса, и без базовой метки мы показали бы чужой прогон как свой.
   *
   * ⚠ Не дождались — говорим именно это, а не «операций нет»: прогон может идти дольше окна
   * (очередь занята, банк думает), и выдать ожидание за пустой ответ значит соврать.
   */
  async function awaitOutcome(a: ReturnType<typeof frameAuth>, before: string | null, day: string): Promise<void> {
    if (!a) return
    // ⚠ Токен последовательности: повторное нажатие делает предыдущий цикл неактуальным. Без него
    // два цикла писали бы в один и тот же `outcome`, и первый завершившийся гасил бы спиннер
    // второго — с чужим днём в тексте.
    const seq = ++runSeq
    waiting.value = true
    const deadline = Date.now() + OUTCOME_TIMEOUT_MS
    try {
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, OUTCOME_STEP_MS))
        if (seq !== runSeq) return // человек нажал снова — этот цикл больше не про текущий забор
        let run: { lastFetchAt?: string | null, lastFetchOps?: number, activitiesCreated?: number } | null = null
        try {
          run = await $fetch('/api/import/status', { headers: authHeaders(a) })
        } catch {
          continue // транзиентный сбой чтения статуса — не повод объявлять исход
        }
        const stamp = run?.lastFetchAt ?? null
        if (!stamp || stamp === before) continue
        const ops = run?.lastFetchOps ?? 0
        outcome.value = ops === 0
          ? `Банк ответил: операций${day ? ` за ${day}` : ''} нет.`
          : `Банк отдал операций: ${ops}. Записанные в CRM — в «Последних операциях».`
        return
      }
      if (seq === runSeq) {
        outcome.value = 'Ответа пока нет — обработка ещё идёт. Загляните в «Последние операции» через минуту.'
      }
    } finally {
      if (seq === runSeq) waiting.value = false
    }
  }

  return { poll, syncEnabled, polling, error, message, enabled, outcome, waiting }
}
