// Minimal ESM resolve hook so dev scripts run with Node's native TS
// type-stripping can import app modules that use the Nuxt `~/` alias at RUNTIME
// (value imports, e.g. app/utils/oneCStatement.ts → `~/utils/clientBankStatement`).
// Type-only `~/` imports are erased by type-stripping and never reach a resolver,
// so only value imports need this. Preloaded via `node --import`.
//
// `~/x` → <repo>/app/x (with a `.ts` extension appended when none is given).
//
// Requires Node >= 22.15 (synchronous `module.registerHooks`). Dev-only, not part
// of the SSG/prod build; CI and containers run current 22.x, so this is safe.

import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath } from 'node:path'

const appDir = resolvePath(import.meta.dirname, '../../app')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~/')) {
      let rel = specifier.slice(2)
      if (!/\.[a-z0-9]+$/i.test(rel)) rel += '.ts'
      return nextResolve(pathToFileURL(resolvePath(appDir, rel)).href, context)
    }
    return nextResolve(specifier, context)
  }
})
