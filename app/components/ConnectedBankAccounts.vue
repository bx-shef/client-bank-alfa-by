<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useBankAccounts, PREVIEW_BANK_ACCOUNTS, type ConnectedBankAccount } from '~/composables/useBankAccounts'
import { isPendingAccountKey } from '~/utils/bankAccountKey'
import { isPreviewQuery } from '~/utils/inPortalGate'
import { normalizeForCompare, type BankSideAccount } from '~/utils/bankAccountMatrix'
import { formatRelativeTime } from '~/utils/importStatus'
import { BANK_LABELS } from '~/utils/bankLabels'
import {
  NEEDS_HUMAN_HEALTH, connectionHealth, connectionHealthBadge, connectionHint, consentExpiringSoon
} from '~/utils/bankTokenLifetime'
import { pauseAllSummary, planPauseAll } from '~/utils/bankPauseAll'
import { useManualPoll } from '~/composables/useManualPoll'
import { dayVerdictMessage, isoDayFromMs, pollDayVerdict } from '~/utils/dayValue'

// Connected bank accounts, with a per-row disconnect (#404). Lives inside BankConnectCard, above
// the connect form, so the admin sees what is already bound BEFORE adding another account —
// previously a successful connect left no trace anywhere in the UI.
//
// Admin gate is NOT repeated here: the card that hosts this already gates on admin, and the
// backend re-gates both routes (the client gate is convenience, the server one is authority).

// Счета, которые отдал сам банк (#494) — из общей сверки, живущей в родительской карточке.
// Благодаря им выбор счёта у ожидающего подключения становится КЛИКОМ, а не перепечатыванием
// 28-значного IBAN: именно опечатка в нём на первом боевом прогоне дала «117 обработано, 0
// создано» без единого сообщения об ошибке. Поле ввода остаётся — банк может и не ответить.
const props = withDefaults(defineProps<{ bankAccounts?: BankSideAccount[] }>(), { bankAccounts: () => [] })
// Родитель перечитывает сверку после привязки/отключения: обе половины экрана описывают одно и то
// же, и оставить одну устаревшей — значит показать противоречие самому себе.
const emit = defineEmits<{ changed: [] }>()

const {
  accounts, loading, loaded, removing, saving, pausing, pausingAll, adding, error,
  load, disconnect, setPaused, setPausedAll, setAccount, addAccount, rowKey
} = useBankAccounts()
const route = useRoute()

/** Номера, уже привязанные В ЭТОМ банке, — предлагать их незачем (сервер ответит 409). Ключ несёт
 *  провайдера: один и тот же номер у разных банков это разные строки хранилища. */
const takenKeys = computed(() => new Set(
  accounts.value
    .filter(a => !isPendingAccountKey(a.accountKey))
    .map(a => `${a.provider}|${normalizeForCompare(a.accountKey)}`)
))

/**
 * Что предложить ожидающему подключению: счета ТОГО ЖЕ банка, ещё не привязанные.
 *
 * ⚠ Фильтр по банку обязателен. Портал может держать Альфу и Приор одновременно — это штатно, — а
 * сверка складывает обе стороны в один список. Без фильтра счёт Приора предлагался бы к выбору для
 * подключения Альфы, и клик по нему записал бы его в `account_key` альфовой строки. Конфликта не
 * возникло бы: уникальность проверяется в пределах провайдера. А дальше `account_key` уходит
 * БУКВАЛЬНО параметром `number=` в запрос выписки Альфы — то есть подключение молча перестало бы
 * работать, и выглядело бы это как «банк ничего не отдаёт».
 */
function suggestionsFor(a: ConnectedBankAccount) {
  return props.bankAccounts.filter(b =>
    b.provider === a.provider && !takenKeys.value.has(`${a.provider}|${normalizeForCompare(b.number)}`)
  )
}

/**
 * План массового переключения паузы (#581): что делает кнопка «всё» и над какими строками.
 * `null` ⇒ кнопки нет. Всё решение — в чистом ядре, здесь только рендер.
 */
const bulk = computed(() => planPauseAll(accounts.value))

/** Итог последнего массового переключения — показывается рядом с кнопкой, не вместо списка. */
const bulkNote = ref('')

/**
 * ⚠ Итог обязателен, и это не вежливость. Частичный отказ («переключились три из четырёх») без
 * сообщения читается как полный успех, а один продолжающий работать счёт потом ищут в банке.
 * Правду о состоянии показывает перечитанный список, а эта строка объясняет, почему он такой.
 */
async function togglePauseAll(): Promise<void> {
  const plan = bulk.value
  if (!plan) return
  bulkNote.value = ''
  const { done, failed } = await setPausedAll(plan.rows, plan.paused)
  bulkNote.value = pauseAllSummary(done, failed, plan.paused, plan.total)
}

// ⚠ Заметка гаснет, как только список изменился ИНАЧЕ. Без этого она переживала построчное
// «Возобновить» и продолжала утверждать «на паузе все 4» рядом с кнопкой, подпись которой уже
// перевернулась обратно, — то есть экран спорил сам с собой.
watch(accounts, () => {
  if (!pausingAll.value) bulkNote.value = ''
})

