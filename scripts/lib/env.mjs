// Shared `.env` loader for the scripts/ dev tools (Alfa today; Priorbank /
// file-import tools next). No deps — keeps the scripts standalone (no build).
// Line parsing lives in ./demo-utils.mjs (parseDotEnvLine) and is unit-tested.

import { readFileSync } from 'node:fs'
import { parseDotEnvLine } from './demo-utils.mjs'

/**
 * Load KEY=VALUE pairs into process.env from the FIRST readable file in
 * `candidates`, in order. Values already present in process.env (real env or
 * CLI) are never overridden.
 *
 * @param {string[]} candidates  files to try, most-specific first
 * @param {{ explicit?: boolean }} [opts]  when `explicit` is true, a candidate
 *   that exists-but-can't-be-read (or is missing) is a hard error (exit 1) —
 *   use it when the user named the file (e.g. `--env foo`). With implicit
 *   fallbacks, a missing file is simply skipped.
 * @returns {string|null} the file that was loaded, or null if none matched
 */
export function loadDotEnv(candidates, { explicit = false } = {}) {
  for (const file of candidates) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      if (explicit) {
        console.error(`cannot read env file "${file}": ${e.message}`)
        process.exit(1)
      }
      continue
    }
    for (const line of text.split(/\r?\n/)) {
      const kv = parseDotEnvLine(line)
      if (kv && process.env[kv[0]] === undefined) process.env[kv[0]] = kv[1]
    }
    return file
  }
  return null
}
