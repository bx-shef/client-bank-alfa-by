// Minimal ESM resolve hook so dev scripts run with Node's native TS
// type-stripping can import app/server modules at RUNTIME (value imports). Two cases:
//   1. the Nuxt `~/` alias — `~/x` → <repo>/app/x
//      (e.g. app/utils/oneCStatement.ts → `~/utils/clientBankStatement`);
//   2. extensionless RELATIVE imports between server/app modules
//      (e.g. server/utils/allocationMutationWrite.ts → `../../app/utils/allocationMutation`).
// Node's bundler (Nuxt/nitro) resolves both, but native strip-types does not append
// `.ts`, so a VALUE import of such a module fails with ERR_MODULE_NOT_FOUND. Type-only
// imports are erased before the resolver, so only value imports need this.
// Preloaded via `node --import`.
//
// Requires Node >= 22.15 (synchronous `module.registerHooks`). Dev-only, not part
// of the SSG/prod build; CI and containers run current 22.x, so this is safe.

import { registerHooks } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { resolve as resolvePath, dirname } from 'node:path'

const appDir = resolvePath(import.meta.dirname, '../../app')
const hasExt = s => /\.[a-z0-9]+$/i.test(s)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('~/')) {
      const rel = specifier.slice(2)
      return nextResolve(pathToFileURL(resolvePath(appDir, hasExt(rel) ? rel : rel + '.ts')).href, context)
    }
    // Extensionless relative value import (../x, ./x) → append `.ts` and resolve against
    // the importing module's directory. Leaves anything with an extension untouched.
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && !hasExt(specifier)) {
      const base = context.parentURL ? dirname(fileURLToPath(context.parentURL)) : process.cwd()
      return nextResolve(pathToFileURL(resolvePath(base, specifier + '.ts')).href, context)
    }
    return nextResolve(specifier, context)
  }
})
