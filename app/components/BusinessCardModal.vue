<script setup lang="ts">
import DownloadIcon from '@bitrix24/b24icons-vue/actions/DownloadIcon'
import PhoneAddIcon from '@bitrix24/b24icons-vue/solid/PhoneAddIcon'
import CrossLIcon from '@bitrix24/b24icons-vue/outline/CrossLIcon'
import { B24_BOOKING_URL } from '~/utils/booking'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const { reachGoal } = useMetrikaGoal()

// Публичные реквизиты ИП — намеренно хардкодены, это публичная визитка.
const card = {
  name: 'Игорь Шевчик',
  role: 'Импорт выписки и авторазнесение оплат в Bitrix24',
  org: 'ИП Шевчик И. С.',
  unp: 'УНП 192049017',
  phone: '+375 29 736-01-26',
  phoneTel: '+375297360126',
  email: 'offer@bx-shef.by',
  telegram: '@bxshefby',
  // «Реквизиты просто ссылкой» — ведём на страницу с полными реквизитами.
  requisitesUrl: 'https://offer.bx-shef.by/legal',
  callUrl: B24_BOOKING_URL
} as const

const contactSaved = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

// Focus is moved into the dialog on open and restored to the trigger on close.
const closeButton = ref<HTMLButtonElement | null>(null)
let lastFocused: HTMLElement | null = null

watch(() => props.open, (isOpen) => {
  if (!import.meta.client) return
  if (isOpen) {
    lastFocused = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', handleKey)
    document.body.style.overflow = 'hidden'
    nextTick(() => closeButton.value?.focus())
  } else {
    document.removeEventListener('keydown', handleKey)
    document.body.style.overflow = ''
    lastFocused?.focus?.()
    lastFocused = null
  }
}, { immediate: true })

onUnmounted(() => {
  document.removeEventListener('keydown', handleKey)
  document.body.style.overflow = ''
  if (savedTimer) clearTimeout(savedTimer)
})

function handleKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}

function onBackdropClick(e: MouseEvent) {
  if ((e.target as HTMLElement).dataset.backdrop) emit('close')
}

function downloadVCard() {
  const vcf = buildVCard({
    fullName: card.name,
    lastName: 'Шевчик',
    firstName: 'Игорь',
    middleName: 'Сергеевич',
    org: card.org,
    title: card.role,
    phoneTel: card.phoneTel,
    email: card.email,
    url: 'https://offer.bx-shef.by',
    note: `Импорт выписки клиент-банка в Bitrix24. ${card.unp}.`
  })

  const blob = new Blob([vcf], { type: 'text/vcard;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: 'igor-shevchik.vcf' })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)

  reachGoal('card_vcard')
  contactSaved.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => (contactSaved.value = false), 2200)
}
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0"
      enter-to-class="opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="opacity-0"
    >
      <div
        v-if="open"
        data-backdrop="1"
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
        @click="onBackdropClick"
      >
        <div
          data-testid="business-card"
          role="dialog"
          aria-modal="true"
          aria-labelledby="business-card-name"
          class="relative w-full max-w-[520px] rounded-3xl border border-(--b24ui-color-design-tinted-na-stroke) bg-(--b24ui-color-bg-content-primary) p-8 shadow-2xl"
        >
          <button
            ref="closeButton"
            type="button"
            class="absolute right-4 top-4 flex size-8 items-center justify-center rounded-xl text-(--b24ui-color-text-secondary) transition-colors hover:bg-(--b24ui-color-bg-content-secondary)"
            aria-label="Закрыть"
            @click="emit('close')"
          >
            <CrossLIcon class="size-4" />
          </button>

          <div class="flex flex-col items-center gap-4 text-center">
            <img
              src="/igor.jpg"
              alt="Игорь Шевчик"
              width="88"
              height="88"
              class="size-20 rounded-full object-cover"
              loading="lazy"
            >
            <div>
              <h2
                id="business-card-name"
                class="text-xl font-semibold"
              >
                {{ card.name }}
              </h2>
              <p class="mt-1 max-w-[280px] text-sm text-(--b24ui-color-text-secondary)">
                {{ card.role }}
              </p>
              <p class="mt-2 font-mono text-xs text-(--b24ui-color-text-secondary) opacity-70">
                {{ card.org }} · {{ card.unp }}
              </p>
            </div>
          </div>

          <ul class="mt-6 flex flex-col gap-2 text-sm">
            <li>
              <a
                :href="`tel:${card.phoneTel}`"
                class="flex items-center justify-between gap-3 rounded-xl border border-(--b24ui-color-design-tinted-na-stroke) px-4 py-2.5 transition-colors hover:bg-(--b24ui-color-bg-content-secondary)"
              >
                <span class="text-(--b24ui-color-text-secondary)">Телефон</span>
                <span class="font-mono">{{ card.phone }}</span>
              </a>
            </li>
            <li>
              <a
                :href="`mailto:${card.email}`"
                class="flex items-center justify-between gap-3 rounded-xl border border-(--b24ui-color-design-tinted-na-stroke) px-4 py-2.5 transition-colors hover:bg-(--b24ui-color-bg-content-secondary)"
              >
                <span class="text-(--b24ui-color-text-secondary)">Email</span>
                <span>{{ card.email }}</span>
              </a>
            </li>
            <li>
              <a
                :href="`https://t.me/${card.telegram.replace('@', '')}`"
                target="_blank"
                rel="noopener noreferrer"
                class="flex items-center justify-between gap-3 rounded-xl border border-(--b24ui-color-design-tinted-na-stroke) px-4 py-2.5 transition-colors hover:bg-(--b24ui-color-bg-content-secondary)"
              >
                <span class="text-(--b24ui-color-text-secondary)">Telegram</span>
                <span class="font-mono">{{ card.telegram }}</span>
              </a>
            </li>
          </ul>

          <div class="mt-4 flex flex-col gap-2.5">
            <B24Button
              label="Назначить созвон"
              :to="card.callUrl"
              target="_blank"
              color="air-primary"
              block
              @click="reachGoal('booking_click')"
            />
            <div class="grid grid-cols-2 gap-2.5">
              <B24Button
                :label="contactSaved ? 'Готово' : 'Контакт'"
                :icon="PhoneAddIcon"
                color="air-secondary-no-accent"
                block
                @click="downloadVCard"
              />
              <B24Button
                label="Реквизиты"
                :icon="DownloadIcon"
                :to="card.requisitesUrl"
                target="_blank"
                color="air-secondary-no-accent"
                block
                @click="reachGoal('card_requisites')"
              />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
