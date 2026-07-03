<script setup lang="ts">
// Sticky-CTA для мобильных: главный призыв «Оставить заявку» всегда под пальцем.
// Появляется, когда hero ушёл из вида, и прячется, когда форма на экране
// (иначе кнопка перекрывала бы саму форму, к которой ведёт).
const show = ref(false)
const { reachGoal } = useMetrikaGoal()

let pastHero = false
let briefInView = false
let heroObs: IntersectionObserver | null = null
let briefObs: IntersectionObserver | null = null

function update() {
  show.value = pastHero && !briefInView
}

onMounted(() => {
  // Guard for SSR/test environments (happy-dom) without IntersectionObserver.
  if (typeof IntersectionObserver === 'undefined') return

  const hero = document.getElementById('hero')
  const brief = document.getElementById('brief')

  if (hero) {
    heroObs = new IntersectionObserver((entries) => {
      const e = entries[0]
      if (e) pastHero = !e.isIntersecting
      update()
    })
    heroObs.observe(hero)
  }

  if (brief) {
    briefObs = new IntersectionObserver((entries) => {
      const e = entries[0]
      if (e) briefInView = e.isIntersecting
      update()
    })
    briefObs.observe(brief)
  }
})

onUnmounted(() => {
  heroObs?.disconnect()
  briefObs?.disconnect()
})
</script>

<template>
  <Transition
    enter-active-class="transition duration-200 ease-out"
    enter-from-class="opacity-0 translate-y-full"
    enter-to-class="opacity-100 translate-y-0"
    leave-active-class="transition duration-150 ease-in"
    leave-from-class="opacity-100 translate-y-0"
    leave-to-class="opacity-0 translate-y-full"
  >
    <div
      v-if="show"
      class="sm:hidden fixed inset-x-0 bottom-0 z-40 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-gradient-to-t from-black/85 via-black/65 to-transparent"
    >
      <a
        href="#brief"
        class="flex items-center justify-center gap-2 w-full h-14 rounded-xl text-base font-semibold transition-all duration-200 active:brightness-95"
        style="background: rgb(var(--color-accent-primary-ch)); color: #0a1220; box-shadow: 0 0 28px rgb(var(--color-accent-primary-ch)/0.35);"
        @click="reachGoal('sticky_cta_click')"
      >
        Оставить заявку на установку
      </a>
    </div>
  </Transition>
</template>
