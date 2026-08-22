<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useBankAccounts, PREVIEW_BANK_ACCOUNTS, type ConnectedBankAccount } from '~/composables/useBankAccounts'
import { isPendingAccountKey } from '~/utils/bankAccountKey'
import { isPreviewQuery } from '~/utils/inPortalGate'
import { normalizeForCompare, type BankSideAccount } from '~/utils/bankAccountMatrix'
import { formatRelativeTime } from '~/utils/importStatus'
import { BANK_LABELS } from '~/utils/bankLabels'
import { connectionHealth, connectionHealthBadge, consentExpiringSoon } from '~/utils/bankTokenLifetime'

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

const { accounts, loading, loaded, removing, saving, pausing, error, load, disconnect, setPaused, setAccount, rowKey } = useBankAccounts()
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

/** Черновики номеров для подключений, ждущих выбора счёта (#407) — по одному на строку. */
const drafts = ref<Record<string, string>>({})

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

    <ul
      v-else-if="accounts.length"
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
                :title="healthBadge(a)!.hint"
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
                label="Привязать счёт"
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
              :disabled="pausing === rowKey(a)"
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
                :disabled="removing === rowKey(a)"
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

    <p class="text-xs text-(--ui-color-base-3)">
      «Пауза» останавливает только автоматический опрос: доступ и подключение сохраняются, и
      возобновить можно тем же нажатием. Отключение убирает доступ приложения к счёту — вернуть его
      сможет только владелец счёта, заново авторизовавшись в интернет-банке. Уже записанные в CRM
      данные остаются в обоих случаях.
    </p>
    <HelpLink
      anchor="pause-gap"
      label="Что будет с операциями за время паузы?"
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