/** Черновики номеров для подключений, ждущих выбора счёта (#407) — по одному на строку. */
const drafts = ref<Record<string, string>>({})

/**
 * У какой строки раскрыт блок «добавить счёт» (#23).
 *
 * ⚠ Свёрнут по умолчанию намеренно. Подавляющему большинству порталов хватает одного счёта, а
 * поле ввода рядом с рабочим подключением читалось бы как «здесь чего-то не хватает» — ровно тем
 * же способом, каким вводило в заблуждение поле номера в форме подключения (снято по живому
 * прогону 2026-08-14). Открывает его тот, кто действительно пришёл за вторым счётом.
 */
const expandingAdd = ref('')
/** Черновики номеров ДОБАВЛЯЕМЫХ счетов (#23) — свои, чтобы не мешаться с выбором счёта (#407). */
const addDrafts = ref<Record<string, string>>({})
/** Сообщение об успешном добавлении — озвучивается и показывается рядом с местом клика (#23). */
const added = ref('')

/**
 * Может ли к этой строке добавляться счёт (#23).
 *
 * ⚠ Два запрета, и оба — не про интерфейс. У НЕЗАВЕРШЁННОГО подключения счёт ещё не выбран, и
 * «добавить второй» к строке без первого было бы обходом `set-account`. У подключения БЕЗ ГРАНТА
 * (заведено до #23) делить нечего: копия токенов означала бы вторую строку с парой, которую банк
 * ротирует, то есть ровно тот дефект, от которого грант защищает. Сервер отвечает на оба, но
 * показывать кнопку, ведущую в гарантированный отказ, — приучать не верить кнопкам.
 */
function canAddAccount(a: ConnectedBankAccount): boolean {
  return !isPendingAccountKey(a.accountKey) && a.grantId !== ''
}

/** Which row is awaiting confirmation. Disconnect is destructive (imports stop), so it takes a
 *  deliberate second click rather than a native confirm() — the latter is blocked in some iframes. */
const confirming = ref('')

/**
 * Превью-ветка (#3) — синтетический список для `?preview=1`.
 *
 * ⚠ Обязательна по той же причине, что у карточки здоровья на `/queues`: вне портала фрейм-токена
 * нет, список ВСЕГДА пуст, и ни один скриншот и ни один визуальный эталон не показывали строку
 * подключения вообще. Всё, что живёт в строке — бейджи состояния, выбор счёта, пауза, подтверждение
 * отключения — не было прикрыто визуальной регрессией ни разу.
 *
 * ⚠ Флаг читается РЕАКТИВНО, а не один раз в `onMounted`, и это не стиль. На ПРЕРЕНДЕРЕННОЙ
 * странице Nuxt гидратирует на голом пути и восстанавливает настоящий адрес позже (#555), поэтому
 * `onMounted` видит пустую строку запроса. Первая версия читала флаг там — и превью молча не
 * работало: снимок показывал «Пока ничего не подключено» ровно на том экране, ради которого
 * заводился (проверено на собранной статике).
 *
 * ⚠ Превью побеждает В ОБЕ СТОРОНЫ, а не «watch приходит позже и затирает». Прежняя версия
 * полагалась на второе, и вне портала это верно (у `load()` ранний выход БЕЗ единого `await`), но
 * ВНУТРИ портала с реальным токеном — нет: `load()` уходит в сеть и возвращается ПОСЛЕ `watch`,
 * молча затирая фикстуру. То есть `/settings?preview=1`, открытый в портале, давал результат по
 * гонке двух источников, ни один из которых не сверялся с другим (находка ревью). Поэтому флаг
 * проверяется дважды: реактивно и ещё раз после ответа сети.
 *
 * ⚠ `onNuxtReady` (приём мидлвара слайдера, #555) здесь НЕ подходит: в тестовой среде
 * `mountSuspended` он не срабатывает вовсе, и компонент перестаёт загружаться — проверено, три
 * существующих теста стали красными. Приём верен для мидлвара, но не для компонента.
 */
const preview = computed(() => isPreviewQuery(route.query.preview))

function usePreviewFixture(): void {
  accounts.value = PREVIEW_BANK_ACCOUNTS
  loaded.value = true
}

watch(preview, (isPreview) => {
  if (isPreview) usePreviewFixture()
}, { immediate: true })

onMounted(async () => {
  if (preview.value) return
  await load()
  // Адрес мог восстановиться, пока шёл запрос (#555) — тогда победить обязано превью.
  if (preview.value) usePreviewFixture()
})

function providerLabel(id: ConnectedBankAccount['provider']): string {
  return BANK_LABELS[id] ?? id
}

/** «подключён N минут назад». The store gives epoch ms; the shared formatter takes an ISO string
 *  plus an explicit «now» (it is pure — no hidden clock), hence the conversion here. A row with a
 *  bad timestamp renders nothing rather than «Invalid Date». */
