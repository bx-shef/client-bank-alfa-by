<script setup lang="ts">
import { ref } from 'vue'
import { FAQ, FAQ_INTRO, FAQ_AGENT_PROMPT } from '~/utils/faq'
import { pageTitle } from '~/utils/landing'
import { copyToClipboard } from '~/utils/clipboard'

// Справка приложения (#576 п.1).
//
// ⚠ Страница ПУБЛИЧНАЯ (в `PUBLIC_ROUTES`, индексируется), но layout у неё `portal`, а не
// `landing`, и это не оплошность. Её открывают из ДВУХ мест: ссылкой из карточки Маркета и
// контекстной кнопкой «Что это значит?» внутри портала, где она рисуется в слайдере рядом с
// настройками. Тёмная брендовая оболочка лендинга в слайдере портала выглядела бы чужой страницей,
// а светлая тема b24ui — своей в обоих случаях.
//
// ⚠ `InPortalGate` здесь НЕ нужен и был бы вреден: гейт закрывает страницы, которым нечего
// показать без фрейм-токена, а справка — чистый текст и работает где угодно. Закрыв её гейтом, мы
// сделали бы недоступной ровно ту страницу, ссылку на которую даём людям, у которых что-то не
// работает.
definePageMeta({ layout: 'portal' })

usePublicPageSeo({
  route: '/help',
  title: pageTitle('Справка'),
  description: 'Ответы на частые вопросы про импорт банковской выписки в Bitrix24: почему дела '
    + 'попадают в «мою компанию», как исключить платежи, как поставить загрузку на паузу.'
})

const copied = ref(false)

async function copyPrompt(): Promise<void> {
  copied.value = await copyToClipboard(FAQ_AGENT_PROMPT)
}
</script>

<template>
  <div class="mx-auto w-full max-w-[820px] px-4 py-8 flex flex-col gap-6">
    <div class="flex flex-col gap-2">
      <h1 class="text-2xl font-semibold">
        Справка
      </h1>
      <p class="text-base opacity-80">
        {{ FAQ_INTRO }}
      </p>
    </div>

    <!-- Оглавление: страница длинная, а приходят на неё с одним конкретным вопросом. -->
    <nav
      data-testid="faq-toc"
      class="flex flex-col gap-1"
    >
      <a
        v-for="entry in FAQ"
        :key="entry.id"
        :href="`#${entry.id}`"
        class="text-sm underline underline-offset-2 opacity-80 hover:opacity-100"
      >{{ entry.question }}</a>
    </nav>

    <section
      v-for="entry in FAQ"
      :id="entry.id"
      :key="entry.id"
      data-testid="faq-entry"
      class="flex flex-col gap-2 scroll-mt-6"
    >
      <h2 class="text-lg font-semibold">
        {{ entry.question }}
      </h2>
      <p
        v-for="(p, i) in entry.answer"
        :key="i"
        class="text-base leading-relaxed opacity-90"
      >
        {{ p }}
      </p>
    </section>

    <B24Card data-testid="faq-agent">
      <div class="flex flex-col gap-3">
        <h2 class="text-lg font-semibold">
          Для ИИ-помощника
        </h2>
        <p class="text-sm opacity-80">
          Если вы пользуетесь ИИ-помощником, дайте ему эту инструкцию — он будет отвечать по этой
          справке, а не выдумывать названия кнопок.
        </p>
        <pre class="text-xs whitespace-pre-wrap opacity-90">{{ FAQ_AGENT_PROMPT }}</pre>
        <div>
          <B24Button
            :label="copied ? 'Скопировано' : 'Скопировать инструкцию'"
            size="sm"
            @click="copyPrompt"
          />
        </div>
      </div>
    </B24Card>

    <BuildFooter />
  </div>
</template>
