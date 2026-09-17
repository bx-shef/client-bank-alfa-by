<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { frameAuth } from '~/composables/useFrameAuth'
import { useSetupStatus } from '~/composables/useSetupStatus'
import { PREVIEW_BANK_MATRIX, useBankMatrix } from '~/composables/useBankMatrix'
import { isPreviewQuery } from '~/utils/inPortalGate'
import { BANK_LABELS } from '~/utils/bankLabels'
import { useBankInvite } from '~/composables/useBankInvite'
import { useSettingsSync } from '~/composables/useSettingsSync'
import { BANK_CONNECTED_COMMAND } from '~/utils/settingsSync'
import { contactLabel } from '~/utils/bankContact'

// Online bank connect (stage 5, A7c). Admin picks the bank and starts the OAuth connect:
// POST /api/bank/connect (frame token) → the backend returns the bank authorize
// URL, which we open in a NEW TAB — opened SYNCHRONOUSLY in the click handler (a window.open after
// the fetch await would be popup-blocked), then pointed at the URL. The bank redirects to our
// callback (A7b-2), which saves the token. Gated on admin (connecting a bank binds credentials to
// the whole portal — the backend also enforces this). Outside the portal frame the card is a preview.
//
// Both banks are offered (A5b added Prior). A provider the server has no env config for is refused
// there with a clean 400 ("… недоступен"), so the picker never needs to know the deployment's config.
//
// Connections ACCUMULATE: the bank-token store is keyed (member_id, provider, account_key), so a
// portal can hold Alfa and Prior and several accounts of each at once — the picker connects ONE more
// account per run, it never replaces the previous one. Manual file upload (/import) is a separate
// path entirely and keeps working regardless. The copy below says so, because "подключить" reads
// like a single exclusive choice otherwise.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
// ⚠ Своим `ref`, а не композаблом: от прежнего `useBankConnect` после снятия самостоятельного
// подключения оставался ровно этот однострочник, и композабл с именем «подключение банка», который
// ничего не подключает, вводил бы в заблуждение вернее, чем его отсутствие.
// Признак один: есть ли фрейм-токен. Нет — карточка это предпросмотр вне портала.
const enabled = ref(false)
function syncEnabled(): void {
  enabled.value = frameAuth() !== null
}
// ⚠ Тот же синглтон, что кормит экран готовности: `client_id` уже приезжает с ним, и второй
// запрос за одним значением был бы лишним обращением в портал на каждом открытии настроек.
const setup = useSetupStatus()

// The list is a child component; after a connect finishes we ask it to re-read. Without this the
// admin returns from the bank tab to a list that still says «пока ничего не подключено» — the exact
// complaint #404 is about, reproduced inside one session.
const connectedList = useTemplateRef<{ reload: () => Promise<void> }>('connectedList')

// Сверка счетов (#494) живёт ЗДЕСЬ, а не внутри блока, который её рисует: тот же ответ нужен и
// списку подключений выше — из него он делает кнопки «выбрать счёт» вместо поля ввода. Один запрос
// на два блока: он ходит в банк, и два запроса означали бы двойной поход плюс риск показать две
// половины экрана, противоречащие друг другу.
const route = useRoute()
const matrix = useBankMatrix()

// ⚠ Вне портала матрица пуста (нет фрейм-токена), поэтому блок сверки не попадал ни в один снимок
// и ни в один визуальный эталон. Под `?preview=1` подставляем синтетическую — ту же роль, что
// `PREVIEW_BANK_ACCOUNTS` играет для списка подключений.
//
// ⚠ Флаг читается из РОУТЕРА, а не из `window.location`: на гидратации пререндеренной страницы
// строка запроса пуста (#555).
//
// ⚠ И проверяется ДВАЖДЫ — реактивно и ещё раз после ответа сети. Вне портала `load()` выходит
// рано и без единого `await`, но ВНУТРИ портала он уходит в сеть и вернулся бы ПОСЛЕ подстановки,
// молча затерев фикстуру. Ровно эту гонку ревью нашло у соседнего списка; повторять её незачем.
const previewMatrix = computed(() => isPreviewQuery(route.query.preview))