function connectedAgo(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  return formatRelativeTime(new Date(ms).toISOString(), Date.now())
}

/** Бейдж состояния подключения (#488) или `null`, когда сказать нечего. Чистое ядро —
 *  `bankTokenLifetime.ts`, ТО ЖЕ, по которому сервер решает, кого обновлять: собственное правило
 *  в интерфейсе рисовало бы зелёное на подключении, которое сервер уже похоронил. */
function healthBadge(a: ConnectedBankAccount) {
  return connectionHealthBadge(connectionHealth(a, Date.now()))
}

/**
 * Подсказка под бейджем — с учётом ПРИЧИНЫ, когда подключение истекло (#488).
 *
 * ⚠ Раньше она жила только в `title`, то есть во всплывашке. Задача, из которой это выросло:
 * владелец четвёртый день переподключал Альфу и каждый раз назавтра видел то же «подключение
 * истекло». Всплывашка тут бесполезна вдвойне — на мобильном её нет вовсе, а именно с телефона
 * чаще всего и смотрят.
 */
function healthHint(a: ConnectedBankAccount): string {
  return connectionHint(a, Date.now())
}

/** Показывать ли развёрнутое объяснение строкой, а не всплывашкой. */
function showsHint(a: ConnectedBankAccount): boolean {
  return NEEDS_HUMAN_HEALTH.includes(connectionHealth(a, Date.now()))
}

/**
 * Когда мы последний раз ПЫТАЛИСЬ обновить — человеческой строкой.
 *
 * ⚠ «Не пытались ни разу» и «пытались час назад» ведут к противоположным действиям, и без этой
 * строки они на экране неразличимы: бейдж у них один и тот же. Показываем только там, где это
 * решает — на подключении, требующем человека.
 */
function attemptNote(a: ConnectedBankAccount): string {
  const at = Number(a.lastAttemptAt ?? 0)
  if (!Number.isFinite(at) || at <= 0) return 'Попыток обновления не было ни одной.'
  return `Последняя попытка обновления: ${connectedAgo(at)}.`
}

/**
 * Строка про согласие банка (#503) или `''`, когда сказать нечего.
 *
 * ⚠ Молчим, если даты нет: у Альфы согласий не бывает вовсе, и прочерк на её строке был бы
 * выдуманной сущностью. Молчим и об истёкшем — про него уже кричит бейдж состояния, а вторая
 * надпись рядом только размывает единственное действие.
 *
 * ⚠ Предупреждаем ЗА НЕДЕЛЮ: продлевает согласие не администратор, который смотрит на этот экран,
 * а владелец счёта — заходя в интернет-банк. За день такое не организуешь, и предупреждение
 * накануне стало бы уведомлением об уже неизбежном простое.
 */
function consentLine(a: ConnectedBankAccount): string {
  const at = a.consentExpiresAt
  if (!at || !Number.isFinite(at) || at <= Date.now()) return ''
  const until = new Date(at).toLocaleDateString('ru-RU')
  return consentExpiringSoon(a, Date.now())
    ? `согласие банка истекает ${until} — потребуется вход владельца счёта в интернет-банк`
    : `согласие банка действует до ${until}`
}

/** Скоро ли истекает согласие — от этого зависит только тон строки, не её наличие. */
function consentSoon(a: ConnectedBankAccount): boolean {
  return consentExpiringSoon(a, Date.now())
}

/** Подпись строки для скринридера. Временный ключ служебный — озвучивать его бессмысленно. */
function rowLabel(a: ConnectedBankAccount): string {
  return isPendingAccountKey(a.accountKey)
    ? `${providerLabel(a.provider)}, счёт не выбран`
    : `${providerLabel(a.provider)} ${a.accountKey}`
}

async function onAssign(a: ConnectedBankAccount, value?: string) {
  const key = rowKey(a)
  // Успех → строка перечитается уже с настоящим номером, черновик больше не нужен.
  if (await setAccount(a, value ?? drafts.value[key] ?? '')) {
    drafts.value[key] = ''
    emit('changed')
  }
}

/**
 * Забор за конкретный день — ПО ЭТОМУ счёту (#19).
 *
 * ⚠ Раньше кнопка жила в карточке ручного опроса и ставила задачу на КАЖДЫЙ подключённый счёт
 * портала: человек смотрел на конкретную строку, а лимит запросов тратился на счета, о которых он
 * не спрашивал, и ответ «опрос запущен» не говорил, что именно опрошено. Теперь действие
 * адресовано — и адрес виден прямо в заголовке окна.
 *
 * ⚠ Именно ОДИН день, а не интервал: интервал это N задач к банку за один клик, то есть нагрузка,
 * которую портал назначал бы себе сам вопреки правилу «частоту регулируем мы» (#54).
 */
const {
  poll, polling: pollingDay, error: pollError, message: pollMessage, outcome: pollOutcome, waiting: pollWaiting
} = useManualPoll()
/** Строка, для которой открыто окно забора; `null` — окно закрыто. */
const fetchingRow = ref<ConnectedBankAccount | null>(null)
const fetchDay = ref('')
const fetchDayVerdict = computed(() =>
  (fetchDay.value ? pollDayVerdict(fetchDay.value, isoDayFromMs(Date.now())) : 'malformed'))
