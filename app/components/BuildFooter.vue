<script setup lang="ts">
import { START_YEAR, copyrightYears } from '~/utils/landing'
import BuildSha from '~/components/BuildSha.vue'

// Shared footer: author + a link to the exact build commit.
const { public: { authorName, authorUrl } } = useRuntimeConfig()

const years = copyrightYears(START_YEAR, new Date().getFullYear())

const items = [
  {
    label: authorName,
    to: authorUrl,
    target: '_blank'
  }
]
</script>

<template>
  <B24Footer class="w-full border-t border-default min-h-0">
    <template #left>
      <ProseP
        small
        accent="less"
      >
        Copyright © {{ years }}
      </ProseP>
    </template>

    <B24NavigationMenu
      :items="items"
      variant="link"
    />

    <template #right>
      <BuildSha />
    </template>
  </B24Footer>
</template>
