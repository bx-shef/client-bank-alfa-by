<script setup lang="ts">
import QRCode from 'qrcode'
import PhoneAddIcon from '@bitrix24/b24icons-vue/solid/PhoneAddIcon'
import TelegramIcon from '@bitrix24/b24icons-vue/social/TelegramIcon'
import CrossLIcon from '@bitrix24/b24icons-vue/outline/CrossLIcon'
import CheckLIcon from '@bitrix24/b24icons-vue/outline/CheckLIcon'
import FingerprintIcon from '@bitrix24/b24icons-vue/outline/FingerprintIcon'
import CopyIcon from '@bitrix24/b24icons-vue/outline/CopyIcon'
import ReceiptIcon from '@bitrix24/b24icons-vue/outline/ReceiptIcon'
import { B24_BOOKING_URL } from '~/utils/booking'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const qrDataUrl = ref('')
// Отдельный высококонтрастный QR (тёмный на белом) для мобильного hold-to-reveal —
// его нужно реально сканировать, в отличие от декоративного белого-на-прозрачном.
const qrScanUrl = ref('')
const contactAdded = ref(false)
const linkCopied = ref(false)
// Удержание кнопки на мобиле показывает QR во весь попап (как «глазик» на пароле).
const showQr = ref(false)
let feedbackTimer: ReturnType<typeof setTimeout> | null = null
let copyTimer: ReturnType<typeof setTimeout> | null = null
// Цель Метрики на показ QR — один раз за открытие, чтобы повторные удержания
// не дублировали событие.
let qrRevealed = false

const { reachGoal } = useMetrikaGoal()

// Focus management for the modal dialog: move focus into the card on open,
// trap Tab inside it, and restore focus to the trigger on close (a11y).
const cardEl = ref<HTMLElement | null>(null)
let lastFocused: HTMLElement | null = null

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
  // QR/сайт визитки ведут на этот лендинг (продукт), реквизиты/почта — на общий ИП.
  site: 'bank-import.bx-shef.by',
  // «Реквизиты просто ссылкой» — на страницу с полными реквизитами.
  requisitesUrl: 'https://offer.bx-shef.by/legal',
  // Ссылка онлайн-записи Б24 — общий модуль (используется и в hero).
  callUrl: B24_BOOKING_URL
} as const

// Генерируем оба QR один раз при маунте компонента.
onMounted(async () => {
  const target = 'https://' + card.site
  try {
    // Десктоп: декоративный белый-на-прозрачном, вписан в тёмную тему карточки.
    qrDataUrl.value = await QRCode.toDataURL(target, {
      width: 180,
      margin: 1,
      color: { dark: '#ffffff', light: '#00000000' },
      errorCorrectionLevel: 'M'
    })
    // Мобильный reveal: тёмный на белом, крупнее — под реальное сканирование.
    qrScanUrl.value = await QRCode.toDataURL(target, {
      width: 260,
      margin: 2,
      color: { dark: '#0a1220', light: '#ffffff' },
      errorCorrectionLevel: 'M'
    })
  } catch {
    // QR остаётся '', пользователь видит skeleton — не критично.
  }
})

// Scroll-lock и keyboard-trap привязаны к состоянию open, а не к маунту.
watch(() => props.open, (isOpen) => {
  if (!import.meta.client) return
  if (isOpen) {
    lastFocused = document.activeElement as HTMLElement | null
    document.addEventListener('keydown', handleKey)
    document.body.style.overflow = 'hidden'
    // Focus the first focusable in the dialog after it renders.
    nextTick(() => focusables()[0]?.focus())
  } else {
    document.removeEventListener('keydown', handleKey)
    document.body.style.overflow = ''
    // Restore focus to the element that opened the modal.
    lastFocused?.focus?.()
    lastFocused = null
    // Сброс при закрытии: иначе если закрыть, удерживая QR, при следующем
    // открытии overlay покажется сразу (pointerup уже не придёт — DOM снят).
    showQr.value = false
    qrRevealed = false
  }
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKey)
  document.body.style.overflow = ''
  if (feedbackTimer) clearTimeout(feedbackTimer)
  if (copyTimer) clearTimeout(copyTimer)
})

// All focusable elements currently inside the card (excludes disabled/hidden).
function focusables(): HTMLElement[] {
  if (!cardEl.value) return []
  return Array.from(
    cardEl.value.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])'
    )
  ).filter(el => el.offsetParent !== null)
}

function handleKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  // Focus trap: keep Tab cycling inside the dialog.
  if (e.key === 'Tab') {
    const items = focusables()
    if (!items.length) return
    const first = items[0]!
    const last = items[items.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

// Hold-to-reveal QR: pointer capture удерживает событие на кнопке, даже если
// палец сместился — отпускание гарантированно скрывает QR обратно.
function startQr(e: PointerEvent) {
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture?.(e.pointerId)
  showQr.value = true
  if (!qrRevealed) {
    qrRevealed = true
    reachGoal('card_qr_reveal')
  }
}

function stopQr() {
  showQr.value = false
}

async function copyCallLink() {
  // copyToClipboard — общий util (app/utils/clipboard.ts), авто-импорт.
  const ok = await copyToClipboard(card.callUrl)
  if (!ok) return
  linkCopied.value = true
  reachGoal('card_copy_link')
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => (linkCopied.value = false), 2200)
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
    url: 'https://' + card.site,
    note: `Импорт выписки клиент-банка в Bitrix24. ${card.unp}.`
  })

  triggerDownload(new Blob([vcf], { type: 'text/vcard;charset=utf-8' }), 'igor-shevchik.vcf')

  contactAdded.value = true
  reachGoal('card_vcard')
  if (feedbackTimer) clearTimeout(feedbackTimer)
  // 2.2 с — достаточно чтобы прочесть «Контакт сохранён» и не затягивать.
  feedbackTimer = setTimeout(() => (contactAdded.value = false), 2200)
}

