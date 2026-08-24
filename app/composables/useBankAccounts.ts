import { ref } from 'vue'
import type { BankProviderId } from '~/types/statement'
import { frameAuth, frameAuthHeaders as authHeaders, frameFetchError } from '~/composables/useFrameAuth'
import { addAccountErrorMessage } from '~/utils/addAccountError'
import { setAccountErrorMessage } from '~/utils/setAccountError'
import { disconnectErrorMessage } from '~/utils/disconnectError'
import { pausePollErrorMessage } from '~/utils/pausePollError'

// Connected bank accounts for the settings UI (#404): read the list and disconnect one. Both hit
// admin-gated frame-token routes (/api/bank/accounts, /api/bank/disconnect) — same auth model as
// useBankConnect, and inert outside the portal frame (no token ⇒ nothing to show).
//
// The payload carries identity + freshness only; token material never reaches the browser.

export interface ConnectedBankAccount {
  /**
   * Неизменяемый адрес подключения (#517). Им адресуется «Отключить»: `accountKey` МЕНЯЕТСЯ, когда
   * подключению назначают счёт, и удаление по нему промахивалось мимо строки, отвечая успехом.
   */
  id: number
  provider: BankProviderId
  accountKey: string
  /** Epoch ms of the last successful connect/refresh. */
  connectedAt: number
  /** Epoch ms the stored access token expires at. */
  expiresAt: number
  /** False ⇒ no refresh token stored ⇒ the account must be re-connected once access expires. */
  hasRefresh: boolean
  /**
   * Epoch ms, когда истекает СОГЛАСИЕ банка (#503). `0`/отсутствует — банк согласий не выдаёт
   * (Альфа) или подключение сделано до появления поля: тогда о согласии не говорим ничего.
   *
   * ⚠ Другие часы, чем у токена: когда согласие вышло, продлевать нечего — нужен вход владельца
   * счёта в интернет-банк, а это не то, что организуют за вечер.
   */
  consentExpiresAt?: number
  /**
   * Автоопрос этого подключения приостановлен (#576).
   *
   * ⚠ Не «отключено». Грант жив, токен продлевается — приложение просто не ходит за выпиской.
   * Отсутствует ⇒ `false`: подключение, заведённое до появления паузы, опрашивается как обычно.
   */
  pollPaused?: boolean
  /**
   * Грант банка — одно прохождение OAuth, общее для счетов одного согласия (#23).
   *
   * ⚠ `''`/отсутствует означает «не размечено» (подключение заведено до поддержки нескольких
   * счетов), а НЕ «общий грант»: по такому подключению добавить счёт нельзя, потому что делить
   * нечего — копия токенов дала бы вторую строку с парой, которую банк ротирует.
   */
  grantId?: string
}

/**
 * Синтетические подключения для `?preview=1` — разработка без портала и ВИЗУАЛЬНЫЕ ЭТАЛОНЫ (#3).
 *
 * ⚠ Заведено потому, что вне портала список ВСЕГДА пуст (нет фрейм-токена), а значит ни один
 * скриншот и ни один визуальный эталон не показывали строку подключения ВООБЩЕ. Всё, что живёт в
 * строке — бейджи состояния, выбор счёта, пауза, подтверждение отключения, — не было прикрыто
 * визуальной регрессией ни разу; проверить своё изменение глазами было негде.
 *
 * ⚠ Случай намеренно ИНТЕРЕСНЫЙ: рабочее подключение, приостановленное и незавершённое. Список,
 * снятый в состоянии «одна обычная строка», не документирует ничего из того, ради чего он сделан.
 *
 * ⚠ Данные СИНТЕТИЧЕСКИЕ и обязаны такими остаться: они попадают и в коммитимые эталоны, и в
 * публичный JS-чанк, то есть настоящий номер счёта здесь — это публикация реквизитов.
 *
 * ⚠ Метки времени НУЛЕВЫЕ намеренно, и «починить» их нельзя. Состояние подключения считается по
 * ВОЗРАСТУ пары (`connectionHealth(a, Date.now())`), поэтому любая фиксированная дата рано или
 * поздно всё равно станет «истекло», а дата, вычисленная от `Date.now()`, сделала бы снимок
 * НЕДЕТЕРМИНИРОВАННЫМ — строка «подключён N назад» менялась бы каждый день, и визуальная джоба
 * краснела бы вечно и не по делу. Отсюда первый ряд с бейджем «подключение истекло»: это не
 * недосмотр, а цена детерминированности. Показанные состояния при этом честные — истёкшее,
 * приостановленное и незавершённое подключения администратор увидит все три.
 */
