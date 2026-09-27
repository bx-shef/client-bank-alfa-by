<script setup lang="ts">
import { START_YEAR, copyrightYears } from '~/utils/landing'
import { resolveAuthor } from '~/utils/build'
import BuildSha from '~/components/BuildSha.vue'

// Shared footer: author + a link to the exact build commit.
const { public: { authorName, authorUrl } } = useRuntimeConfig()
// The config keys are empty on purpose; the default lives in resolveAuthor (#758).
const author = resolveAuthor(authorName, authorUrl)

const years = copyrightYears(START_YEAR, new Date().getFullYear())

// No URL ⇒ plain text: a menu item without `to` renders as a <button> that does nothing.
const items = author.url ? [{ label: author.name, to: author.url, target: '_blank' }] : []
</script>

<template>
  <B24Footer class="w-full border-t border-default">
    <template #left>
      <ProseP
        small
        accent="less"
        data-testid="footer-year"
      >
        Copyright © {{ years }}
      </ProseP>
    </template>

    <B24NavigationMenu
      v-if="items.length"
      :items="items"
      variant="link"
    />
    <ProseP
      v-else
      small
      accent="less"
      data-testid="footer-author"
    >
      {{ author.name }}
    </ProseP>

    <template #right>
      <BuildSha />
    </template>
  </B24Footer>
</template>