const fetchDayError = computed(() => (fetchDay.value ? dayVerdictMessage(fetchDayVerdict.value) : ''))
/** Забор доступен только с выбранным и годным днём — дата обязательна. */
const canFetchDay = computed(() => fetchDayVerdict.value === 'ok' && !pollingDay.value)

function openFetch(a: ConnectedBankAccount) {
  fetchDay.value = ''
  pollMessage.value = ''
  pollError.value = ''
  pollOutcome.value = ''
  fetchingRow.value = a
}

async function onFetchDay() {
  const a = fetchingRow.value
  if (!a || !canFetchDay.value) return
  await poll(fetchDay.value, { provider: a.provider, accountKey: a.accountKey })
  // Окно закрываем только на успехе: при отказе человек должен прочитать причину, не открывая заново.
  if (!pollError.value) fetchingRow.value = null
}

/** Есть ли в портале хоть одно РАЗМЕЧЕННОЕ подключение — только тогда отсутствие кнопки у соседа
 *  требует объяснения: сравнивать не с чем, если её нет ни у кого. */
const hasGrantedAccount = computed(() => accounts.value.some(canAddAccount))

/**
 * Раскрыть блок добавления и увести фокус в поле.
 *
 * ⚠ Возврат фокуса обязателен в обе стороны (находка ревью по доступности): кнопка и блок — это
 * `v-if`/`v-else-if`, то есть нажатая кнопка ИСЧЕЗАЕТ из DOM, фокус падает на `<body>`, и
 * клавиатурный пользователь начинает Tab с начала страницы. То же при отмене и после успеха.
 */
async function openAdd(a: ConnectedBankAccount) {
  // Прошлый успех больше не про то, что человек делает сейчас.
  added.value = ''
  expandingAdd.value = rowKey(a)
  await nextTick()
  const el = document.getElementById(`add-account-${a.id}`)?.querySelector('input')
  el?.focus()
}

async function closeAdd(a: ConnectedBankAccount) {
  expandingAdd.value = ''
  await nextTick()
  // ⚠ Адрес — по `id` СТРОКИ, а не по банку (находка код-ревью). Именно эта правка и создаёт
  // случай, когда у одного банка несколько строк: селектор по провайдеру нашёл бы ПЕРВУЮ из них, и
  // после отмены фокус клавиатурного пользователя уезжал бы на кнопку чужого счёта.
  const btn = document.querySelector<HTMLElement>(`[data-testid="add-account-open-${a.id}"]`)
  btn?.focus()
}

async function onAdd(a: ConnectedBankAccount, value?: string) {
  const key = rowKey(a)
  // Номер читаем ДО вызова: после успеха черновик очищается, и сообщение осталось бы без номера.
  const number = (value ?? addDrafts.value[key] ?? '').trim()
  if (await addAccount(a, number)) {
    addDrafts.value[key] = ''
    // ⚠ Успех обязан СКАЗАТЬ о себе (находка ревью по UX): блок схлопывается, новая строка
    // появляется где-то в списке без выделения, и при двух-трёх подключениях это неотличимо от
    // «кнопка ничего не сделала» — ровно тот симптом, от которого лечили #404.
    added.value = `Счёт ${number} добавлен к подключению ${providerLabel(a.provider)}.`
    await closeAdd(a)
    emit('changed')
  }
}

async function onDisconnect(a: ConnectedBankAccount) {
  confirming.value = ''
  if (await disconnect(a)) emit('changed')
}

defineExpose({ reload: load })
</script>