function usePreviewMatrix(): void {
  matrix.rows.value = PREVIEW_BANK_MATRIX.rows
  matrix.providers.value = PREVIEW_BANK_MATRIX.providers
  // ⚠ Ошибку тоже гасим. Внутри портала запрос мог УЖЕ упасть (403 не-админу, 409 до конца
  // установки) к моменту, когда адрес со строкой запроса восстановился; без сброса экран рисовал
  // бы красное «Не удалось сверить счета с банком» ОДНОВРЕМЕННО с четырьмя синтетическими строками
  // — то есть заявлял бы и отказ, и его результат (находка ревью).
  matrix.error.value = ''
  matrix.loaded.value = true
}

watch(previewMatrix, (on) => {
  if (on) usePreviewMatrix()
}, { immediate: true })

/** ЕДИНСТВЕННАЯ точка перечитывания сверки — иначе один из трёх вызывающих однажды сходит в сеть
 *  мимо фикстуры и молча сотрёт её на экране предпросмотра (и в визуальном эталоне). */
async function reloadMatrix(): Promise<void> {
  if (previewMatrix.value) {
    usePreviewMatrix()
    return
  }
  await matrix.load()
  if (previewMatrix.value) usePreviewMatrix()
}

onMounted(reloadMatrix)
// Синглтон: повторный `load` на уже загруженном статусе — не второй запрос, а переиспользование.
onMounted(() => {
  void setup.load()
})

const adminChecked = ref(false)

/** The banks that have an online (OAuth) connect path. `manual` is file upload — not connectable,
 *  so the picker's type is the NARROWED union (a `manual` value can't be selected or sent). */
const PROVIDERS = [
  { value: 'alfa-by' as const, label: BANK_LABELS['alfa-by'] },
  { value: 'prior-by' as const, label: BANK_LABELS['prior-by'] }
]
type ConnectableProvider = (typeof PROVIDERS)[number]['value']
const provider = ref<ConnectableProvider>('alfa-by')

onMounted(async () => {
  await useB24().init().catch(() => {})
  // Let useB24 flip its ready flag on nextTick (isInit lags an un-awaited init).
  await nextTick()
  checkAdmin()
  syncEnabled() // resolve frame presence now so the preview note is correct before any click
  adminChecked.value = true
  // Запомненного адресата читаем ПОСЛЕ гейта админа: маршрут админский, и не-админу этот запрос
  // вернул бы 403 — шум в консоли на экране, где ему и так показано предупреждение.
  if (isAdmin.value) await invite.loadContact()

  // ⚠ ЖИВОЕ ОБНОВЛЕНИЕ, а не «обновите страницу»: владелец счёта вводит ключ на СВОЁМ экране, в
  // своём браузере, и у администратора здесь нет ни одного события, из которого он узнал бы об
  // этом. Сервер шлёт `bank.connected` в канал приложения сразу после записи подключения, и
  // открытая карточка перечитывает списки сама.
  // ⚠ Best-effort по построению: канал pull требует скоупа `pull`, и порталы, установленные до
  // его появления, живут со старым грантом до переустановки. Там подписка молча не сработает, а
  // подключение всё равно появится — при следующем открытии настроек.
  if (isAdmin.value) {
    useSettingsSync().subscribeCommand(BANK_CONNECTED_COMMAND, () => {
      void connectedList.value?.reload()
      void reloadMatrix()
      void setup.load()
    })
  }
})

// «Передать владельцу счёта» (#19) — второй, равноправный путь подключения, а не запасной.
// Администратор знает пароль от интернет-банка ДАЛЕКО НЕ ВСЕГДА: у Приора подтверждает доступ сам
// владелец счёта, у Альфы он же выпускает ключ API в своём кабинете. Раньше на это был только
// ручной обход — скопировать ссылку из поля и переслать мессенджером.
const invite = useBankInvite()
/** Подпись «в прошлый раз отправляли …» — пусто, если ещё никому. */
const lastContact = computed(() => contactLabel(invite.contact.value))

