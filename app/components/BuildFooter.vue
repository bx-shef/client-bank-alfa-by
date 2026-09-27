<script setup lang="ts">
import { START_YEAR, copyrightYears } from '~/utils/landing'
import { resolveAuthor } from '~/utils/build'
import BuildSha from '~/components/BuildSha.vue'

// Shared footer: author + a link to the exact build commit.
const { public: { authorName, authorUrl } } = useRuntimeConfig()
// Empty build variables override the config defaults, so the fallback lives here too (#758).
const author = resolveAuthor(authorName, authorUrl)

const years = copyrightYears(START_YEAR, new Date().getFullYear())

const items = [
  author.url
    ? { label: author.name, to: author.url, target: '_blank' }
    : { label: author.name }
]
</script>

<template>
  <B24Footer class="w-full border-t border-default">
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