<template>
  <section
    class="space-y-3"
    data-testid="connected-accounts"
  >
    <h3 class="text-sm font-semibold">
      Подключённые счета
    </h3>

    <p
      v-if="loading && !loaded"
      class="text-sm text-(--ui-color-base-3)"
      role="status"
      aria-live="polite"
    >
      Загружаем…
    </p>

    <!-- Error sits ABOVE the list, never INSTEAD of it: a failed disconnect used to collapse the
         whole section into one alert, so the admin lost the row they were trying to retry. -->
    <div
      role="alert"
      aria-live="assertive"
    >
      <B24Alert
        v-if="error"
        color="air-primary-alert"
        :description="error"
        data-testid="accounts-error"
      />
    </div>

    <p
      v-if="loaded && !accounts.length"
      class="text-sm text-(--ui-color-base-3)"
      data-testid="accounts-empty"
    >
      Пока ничего не подключено. Подключите счёт ниже — после этого он появится здесь.
    </p>

    <!-- Массовое переключение (#581). Стоит НАД списком: намерение «выключить всё» возникает от
         вида списка целиком, а не от конкретной строки. Показывается только когда есть что
         переключать (решает чистое ядро) — иначе это кнопка, которая ничего не делает. -->
    <div
      v-if="bulk"
      class="flex flex-wrap items-center gap-2"
    >
      <B24Button
        color="air-secondary"
        size="sm"
        :label="bulk.label"
        :loading="pausingAll"
        :disabled="pausingAll"
        data-testid="pause-all"
        :title="bulk.hint"
        @click="togglePauseAll"
      />
      <!-- ⚠ Цена названа ДО клика, а не после. Предупреждение о пропущенных днях ниже по странице
           показывается только когда что-то УЖЕ на паузе — то есть человек, впервые гасящий импорт
           по всем счетам разом, не видел его в момент решения вовсе, а при нескольких подключениях
           оно ещё и уезжает за экран. -->
      <span
        class="text-xs text-(--ui-color-base-4)"
        data-testid="pause-all-hint"
      >{{ bulk.hint }}</span>
      <!-- ⚠ Живой регион существует ВСЕГДА, а текст появляется внутри него. Регион, созданный
           вместе с содержимым, скринридеры обычно не объявляют — а это единственная обратная связь
           о частичном отказе. Тот же приём, что у алерта ошибок двумя блоками выше. -->
      <span
        class="text-xs text-(--ui-color-base-3)"
        role="status"
        aria-live="polite"
        data-testid="pause-all-note"
      >{{ bulkNote }}</span>
    </div>

    <!-- ⚠ `v-if`, а не `v-else-if`: между этим списком и пустым состоянием выше теперь стоит блок
         массового переключения, а `v-else-if` обязан идти НЕПОСРЕДСТВЕННО за своим `v-if`. Условия
         и так взаимоисключающие (`accounts.length` против `!accounts.length`), так что цепочка тут
         ничего не давала, кроме скрытой хрупкости — стоило вставить что-нибудь между, и список
         переставал рисоваться. -->
    <ul
      v-if="accounts.length"
      class="space-y-2"
    >
      <li
        v-for="a in accounts"
        :key="rowKey(a)"
        class="rounded-md border border-(--ui-color-design-tinted-na-stroke) p-3"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span class="font-medium">{{ providerLabel(a.provider) }}</span>
              <!-- Два РАЗНЫХ состояния, поэтому разные цвета и оба показываются вместе: у Приора
                   refresh часто пуст, и раньше после привязки счёта бейдж «счёт не выбран» сменялся
                   на «нужно переподключить» — читалось так, будто привязка что-то сломала. -->
              <B24Badge
                v-if="isPendingAccountKey(a.accountKey)"
                color="air-secondary-accent"
                size="xs"
                label="счёт не выбран"
              />
              <!-- Состояние подключения (#488). Считается по ВОЗРАСТУ ПАРЫ, а не по `expiresAt`:
                   тот описывает access-токен, и именно поэтому мёртвое подключение раньше
                   выглядело здоровым — access свежий, а refresh за ним уже не существует.
                   `ok` бейджа не даёт намеренно: значок на каждой исправной строке приучает их
                   не читать, а «подключён N назад» строчкой ниже и так всё говорит. -->
              <B24Badge
                v-if="healthBadge(a)"
                :color="healthBadge(a)!.color"
                size="xs"
                :label="healthBadge(a)!.label"
                :title="healthHint(a)"
              />
              <!-- Пауза автоопроса (#576). ⚠ Отдельный бейдж, а не цвет строки: подключение при
                   этом ЖИВОЕ — токен продлевается, грант цел, — и покрасить строку «как сломанную»
                   значило бы отправить администратора чинить то, что он сам и выключил. -->
              <B24Badge
                v-if="a.pollPaused"
                color="air-secondary-accent-1"
                size="xs"
                label="опрос на паузе"
                title="Подключение живо и токен продлевается — приложение просто не ходит за выпиской"
              />
            </div>
            <!-- Подключение без счёта (#407): строка есть, номера ещё нет — просим выбрать прямо
                 здесь, иначе такое подключение было бы «висящим» и непонятным. -->
            <div
              v-if="isPendingAccountKey(a.accountKey)"
              class="mt-1 flex flex-wrap items-center gap-2"
              :data-testid="`pending-${a.provider}`"
            >
              <!-- Счета, которые назвал сам банк (#494): один клик вместо перепечатывания IBAN.
                   Показываем ТОЛЬКО когда банк ответил — иначе остаётся поле ниже. -->
              <div
                v-if="suggestionsFor(a).length"
                class="flex w-full flex-wrap items-center gap-2"
                data-testid="account-suggestions"
              >
                <span class="text-xs text-(--ui-color-base-3)">Банк отдал:</span>
                <B24Button
                  v-for="s in suggestionsFor(a)"
                  :key="s.number"
                  :label="s.currency ? `${s.number} · ${s.currency}` : s.number"
                  :aria-label="`Выбрать счёт ${s.number}`"
                  color="air-secondary-accent"
                  size="xs"
                  class="font-mono"
                  :loading="saving === rowKey(a)"
                  :disabled="saving === rowKey(a)"
                  @click="onAssign(a, s.number)"
                />
              </div>
              <B24Input
                v-model="drafts[rowKey(a)]"
                placeholder="BY00ALFA00000000000000000000"
                class="w-full max-w-xs font-mono text-xs"
                :aria-label="`Номер счёта для подключения ${providerLabel(a.provider)}`"
              />
              <B24Button
                label="Указать номер счёта"
                color="air-primary"
                size="xs"
                :loading="saving === rowKey(a)"
                :disabled="saving === rowKey(a)"
                @click="onAssign(a)"
              />
            </div>
            <div
              v-else
              class="truncate font-mono text-xs text-(--ui-color-base-3)"
            >
              {{ a.accountKey }}
            </div>
            <!-- ⚠ ПОЧЕМУ истекло — СТРОКОЙ, а не всплывашкой (#488). Бейдж называет состояние, но
                 не следующее действие, а действий тут ДВА РАЗНЫХ: банк отказал — помогает
                 переподключение; продление ни разу не бралось за строку — оно бесполезно и вернёт
                 зелёный ровно на один срок жизни токена. Именно на этой развилке уходили дни:
                 экран советовал одно и то же в обоих случаях.
                 ⚠ Стоит ПОСЛЕ номера счёта, а не между ним и названием банка: длинный абзац
                 посередине разрывает то, что человек читает одним взглядом — какой банк и какой
                 счёт (замерено скриншотом). -->
            <p
              v-if="showsHint(a)"
              class="mt-1 text-xs text-(--ui-color-base-3)"
              :data-testid="`health-hint-${a.id}`"
            >
              {{ healthHint(a) }} {{ attemptNote(a) }}
            </p>
            <!-- ⚠ Отсутствие кнопки надо ОБЪЯСНИТЬ (#23, находка ревью по UX): две визуально
                 одинаковые строки, у одной кнопка есть, у другой нет — читается как сбой
                 интерфейса, и первая реакция «кнопка пропала», а не «схожу в справку». Показываем
                 только когда сравнивать есть с чем: если размеченных подключений в портале нет
                 вовсе, разницы человек не видит и объяснять нечего. -->
            <div
              v-if="!isPendingAccountKey(a.accountKey) && a.grantId === '' && hasGrantedAccount"
              class="mt-1 text-xs text-(--ui-color-base-3)"
              :data-testid="`no-grant-${a.id}`"
            >
              Добавить второй счёт к этому подключению нельзя — оно сделано до появления такой
              возможности.
              <HelpLink
                anchor="many-accounts"
                label="Что делать"
              />
            </div>
            <!-- Ещё один счёт того же согласия (#23). Согласие банк выдаёт на НАБОР счетов клиента,
                 поэтому шестой счёт не должен стоить шестого входа владельца в интернет-банк.
                 Свёрнуто по умолчанию: большинству порталов хватает одного счёта, а открытое поле
                 рядом с рабочим подключением читалось бы как «здесь чего-то не хватает». -->
            <B24Button
              v-if="canAddAccount(a) && expandingAdd !== rowKey(a)"
              label="Добавить ещё счёт"
              :aria-label="`Добавить ещё счёт к подключению ${rowLabel(a)}`"
              color="air-tertiary"
              size="xs"
              class="mt-1"
              :disabled="pausingAll"
              :aria-expanded="false"
              :aria-controls="`add-account-${a.id}`"
              :data-testid="`add-account-open-${a.id}`"
              @click="openAdd(a)"
            />
            <div
              v-else-if="canAddAccount(a)"
              :id="`add-account-${a.id}`"
              class="mt-1 flex flex-wrap items-center gap-2"
              :data-testid="`add-account-${a.id}`"
            >
              <!-- Счета, которые назвал сам банк, — тот же клик вместо перепечатывания IBAN, что и
                   при выборе счёта (#494). Уже привязанные отфильтрованы: сервер ответил бы 409. -->
              <div
                v-if="suggestionsFor(a).length"
                class="flex w-full flex-wrap items-center gap-2"
                data-testid="add-account-suggestions"
              >
                <!-- ⚠ Не «Банк отдал»: список уже отфильтрован от подключённых, то есть банк на
                     самом деле назвал больше. Плюс это жаргон, а читает бухгалтер. -->
                <span class="text-xs text-(--ui-color-base-3)">Ещё не подключены:</span>
                <B24Button
                  v-for="s in suggestionsFor(a)"
                  :key="s.number"
                  :label="s.currency ? `${s.number} · ${s.currency}` : s.number"
                  :aria-label="`Добавить счёт ${s.number}`"
                  color="air-secondary-accent"
                  size="xs"
                  class="font-mono"
                  :loading="adding === rowKey(a)"
                  :disabled="adding === rowKey(a)"
                  @click="onAdd(a, s.number)"
                />
              </div>
              <B24Input
                v-model="addDrafts[rowKey(a)]"
                placeholder="BY00ALFA00000000000000000000"
                class="w-full max-w-xs font-mono text-xs"
                :aria-label="`Номер добавляемого счёта для ${providerLabel(a.provider)}`"
                :aria-describedby="`add-hint-${a.id}`"
                :disabled="adding === rowKey(a)"
              />
              <!-- ⚠ Формат жил только в плейсхолдере, а он исчезает при вводе и полю не описание.
                   Это же снимает главную причину отказа 400: номер копируют из реквизитов ВМЕСТЕ с
                   пробелами, и «допустимы буквы и цифры» человек читает, глядя на буквы и цифры. -->
              <span
                :id="`add-hint-${a.id}`"
                class="w-full text-xs text-(--ui-color-base-3)"
              >
                Номер — как в реквизитах компании, без пробелов.
              </span>
              <B24Button
                label="Добавить счёт"
                :aria-label="`Добавить счёт ${providerLabel(a.provider)}`"
                color="air-primary"
                size="xs"
                :loading="adding === rowKey(a)"
                :disabled="adding === rowKey(a)"
                @click="onAdd(a)"
              />
              <B24Button
                label="Отмена"
                :aria-label="`Отменить добавление счёта — ${rowLabel(a)}`"
                color="air-tertiary"
                size="xs"
                :disabled="adding === rowKey(a)"
                @click="closeAdd(a)"
              />
            </div>
            <div
              v-if="connectedAgo(a.connectedAt)"
              class="text-xs text-(--ui-color-base-3)"
            >
              подключён {{ connectedAgo(a.connectedAt) }}
            </div>
            <!-- Срок согласия банка (#503): другие часы, чем у токена, и продлить его может только
                 владелец счёта из интернет-банка — поэтому предупреждаем заранее, а не по факту. -->
            <div
              v-if="consentLine(a)"
              class="text-xs"
              :class="consentSoon(a)
                ? 'text-(--ui-color-accent-main-warning)'
                : 'text-(--ui-color-base-3)'"
            >
              {{ consentLine(a) }}
            </div>
          </div>

          <div class="flex items-center gap-2">
            <!-- Забор за конкретный день ПО ЭТОМУ счёту (#19). Раньше эта кнопка жила в карточке
                 ручного опроса и ставила задачу на КАЖДЫЙ счёт портала: человек смотрел на
                 конкретную строку, а спрашивали банк обо всех. Приостановленному подключению
                 кнопки нет — забирать по нему нечего, сервер ответит отказом. -->
            <B24Button
              v-if="!isPendingAccountKey(a.accountKey) && !a.pollPaused && confirming !== rowKey(a)"
              label="Забрать за день"
              :aria-label="`Забрать выписку за день — ${rowLabel(a)}`"
              color="air-tertiary-no-accent"
              size="xs"
              :disabled="pausingAll"
              :data-testid="`fetch-day-open-${a.id}`"
              @click="openFetch(a)"
            />
            <!-- Пауза опроса (#576). Стоит РЯДОМ с «Отключить» намеренно: это и есть тот выбор,
                 которого не хватало — раньше «слишком много операций» лечилось только отключением,
                 а оно стоит владельцу счёта повторного входа в интернет-банк. Подтверждения не
                 требует: действие обратимо тем же нажатием. Для незавершённого подключения кнопки
                 нет — опрашивать там нечего, ставить на паузу нечего. -->
            <B24Button
              v-if="!isPendingAccountKey(a.accountKey) && confirming !== rowKey(a)"
              :label="a.pollPaused ? 'Возобновить' : 'Пауза'"
              :aria-label="`${a.pollPaused ? 'Возобновить' : 'Приостановить'} опрос — ${rowLabel(a)}`"
              color="air-tertiary-no-accent"
              size="xs"
              :loading="pausing === rowKey(a)"
              :disabled="pausingAll || pausing === rowKey(a)"
              @click="setPaused(a, !a.pollPaused)"
            />
            <template v-if="confirming === rowKey(a)">
              <span
                class="text-xs text-(--ui-color-base-3)"
                role="status"
                aria-live="polite"
              >Отключить?</span>
              <B24Button
                label="Да, отключить"
                :aria-label="`Да, отключить ${rowLabel(a)}`"
                color="air-primary-alert"
                size="xs"
                :loading="removing === rowKey(a)"
                :disabled="pausingAll || removing === rowKey(a)"
                @click="onDisconnect(a)"
              />
              <B24Button
                label="Отмена"
                color="air-tertiary-no-accent"
                size="xs"
                @click="() => { confirming = '' }"
              />
            </template>
            <B24Button
              v-else
              label="Отключить"
              :aria-label="`Отключить ${rowLabel(a)}`"
              color="air-secondary-no-accent"
              size="xs"
              @click="() => { confirming = rowKey(a) }"
            />
          </div>
        </div>
      </li>
    </ul>

    <!-- ⚠ Оговорка про несколько счетов ОБЯЗАТЕЛЬНА (#23, находка ревью по UX). Без неё эта подпись
         утверждала безусловно: «вернуть доступ сможет только владелец счёта, заново авторизовавшись
         в интернет-банке», — и прямо противоречила справке, которая предлагает исправлять неверный
         номер через «Отключить» + «Добавить счёт». На экране висит именно пугающая формулировка,
         поэтому админ не пошёл бы тем путём, который мы для него и задумали. -->
    <p class="text-xs text-(--ui-color-base-3)">
      «Пауза» останавливает только автоматический опрос: доступ и подключение сохраняются, и
      возобновить можно тем же нажатием. Отключение убирает доступ приложения к этому счёту. Если у
      подключения есть другие счета, они продолжат работать, а отключённый можно вернуть кнопкой
      «Добавить ещё счёт» — без повторного входа в интернет-банк. Если счёт был единственным,
      вернуть доступ сможет только владелец счёта, заново авторизовавшись в банке. Уже записанные в
      CRM данные остаются в любом случае.
    </p>
    <!-- ⚠ Окно, а не поле в строке: календарь занимает экран, а строк подключений может быть шесть.
         Заголовок называет БАНК И СЧЁТ — ровно то, чего не хватало прежней кнопке. -->
    <B24Modal
      :open="fetchingRow !== null"
      :title="fetchingRow ? `Забрать выписку — ${rowLabel(fetchingRow)}` : ''"
      @update:open="(v: boolean) => { if (!v) fetchingRow = null }"
    >
      <template #body>
        <div
          class="space-y-3"
          data-testid="fetch-day-modal"
        >
          <p class="text-sm text-(--ui-color-base-2)">
            Если операции за какой-то день не подтянулись — выберите его и заберите повторно.
            Дубликатов не будет: уже записанные операции приложение узнаёт по самому делу.
            Интервал не поддерживается намеренно — это нагрузка на общий лимит запросов к банку.
          </p>
          <B24FormField
            label="День"
            required
            :error="fetchDayError"
            hint="Сегодняшний или прошедший — будущий выбрать нельзя"
          >
            <DayField v-model="fetchDay" />
          </B24FormField>
          <B24Alert
            v-if="pollError"
            color="air-primary-alert"
            :description="pollError"
            data-testid="fetch-day-error"
          />
        </div>
      </template>
      <template #footer>
        <div class="flex items-center gap-2">
          <B24Button
            label="Забрать"
            color="air-primary"
            :loading="pollingDay || pollWaiting"
            :disabled="!canFetchDay"
            :aria-busy="pollingDay || pollWaiting"
            data-testid="fetch-day-run"
            @click="onFetchDay"
          />
          <B24Button
            label="Отмена"
            color="air-tertiary"
            :disabled="pollingDay"
            @click="fetchingRow = null"
          />
        </div>
      </template>
    </B24Modal>

    <!-- ⚠ ИСХОД, а не только «опрос запущен» (#592). Пустой ответ банка снаружи неотличим от
         «кнопка не работает», и живая проверка застряла ровно на этом: приложение отвечало
         «запущен» и молчало. Забор адресный, поэтому счёт ровно один — исход показывать честно. -->
    <B24Alert
      v-if="pollOutcome"
      color="air-primary-success"
      :description="pollOutcome"
      data-testid="fetch-day-outcome"
    />

    <p
      v-if="pollMessage"
      class="text-xs text-(--ui-color-accent-main-success)"
      role="status"
      aria-live="polite"
      data-testid="fetch-day-done"
    >
      {{ pollMessage }}
    </p>

    <p
      v-if="added"
      class="text-xs text-(--ui-color-accent-main-success)"
      role="status"
      aria-live="polite"
      data-testid="add-account-done"
    >
      {{ added }}
    </p>
    <HelpLink
      anchor="pause-gap"
      label="Что будет с операциями за время паузы?"
    />
    <!-- ⚠ Ссылка стоит ЗДЕСЬ, у списка подключений, а не в общей справке: именно тут человек и
         застревает, обнаружив, что счетов у компании несколько, а строка одна. Справка объясняет
         и обратный ход — как исправить ошибочно указанный счёт, не теряя доступ у остальных. -->
    <HelpLink
      anchor="many-accounts"
      label="У компании несколько счетов?"
    />
    <!-- ⚠ Молчать об этом нельзя. Приложение забирает выписку за ОКНО (по умолчанию сутки), а не
         «всё, что накопилось»: после паузы длиннее окна пропущенные дни не подтянутся НИКОГДА и
         НИ ОДНОЙ строкой в интерфейсе. Человек, поставивший опрос на паузу на неделю, обнаружил бы
         это только сверкой с банком — то есть потерей данных, о которой мы знали и промолчали.
         Лекарство есть и оно рядом: ручная загрузка файла выписки за нужный период. -->
    <p
      v-if="accounts.some(a => a.pollPaused)"
      class="text-xs text-(--ui-color-accent-main-warning)"
      role="status"
    >
      Пока опрос на паузе, операции за пропущенные дни в CRM не попадут: приложение забирает
      выписку за последние сутки, а не за всё пропущенное время. Если пауза затянется — загрузите
      файл выписки за этот период вручную на странице «Загрузить выписку».
    </p>
  </section>
</template>