async function onHandOver() {
  const user = await invite.pickUser()
  // Закрыли диалог, ничего не выбрав — штатный исход, молчим.
  if (!user) return
  await invite.send(provider.value, user)
}

const chatOpenFailed = ref(false)

async function openChat() {
  chatOpenFailed.value = false
  // ⚠ Штатный метод SDK, а не слайдер по портальному пути `/online/` (замечание владельца
  // 2026-09-17). Адрес мессенджера — деталь портала, а не наш контракт; метод описывает намерение
  // и переживает его смену.
  // ⚠ Отказ ГОВОРИТ О СЕБЕ: вне фрейма просить некого, и молчание здесь неотличимо от сломанной
  // кнопки — ровно та жалоба, что уже была на «Скопировать».
  if (!await useB24().openMessenger()) chatOpenFailed.value = true
}

async function onHandOverAgain() {
  const c = invite.contact.value
  if (!c) return
  await invite.send(provider.value, { id: c.userId, name: c.name ?? '' })
}
</script>

<template>
  <!-- Withhold until the admin check resolves (no fail-open flash to a non-admin). -->
  <p
    v-if="!adminChecked"
    class="text-sm text-(--ui-color-base-3)"
    role="status"
    aria-live="polite"
    data-testid="checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: warning only. -->
  <B24Alert
    v-else-if="inPortal && !isAdmin"
    color="air-primary-warning"
    title="Подключение банка доступно только администратору"
    description="Онлайн-подключение привязывает доступ к банку ко всему порталу — начать его может только администратор Bitrix24."
    data-testid="admin-gate"
  />

  <B24Card
    v-else
    data-testid="bank-connect"
  >
    <template #header>
      <h2 class="font-semibold">
        Онлайн-подключение банка
      </h2>
    </template>

    <div class="space-y-4">
      <!-- What is already bound, with a per-row disconnect (#404). Above the form on purpose:
           the first question after a connect is «что у меня подключено?». -->
      <ConnectedBankAccounts
        ref="connectedList"
        :bank-accounts="matrix.bankAccounts.value"
        @changed="reloadMatrix()"
      />

      <hr class="border-(--ui-color-design-tinted-na-stroke)">

      <!-- Сверка «наш счёт ↔ счёт в банке» (#494). Ниже списка подключений и ВЫШЕ формы: сначала
           «что подключено», потом «сходится ли это с реквизитами», и только потом «подключить ещё».
           На первом боевом прогоне именно этот вопрос остался без ответа — портал отчитался
           «117 обработано, 0 создано», и узнать почему было неоткуда. -->
      <AccountMatrix
        :rows="matrix.rows.value"
        :providers="matrix.providers.value"
        :loading="matrix.loading.value"
        :loaded="matrix.loaded.value"
        :error="matrix.error.value"
      />

      <hr class="border-(--ui-color-design-tinted-na-stroke)">

      <!-- ⚠ ПОДКЛЮЧАЕТ ТОЛЬКО ВЛАДЕЛЕЦ СЧЁТА (решение владельца 2026-09-17). Кнопка «Подключить»,
           поле ключа API и ссылка для ручной пересылки убраны отсюда ЦЕЛИКОМ, у ОБОИХ банков.
           Причина не косметическая: администратор пароля от интернет-банка обычно не знает, а у
           Альфы ключ вдобавок бессрочен и не ротируется — введённый администратором, он навсегда
           оседает у того, кто к счёту отношения не имеет. Оставленные «на всякий случай» кнопки
           сохраняли ровно тот обходной путь, ради закрытия которого всё и делалось. -->
      <p class="text-sm text-(--ui-color-base-2)">
        Подключение делает <b>владелец счёта</b>: приложение отправит ему в чат инструкцию со
        ссылкой. У Приорбанка он подтверждает доступ в интернет-банке, у Альфа-Банка — выпускает
        ключ API в своём кабинете и вставляет его на своём экране. Ключ администратор не видит.
        После подключения останется выбрать счёт в списке выше.
      </p>

      <p class="text-sm text-(--ui-color-base-3)">
        Подключения складываются: Альфа-Банк, Приорбанк и несколько счетов в каждом могут работать
        одновременно — подключайте по одному счёту за раз, предыдущие остаются. Ручная загрузка
        файла выписки доступна всегда и не зависит от онлайн-подключения.
      </p>

      <B24RadioGroup
        v-model="provider"
        legend="Банк"
        color="air-primary"
        orientation="horizontal"
        :items="PROVIDERS"
        data-testid="provider-picker"
      />

      <B24Alert
        v-if="!enabled"
        color="air-primary"
        description="Подключение выполняется внутри портала Bitrix24. Здесь — предпросмотр."
        data-testid="preview-note"
      />

      <!-- ЕДИНСТВЕННЫЙ ПУТЬ ПОДКЛЮЧЕНИЯ: передать его владельцу счёта (#19).
           ⚠ Был «вторым, равноправным» и стоял рядом с кнопкой «Подключить»; кнопку сняли
           (решение владельца 2026-09-17), потому что «равноправный» на практике значило «можно
           и в обход».
           ⚠ Ссылку здесь НЕ показываем: сервер выпускает её и сразу отправляет, иначе её короткий
           срок начал бы течь на экране администратора, а получателю достался бы остаток. -->
      <!-- ⚠ ВИДЕН И ВНЕ ПОРТАЛА, инертным — тот же приём, что у соседней «Опросить сейчас». Пока
           рядом стояла кнопка «Подключить» (она гейта не имела), предпросмотр показывал хоть
           что-то; после её снятия карточка в предпросмотре осталась БЕЗ единственного действия —
           то есть ни на скриншоте, ни в визуальном эталоне проверять стало нечего. -->
      <div
        v-if="isAdmin || !inPortal"
        class="flex flex-col gap-2 border-t border-(--ui-color-base-6) pt-3"
        data-testid="hand-over-block"
      >
        <p class="text-sm text-(--ui-color-base-3)">
          Выберите сотрудника — владельца счёта, и приложение отправит ему инструкцию в чат от
          своего имени. Если счёт ваш, выберите себя.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <B24Button
            :loading="invite.sending.value"
            :disabled="!enabled || invite.sending.value"
            color="air-secondary-accent"
            data-testid="hand-over-button"
            @click="onHandOver"
          >
            Передать владельцу счёта
          </B24Button>
          <B24Button
            v-if="lastContact"
            :disabled="!enabled || invite.sending.value"
            color="air-tertiary"
            data-testid="hand-over-again"
            @click="onHandOverAgain"
          >
            Ещё раз: {{ lastContact }}
          </B24Button>
          <!-- ⚠ Открывает МЕССЕНДЖЕР портала, а не конкретную переписку, и это осознанно. Сообщение
               пишет БОТ приложения получателю, то есть переписка идёт между ботом и им: у
               администратора, отправившего инструкцию другому сотруднику, доступа к ней нет в
               принципе. Глубокая ссылка возможна только в случае «отправил самому себе», и её адрес
               (`IM_DIALOG` с идентификатором бота) мы живьём не проверяли — а кнопка, ведущая не
               туда, хуже кнопки, ведущей в список чатов, где нужное сообщение лежит сверху. -->
          <B24Button
            :disabled="!enabled"
            color="air-tertiary"
            data-testid="open-chat"
            @click="openChat"
          >
            Открыть чат
          </B24Button>
        </div>
        <B24Alert
          v-if="invite.sentTo.value"
          color="air-primary-success"
          :description="`Отправили: ${invite.sentTo.value}. Инструкция и ссылка ушли в чат портала.`"
          data-testid="hand-over-sent"
        />
        <B24Alert
          v-if="invite.error.value"
          color="air-primary-alert"
          :description="invite.error.value"
          data-testid="hand-over-error"
        />
        <B24Alert
          v-if="chatOpenFailed"
          color="air-primary-warning"
          description="Не удалось открыть чат отсюда — откройте мессенджер портала вручную."
          data-testid="open-chat-failed"
        />
      </div>
    </div>
  </B24Card>
</template>