export const PREVIEW_BANK_ACCOUNTS: ConnectedBankAccount[] = [
  {
    id: 1,
    provider: 'alfa-by',
    accountKey: 'BY00ALFA00000000000000000001',
    connectedAt: 0,
    expiresAt: 0,
    hasRefresh: true,
    consentExpiresAt: 0,
    pollPaused: false,
    // Грант размечен — строка показывает кнопку «Добавить счёт» (#23), иначе визуальный эталон
    // не документировал бы её вовсе.
    grantId: 'preview-grant'
  },
  {
    id: 2,
    provider: 'prior-by',
    accountKey: 'BY00PJCB00000000000000000002',
    connectedAt: 0,
    expiresAt: 0,
    hasRefresh: true,
    consentExpiresAt: 0,
    pollPaused: true,
    grantId: 'preview-grant-2'
  },
  {
    id: 3,
    provider: 'prior-by',
    accountKey: '~pending:preview',
    connectedAt: 0,
    expiresAt: 0,
    hasRefresh: false,
    consentExpiresAt: 0,
    pollPaused: false,
    // Незавершённое подключение гранта тоже несёт, но кнопки «Добавить счёт» у него нет: счёт
    // самого подключения ещё не выбран (см. `canAddAccount`).
    grantId: 'preview-grant-3'
  }
]