// Вставляем <a> в DOM перед кликом — без этого Firefox не скачивает text/vcard.
// revokeObjectURL через setTimeout — Safari читает blob асинхронно.
function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = Object.assign(document.createElement('a'), { href: url, download: filename })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <!-- v-if живёт здесь, а не в родителе — чтобы leave-анимация отрабатывала. -->
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
        class="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-black/70 backdrop-blur-sm"
        @click="onBackdropClick"
      >
        <!-- Card -->
        <Transition
          appear
          enter-active-class="transition duration-[250ms] ease-out"
          enter-from-class="opacity-0 scale-95 translate-y-2"
          enter-to-class="opacity-100 scale-100 translate-y-0"
        >
          <div
            ref="cardEl"
            data-testid="business-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="business-card-name"
            class="relative w-full max-w-[680px] rounded-3xl overflow-hidden shadow-2xl"
            style="background: linear-gradient(135deg, rgba(15,22,36,0.98) 0%, rgba(10,18,30,0.98) 100%); border: 1px solid rgba(255,255,255,0.1);"
          >
            <!-- Glow accent top -->
            <div
              class="absolute inset-x-0 top-0 h-px"
              style="background: linear-gradient(90deg, transparent, rgb(var(--color-accent-primary-ch)/0.8), transparent);"
            />

            <!-- Close -->
            <button
              type="button"
              class="absolute top-4 right-4 z-10 flex items-center justify-center size-8 rounded-xl text-white/40 hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Закрыть"
              @click="emit('close')"
            >
              <CrossLIcon class="size-4" />
            </button>

            <!-- Mobile QR overlay — виден только пока удерживается кнопка снизу. -->
            <div
              v-if="showQr"
              class="sm:hidden absolute inset-0 z-30 flex flex-col items-center justify-center gap-5 px-6"
              style="background: linear-gradient(135deg, rgba(15,22,36,0.99) 0%, rgba(10,18,30,0.99) 100%);"
            >
              <div class="text-[10px] uppercase tracking-[0.18em] text-white/40 font-mono">
                Сканируйте
              </div>
              <div class="p-4 rounded-2xl bg-white shadow-2xl">
                <img
                  v-if="qrScanUrl"
                  :src="qrScanUrl"
                  :alt="`QR-код ${card.site}`"
                  class="size-[240px] block"
                >
                <div
                  v-else
                  class="size-[240px] rounded bg-black/5 animate-pulse"
                />
              </div>
              <div class="text-xs text-white/50 font-mono">
                {{ card.site }}
              </div>
            </div>

            <div class="flex flex-col sm:flex-row">
              <!-- LEFT: QR + avatar -->
              <div
                class="flex flex-col items-center justify-center gap-5 px-8 pt-10 pb-5 sm:py-12 sm:w-[220px] shrink-0"
                style="background: linear-gradient(160deg, rgba(var(--color-accent-primary-ch)/0.08) 0%, rgba(0,0,0,0) 70%);"
              >
                <!-- Photo -->
                <img
                  src="/igor.jpg"
                  alt="Игорь Шевчик"
                  class="size-20 rounded-full object-cover border-2 shadow-lg shrink-0"
                  style="border-color: rgb(var(--color-accent-primary-ch)/0.5); box-shadow: 0 0 28px rgb(var(--color-accent-primary-ch)/0.2);"
                  loading="eager"
                >

                <!-- QR Code -->
                <div
                  class="hidden sm:block relative p-3 rounded-2xl"
                  style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); box-shadow: 0 0 32px rgb(var(--color-accent-primary-ch)/0.12);"
                >
                  <img
                    v-if="qrDataUrl"
                    :src="qrDataUrl"
                    :alt="`QR-код ${card.site}`"
                    class="size-[120px] block"
                  >
                  <div
                    v-else
                    class="size-[120px] rounded-lg bg-white/5 animate-pulse"
                  />
                </div>

                <div class="hidden sm:block text-center">
                  <div class="text-[10px] uppercase tracking-[0.18em] text-white/30 font-mono">
                    Сканируй
                  </div>
                  <div class="text-xs text-white/50 font-mono mt-0.5">
                    {{ card.site }}
                  </div>
                </div>
              </div>

              <!-- Divider -->
              <div class="hidden sm:block w-px self-stretch my-8 bg-white/[0.07]" />
              <div class="sm:hidden h-px mx-8 bg-white/[0.07]" />

              <!-- RIGHT: Details -->
              <div class="flex flex-col justify-center gap-6 px-8 pt-5 pb-10 sm:py-12 flex-1 min-w-0">
                <!-- Name & title -->
                <div>
                  <h2
                    id="business-card-name"
                    class="text-2xl font-bold text-white tracking-tight leading-tight"
                  >
                    {{ card.name }}
                  </h2>
                  <p class="mt-1 text-sm text-white/50 leading-snug max-w-[240px]">
                    {{ card.role }}
                  </p>
                  <p class="mt-2 text-xs font-mono text-white/30">
                    {{ card.org }} · {{ card.unp }}
                  </p>
                </div>

                <!-- Contacts -->
                <!-- PhoneIcon и MailIcon отсутствуют в b24icons — используем inline SVG. -->
                <ul class="flex flex-col gap-2.5">
                  <li>
                    <a
                      :href="`tel:${card.phoneTel}`"
                      class="group flex items-center gap-3 text-sm text-white/70 hover:text-white transition-colors"
                    >
                      <span
                        class="flex items-center justify-center size-8 rounded-lg shrink-0 transition-colors"
                        style="background: rgba(var(--color-accent-primary-ch)/0.12);"
                      >
                        <svg
                          class="size-4"
                          :style="{ color: 'rgb(var(--color-accent-primary-ch))' }"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 8.63 19.79 19.79 0 01.01 5.01 2 2 0 012 2.84l3-.01a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z" />
                        </svg>
                      </span>
                      <span class="font-mono">{{ card.phone }}</span>
                    </a>
                  </li>
                  <li>
                    <a
                      :href="`mailto:${card.email}`"
                      class="group flex items-center gap-3 text-sm text-white/70 hover:text-white transition-colors"
                    >
                      <span
                        class="flex items-center justify-center size-8 rounded-lg shrink-0"
                        style="background: rgba(var(--color-accent-primary-ch)/0.12);"
                      >
                        <svg
                          class="size-4"
                          :style="{ color: 'rgb(var(--color-accent-primary-ch))' }"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          stroke-width="1.8"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        >
                          <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                          <polyline points="22,6 12,13 2,6" />
                        </svg>
                      </span>
                      <span>{{ card.email }}</span>
                    </a>
                  </li>
                  <li>
                    <a
                      :href="`https://t.me/${card.telegram.replace('@', '')}`"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="group flex items-center gap-3 text-sm text-white/70 hover:text-white transition-colors"
                    >
                      <span
                        class="flex items-center justify-center size-8 rounded-lg shrink-0"
                        style="background: rgba(var(--color-accent-primary-ch)/0.12);"
                      >
                        <TelegramIcon
                          class="size-4"
                          :style="{ color: 'rgb(var(--color-accent-primary-ch))' }"
                        />
                      </span>
                      <span class="font-mono">{{ card.telegram }}</span>
                    </a>
                  </li>
                </ul>

                <!-- Actions -->
                <div class="flex flex-col gap-2.5">
                  <!-- Главный CTA + копирование ссылки — сегментированная пара. -->
                  <div
                    class="flex items-stretch w-full rounded-xl overflow-hidden"
                    style="box-shadow: 0 0 24px rgb(var(--color-accent-primary-ch)/0.25);"
                  >
                    <a
                      :href="card.callUrl"
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="Назначить созвон — выбрать время (откроется в новой вкладке)"
                      class="flex flex-1 items-center justify-center gap-2.5 h-11 text-sm font-semibold transition-all duration-200 hover:brightness-110"
                      style="background: rgb(var(--color-accent-primary-ch)); color: #0a1220;"
                      @click="reachGoal('booking_click')"
                    >
                      <svg
                        class="size-4 shrink-0"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1.8"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                      >
                        <rect
                          x="3"
                          y="4"
                          width="18"
                          height="18"
                          rx="2"
                        />
                        <line
                          x1="16"
                          y1="2"
                          x2="16"
                          y2="6"
                        />
                        <line
                          x1="8"
                          y1="2"
                          x2="8"
                          y2="6"
                        />
                        <line
                          x1="3"
                          y1="10"
                          x2="21"
                          y2="10"
                        />
                      </svg>
                      <span>Назначить созвон</span>
                    </a>
                    <button
                      type="button"
                      :aria-label="linkCopied ? 'Ссылка скопирована' : 'Скопировать ссылку на созвон'"
                      class="flex items-center justify-center w-12 shrink-0 h-11 transition-all duration-200 hover:brightness-110"
                      style="background: rgb(var(--color-accent-primary-ch)); color: #0a1220; border-left: 1px solid rgba(10,18,30,0.4);"
                      @click="copyCallLink"
                    >
                      <component
                        :is="linkCopied ? CheckLIcon : CopyIcon"
                        class="size-4"
                      />
                    </button>
                  </div>

                  <!-- Вторичные действия: vCard-контакт + реквизиты внешней ссылкой. -->
                  <B24FieldGroup
                    size="sm"
                    class="w-full"
                  >
                    <B24Button
                      :icon="contactAdded ? CheckLIcon : PhoneAddIcon"
                      :label="contactAdded ? 'Готово' : 'Контакт'"
                      color="air-tertiary-no-accent"
                      aria-label="Добавить в контакты (vCard)"
                      class="flex-1 justify-center"
                      @click="downloadVCard"
                    />
                    <B24Button
                      :icon="ReceiptIcon"
                      label="Реквизиты"
                      color="air-tertiary-no-accent"
                      :to="card.requisitesUrl"
                      target="_blank"
                      aria-label="Реквизиты (откроется в новой вкладке)"
                      class="flex-1 justify-center"
                      @click="reachGoal('card_requisites')"
                    />
                  </B24FieldGroup>

                  <!-- QR hold-to-reveal — круглая кнопка-«отпечаток» (mobile only). -->
                  <div class="sm:hidden relative z-40 flex flex-col items-center gap-2 pt-1">
                    <button
                      type="button"
                      class="flex items-center justify-center size-16 rounded-full transition-all duration-200 select-none touch-none active:scale-95"
                      :style="showQr
                        ? 'background: rgba(var(--color-accent-primary-ch)/0.22); border: 1px solid rgba(var(--color-accent-primary-ch)/0.6); box-shadow: 0 0 28px rgb(var(--color-accent-primary-ch)/0.35); -webkit-touch-callout: none;'
                        : 'background: rgba(var(--color-accent-primary-ch)/0.1); border: 1px solid rgba(var(--color-accent-primary-ch)/0.3); -webkit-touch-callout: none;'"
                      aria-label="Показать QR-код для сканирования — удерживайте"
                      @pointerdown.prevent="startQr"
                      @pointerup="stopQr"
                      @pointercancel="stopQr"
                      @contextmenu.prevent
                    >
                      <FingerprintIcon
                        class="size-8"
                        :style="{ color: 'rgb(var(--color-accent-primary-ch))' }"
                      />
                    </button>
                    <span class="text-[11px] font-mono text-white/40">
                      {{ showQr ? 'Отпустите' : 'Удерживайте — покажет QR' }}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <!-- Bottom accent line -->
            <div
              class="absolute inset-x-0 bottom-0 h-px"
              style="background: linear-gradient(90deg, transparent, rgba(var(--color-accent-partner-ch)/0.4), transparent);"
            />
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
