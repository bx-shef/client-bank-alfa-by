// b24ui's `useColorMode()` reads color-mode settings from the TOP LEVEL of the
// app config — the module itself only writes `appConfig.b24ui`/`version`, so
// without these keys `useColorMode()` returns a no-op stub and the theme toggle
// does nothing. `auto` follows the OS on first visit; the choice is persisted
// under `vueuse-color-scheme` (the composable's default).
export default defineAppConfig({
  colorMode: true,
  colorModeInitialValue: 'auto'
})