export function useBankAccounts() {
  const accounts = ref<ConnectedBankAccount[]>([])
  const loading = ref(false)
  const removing = ref('')
  const saving = ref('')
  /** Ключ строки, у которой сейчас переключается пауза (#576) — свой флаг, чтобы кнопка паузы не
   *  блокировала «Отключить» на той же строке и наоборот. */
  const pausing = ref('')
  /** Идёт массовое переключение (#581) — отдельный флаг: он гасит кнопку «всё» И построчные
   *  действия разом, тогда как `pausing` адресует ОДНУ строку.
   *  ⚠ Построчные кнопки гасить обязательно, и это не косметика. Цикл сделан ПОСЛЕДОВАТЕЛЬНЫМ
   *  именно чтобы не слать залп в задросселированную зону nginx; ручной клик по строке во время
   *  цикла создаёт ровно такой параллельный запрос, а на одной строке — ещё и гонку записи с
   *  противоположным значением. Первая редакция обещала это комментарием, но гасила только саму
   *  кнопку «всё» — поймано ревью. */
  const pausingAll = ref(false)
  /** Ключ строки, к которой сейчас добавляется счёт (#23) — свой флаг по той же причине, что и у
   *  паузы: одна занятая кнопка не должна блокировать остальные на той же строке. */
  const adding = ref('')
  const error = ref('')
  /** True once a load has resolved — lets the UI tell «пусто» apart from «ещё не спрашивали». */
  const loaded = ref(false)

  /** Row identity used for the per-row busy flag (provider+account is the store key). */
  function rowKey(a: Pick<ConnectedBankAccount, 'provider' | 'accountKey'>): string {
    return `${a.provider}|${a.accountKey}`
  }

  async function load(): Promise<void> {
    const a = frameAuth()
    if (!a) {
      // Outside the portal there is no frame token — stay inert rather than showing an error.
      accounts.value = []
      loaded.value = true
      return
    }
    loading.value = true
    error.value = ''
    try {
      const res = await $fetch<{ accounts?: ConnectedBankAccount[] }>('/api/bank/accounts', { headers: authHeaders(a) })
      accounts.value = Array.isArray(res?.accounts) ? res.accounts : []
    } catch (e) {
      error.value = frameFetchError(e, 'Не удалось загрузить список подключений')
    } finally {
      loading.value = false
      loaded.value = true
    }
  }

  /** Disconnect one account, then re-read the list (the server is the source of truth — an
   *  optimistic local splice would lie if the delete silently failed). */
  async function disconnect(account: Pick<ConnectedBankAccount, 'id' | 'provider' | 'accountKey'>): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Отключение доступно только внутри портала Bitrix24'
      return false
    }
    removing.value = rowKey(account)
    error.value = ''
    try {
      await $fetch('/api/bank/disconnect', {
        method: 'POST',
        headers: authHeaders(a),
        // `id` адресует строку, `accountKey` едет как ОЖИДАНИЕ: сервер сверит его с текущим и
        // ответит 409, если между отрисовкой и кликом подключение стало другим (#517).
        body: { id: account.id, provider: account.provider, accountKey: account.accountKey }
      })
      await load()
      return true
    } catch (e) {
      error.value = disconnectErrorMessage(e)
      return false
    } finally {
      removing.value = ''
    }
  }

  /**
   * Приостановить или возобновить автоопрос одного подключения (#576).
   *
   * ⚠ После успеха перечитываем список с сервера, а не правим локально: оптимистичная правка
   * соврала бы ровно в том случае, ради которого сервер вообще отвечает статусами — когда строка
   * под пользователем изменилась.
   */
  async function setPaused(account: Pick<ConnectedBankAccount, 'id' | 'provider' | 'accountKey'>, paused: boolean): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Управление опросом доступно только внутри портала Bitrix24'
      return false
    }
    pausing.value = rowKey(account)
    error.value = ''
    try {
      await $fetch('/api/bank/pause', {
        method: 'POST',
        headers: authHeaders(a),
        // `id` адресует строку, `accountKey` едет как ОЖИДАНИЕ — сервер сверит его с текущим (#517).
        body: { id: account.id, provider: account.provider, accountKey: account.accountKey, paused }
      })
      await load()
      return true
    } catch (e) {
      error.value = pausePollErrorMessage(e, paused)
      return false
    } finally {
      pausing.value = ''
    }
  }

  /**
   * Переключить паузу СРАЗУ по всем подходящим подключениям (#581).
   *
   * ⚠ Это тонкий цикл поверх того же `POST /api/bank/pause` — новой семантики хранения не
   * заводится. Пауза остаётся пер-счёт; кнопка экономит четыре клика, а не вводит «паузу портала».
   *
   * ⚠ ПОСЛЕДОВАТЕЛЬНО, а не `Promise.all`. Роут сидит в задросселированной зоне nginx (`import`),
   * и залп из четырёх запросов — самый дешёвый способ получить 429 на исправном портале. Строк
   * единицы, ждать нечего.
   *
   * ⚠ На отказе НЕ останавливаемся. Намерение — «выключить всё»; остановившись на первой сбойной
   * строке, мы оставили бы остальные работать, хотя они переключились бы. Что не вышло — считаем и
   * говорим прямо.
   *
   * ⚠ Список перечитываем ОДИН раз в конце, а не после каждой строки, как это делает `setPaused`.
   * Там перечитывание — защита от вранья оптимистичной правки; здесь оно дало бы N+1 запрос и
   * список, мигающий под курсором. Финальное чтение показывает ФАКТИЧЕСКОЕ состояние — это честнее
   * перечисления «что не вышло» по нашим же ответам.
   */
  async function setPausedAll(
    rows: readonly Pick<ConnectedBankAccount, 'id' | 'provider' | 'accountKey'>[],
    paused: boolean
  ): Promise<{ done: number, failed: number }> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Управление опросом доступно только внутри портала Bitrix24'
      return { done: 0, failed: rows.length }
    }
    pausingAll.value = true
    error.value = ''
    let done = 0
    let failed = 0
    try {
      for (const row of rows) {
        try {
          await $fetch('/api/bank/pause', {
            method: 'POST',
            headers: authHeaders(a),
            body: { id: row.id, provider: row.provider, accountKey: row.accountKey, paused }
          })
          done++
        } catch {
          // ⚠ Текст ошибки строки СЮДА не поднимаем: у четырёх строк он был бы четырёх видов, а
          // читателю нужен один понятный итог. Правду о состоянии показывает перечитанный список.
          failed++
        }
      }
      await load()
    } finally {
      pausingAll.value = false
    }
    return { done, failed }
  }

  /** Назначить счёт подключению, сделанному без него (#407). Переименовывается только временный
   *  ключ — сервер это и проверяет; здесь просто UI-обёртка. */
  async function setAccount(account: Pick<ConnectedBankAccount, 'provider' | 'accountKey'>, accountKey: string): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Действие доступно только внутри портала Bitrix24'
      return false
    }
    const value = accountKey.trim()
    if (!value) {
      error.value = 'Укажите номер счёта'
      return false
    }
    saving.value = rowKey(account)
    error.value = ''
    try {
      await $fetch('/api/bank/set-account', {
        method: 'POST',
        headers: authHeaders(a),
        body: { provider: account.provider, pendingKey: account.accountKey, accountKey: value }
      })
      await load()
      return true
    } catch (e) {
      // Не `frameFetchError`: он подклеил бы английский текст сервера, а среди исходов теперь есть
      // «занято, повторите» — совет, который обязан быть читаемым (#509).
      error.value = setAccountErrorMessage(e)
      return false
    } finally {
      saving.value = ''
    }
  }

  /**
   * Добавить ЕЩЁ ОДИН счёт к существующему подключению (#23).
   *
   * ⚠ Ключевое отличие от `setAccount`: тот ПЕРЕИМЕНОВЫВАЕТ временный ключ (счёт у подключения
   * один и он ещё не выбран), а этот заводит новую строку под тем же грантом банка. Согласие банк
   * выдаёт на набор счетов клиента, поэтому шестой счёт не стоит шестого входа в интернет-банк.
   */
  async function addAccount(account: Pick<ConnectedBankAccount, 'id' | 'provider' | 'accountKey'>, accountKey: string): Promise<boolean> {
    const a = frameAuth()
    if (!a) {
      error.value = 'Действие доступно только внутри портала Bitrix24'
      return false
    }
    const value = accountKey.trim()
    if (!value) {
      // Точка — как во всех остальных сообщениях этого же алерта.
      error.value = 'Укажите номер счёта.'
      return false
    }
    adding.value = rowKey(account)
    error.value = ''
    try {
      await $fetch('/api/bank/add-account', {
        method: 'POST',
        headers: authHeaders(a),
        // `id` адресует исходную строку, номер едет как ОЖИДАНИЕ — сервер сверит его с текущим и
        // ответит 409, если между отрисовкой и кликом подключение стало другим (#517).
        body: { id: account.id, sourceAccountKey: account.accountKey, accountKey: value }
      })
      await load()
      return true
    } catch (e) {
      // Не `frameFetchError`: исходов несколько, они английские, и каждый требует своего действия.
      error.value = addAccountErrorMessage(e)
      return false
    } finally {
      adding.value = ''
    }
  }

  return { accounts, loading, loaded, removing, saving, pausing, pausingAll, adding, error, load, disconnect, setPaused, setPausedAll, setAccount, addAccount, rowKey }
}
