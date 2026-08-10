<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useB24 } from '~/composables/useB24'
import { useIsAdmin } from '~/composables/useIsAdmin'
import { useChatSettings } from '~/composables/useChatSettings'
import { usePortalSlider } from '~/composables/usePortalSlider'
import { useProvisionDistribution } from '~/composables/useProvisionDistribution'
import { paymentSpEtid, distributionSpEtid, smartProcessListPath } from '~/config/distributionSp'

// Смарт-процессы распределения (#109 §9.1): состояние + кнопка настройки.
//
// Состояние читается СРАЗУ из настроек портала — их id уже хранятся там после провижининга, так что
// отдельный запрос не нужен. Если оба на месте, кнопки «Настроить» нет вовсе: предлагать действие,
// которое уже выполнено, — значит заставлять гадать, надо ли его нажимать. Вместо неё — ссылки на
// сами смарт-процессы, чтобы можно было заглянуть внутрь.
//
// Гейт админа продублирован здесь (без fail-open мигания), авторитет — на backend.
const { inPortal, isAdmin, check: checkAdmin } = useIsAdmin()
const { provision, syncEnabled, provisioning, error, message, enabled, paymentSpEtid: freshPayment, distributionSpEtid: freshDistribution } = useProvisionDistribution()
const chatSettings = useChatSettings()
const slider = usePortalSlider()

const adminChecked = ref(false)

/** id из настроек портала; сразу после провижининга — из его же ответа (настройки перечитываются
 *  не мгновенно, а показать ссылки хочется тут же). */
const paymentEtid = computed(() =>
  freshPayment.value ?? paymentSpEtid(chatSettings.settings.recognition?.configFields))
const distributionEtid = computed(() =>
  freshDistribution.value ?? distributionSpEtid(chatSettings.settings.recognition?.configFields))

/** Оба на месте — настраивать нечего. */
const ready = computed(() => paymentEtid.value !== null && distributionEtid.value !== null)

// Адрес строится через `slider.getUrl` — он даёт АБСОЛЮТНЫЙ адрес портала. Относительный путь
// браузер отрезолвил бы на домен приложения (bank-import…), а не портала, и ссылка вела бы в 404.
// Вне фрейма домен портала неизвестен, поэтому ссылок там нет вовсе (см. шаблон).
const links = computed(() => [
  { label: 'Платежи', etid: paymentEtid.value },
  { label: 'Распределения', etid: distributionEtid.value }
]
  .filter((l): l is { label: string, etid: number } => l.etid !== null)
  .map(l => ({ ...l, href: slider.resolveUrl(smartProcessListPath(l.etid)) })))

onMounted(async () => {
  await useB24().init().catch(() => {})
  await nextTick()
  checkAdmin()
  syncEnabled()
  adminChecked.value = true
})

/** Внутри портала открываем слайдером поверх страницы, иначе уводили бы весь iframe. Не удалось —
 *  отдаём клик браузеру: у ссылки есть настоящий href, пользователь не остаётся ни с чем. */
async function openSp(event: MouseEvent, etid: number, href: string) {
  if (!slider.inFrame()) return
  event.preventDefault()
  // Слайдер открывает сущность ПОВЕРХ портала — обычный переход увёл бы весь iframe с настройками.
  const opened = await slider.openPath(smartProcessListPath(etid))
  // Не получилось (устройство не поддерживает слайдер) — уводим в новую вкладку по абсолютному
  // адресу портала, чтобы пользователь не остался ни с чем.
  if (!opened) window.open(href, '_blank', 'noopener')
}
</script>

<template>
  <!-- Withhold until the admin check resolves (no fail-open flash to a non-admin). -->
  <p
    v-if="!adminChecked"
    class="text-sm text-(--ui-color-base-3)"
    role="status"
    aria-live="polite"
    data-testid="provision-checking"
  >
    Проверка доступа…
  </p>

  <!-- Non-admin in the portal: nothing to show (provisioning is an admin action). -->
  <template v-else-if="inPortal && !isAdmin" />

  <B24Card
    v-else
    data-testid="provision-sp"
  >
    <template #header>
      <h2 class="font-semibold">
        Смарт-процессы распределения
      </h2>
    </template>

    <div class="space-y-4">
      <!-- Всё настроено: вместо кнопки — подтверждение и ссылки внутрь. -->
      <template v-if="ready">
        <B24Alert
          color="air-primary-success"
          description="Смарт-процессы для учёта распределения платежей настроены. Приложение хранит разнесение оплат в них."
          data-testid="provision-ready"
        />
        <div class="flex flex-wrap items-center gap-3 text-sm">
          <a
            v-for="l in links.filter(x => x.href)"
            :key="l.etid"
            :href="l.href!"
            class="underline decoration-dotted underline-offset-2"
            :data-testid="`sp-link-${l.label}`"
            @click="openSp($event, l.etid, l.href!)"
          >{{ l.label }}</a>
        </div>
      </template>

      <template v-else>
        <p class="text-sm text-(--ui-color-base-2)">
          Создать два служебных смарт-процесса для учёта распределения платежей — «платежи» и
          «распределения». Приложение хранит в них разнесение оплат вместо своей базы.
          Действие идемпотентно: повторный запуск ничего не дублирует.
        </p>

        <B24Alert
          v-if="!enabled"
          color="air-primary"
          description="Настройка выполняется внутри портала Bitrix24. Здесь — предпросмотр."
          data-testid="provision-preview-note"
        />

        <B24Button
          :loading="provisioning"
          :disabled="provisioning"
          :aria-busy="provisioning"
          color="air-primary"
          data-testid="provision-button"
          @click="provision"
        >
          Настроить смарт-процессы
        </B24Button>
      </template>

      <div
        role="alert"
        aria-live="assertive"
      >
        <B24Alert
          v-if="error"
          color="air-primary-alert"
          :description="error"
          data-testid="provision-error"
        />
      </div>
      <div
        role="status"
        aria-live="polite"
      >
        <B24Alert
          v-if="!error && message"
          color="air-primary-success"
          :description="message"
          data-testid="provision-message"
        />
      </div>
    </div>
  </B24Card>
</template>
