// Monte-Carlo / fuzz harness for the payment-allocation algorithm (#109), dev-only
// (not part of the SSG build). Feeds N random payments against a random synthetic
// CRM through the REAL pure cores (recognizeByMatrices → routeIdentifier →
// resolveAllocation) + a mock wiring that follows docs/PROCESSING.md §2, then
// aggregates a LOGICAL MODEL of outcomes: the distribution (peaks/spikes) and a
// focused breakdown of all non-applications, including LEAKS — cases where a valid
// allocation existed but was not applied. Deterministic: seeded PRNG, so a re-run
// reproduces the same numbers. This is an EXPLORATORY report, not the CI gate —
// the machine-checked composition test lives in tests/allocationPipeline.test.ts.
//
// SCOPE: the mock `classify()` is a DRAFT of the future crm-sync wiring; when real
// REST wiring lands (#109 next slice) it MUST be reconciled with (or replaced by)
// this. Coverage is illustrative, not exhaustive — the generator exercises 5 of the
// 11 IdentifierKind, one identifier per purpose (no invoice+deal-payment merge).
//
// Run: pnpm fuzz:allocation [seed] [N]   (Node ≥ 22, native TS strip + ~ alias)

import type { AllocationCandidate } from '~/utils/allocation'
import { resolveAllocation } from '~/utils/allocation'
import type { MatchMatrix } from '~/utils/purposeMatch'
import { recognizeByMatrices } from '~/utils/purposeMatch'
import { routeIdentifier } from '~/utils/identifierDispatch'

// ─────────────────────── seeded PRNG (mulberry32) ───────────────────────
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const argSeed = Number(process.argv[2] ?? 12345)
const N = Number(process.argv[3] ?? 5000)
const rnd = mulberry32(argSeed)
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!
const chance = (p: number) => rnd() < p

// ─────────────────────── logical model: outcome categories ───────────────────────
const APPLIED = new Set<Category>([
  'allocate', 'allocate-ambiguous', 'trigger-deal', 'trigger-smart', 'trigger-document'
])
type Category
  = | 'allocate' | 'allocate-ambiguous'
    | 'trigger-deal' | 'trigger-smart' | 'trigger-document'
    | 'manual-no-exact' | 'no-candidates' | 'no-identifier'
    | 'client-not-found' | 'my-company-not-found' | 'idor-rejected'
const RU: Record<Category, string> = {
  'allocate': 'разнесено (точно)',
  'allocate-ambiguous': 'разнесено (мин.ID + чат)',
  'trigger-deal': 'триггер по сделке',
  'trigger-smart': 'триггер по смарт-процессу',
  'trigger-document': 'триггер через документ',
  'manual-no-exact': 'ручной разбор (сумма/валюта ≠)',
  'no-candidates': 'некуда разнести (нет сущности/стадия)',
  'no-identifier': 'дело клиенту (номер не распознан)',
  'client-not-found': 'дело в мою компанию (клиент не найден)',
  'my-company-not-found': 'чат ошибок (моя компания не найдена)',
  'idor-rejected': 'отклонено (IDOR — чужая сущность)'
}

// ─────────────────────── random synthetic CRM (ids/numbers WITH prefixes) ───────────────────────
const CURRENCIES = ['BYN', 'RUB', 'USD', 'EUR', 'CNY'] as const
const MY_CO = 'MYCO', CLIENT_CO = 'CLIENT', OTHER_CO = 'OTHER'
const MY_ACC = 'ACC-MY', CLIENT_ACC = 'ACC-CLIENT'
const companyByAccount = (acc: string): string | null =>
  acc === MY_ACC ? MY_CO : acc === CLIENT_ACC ? CLIENT_CO : null
const live = (s: number) => s >= 0
const inScope = (c: string) => c === MY_CO || c === CLIENT_CO

interface Inv { id: string, number: string, amount: number, currency: string, companyId: string, stage: number }
interface Pay { order: string, amount: number, currency: string, companyId: string, stage: number }
interface Deal { id: string, companyId: string, stage: number }

const invoices: Inv[] = Array.from({ length: 40 }, (_, i) => ({
  id: `INV-${100 + i}`, // the invoice's internal id ≠ its human "number"
  number: `СЧ-${2000 + i}`,
  amount: pick([100, 250, 500, 1000, 60.5, 777]),
  currency: pick(CURRENCIES),
  companyId: chance(0.9) ? CLIENT_CO : OTHER_CO,
  stage: chance(0.15) ? -1 : 1
}))
// two DIFFERENT invoices (distinct id) sharing one number and amount → ambiguity
invoices[0] = { id: 'INV-100', number: 'СЧ-2000', amount: 250, currency: 'BYN', companyId: CLIENT_CO, stage: 1 }
invoices[1] = { id: 'INV-101', number: 'СЧ-2000', amount: 250, currency: 'BYN', companyId: CLIENT_CO, stage: 1 }
const payments: Pay[] = Array.from({ length: 20 }, (_, i) => ({
  order: `ЗАК-${6000 + i}`, amount: pick([100, 250, 700, 1000]),
  currency: pick(CURRENCIES), companyId: CLIENT_CO, stage: chance(0.1) ? -1 : 1
}))
const deals: Deal[] = Array.from({ length: 15 }, (_, i) => ({
  id: `СД-${10 + i}`, companyId: chance(0.8) ? CLIENT_CO : OTHER_CO, stage: chance(0.1) ? -1 : 1
}))
const smarts = Array.from({ length: 8 }, (_, i) => ({ id: `СП-${500 + i}`, companyId: chance(0.85) ? CLIENT_CO : OTHER_CO }))
const genDocs = Array.from({ length: 6 }, (_, i) => ({ number: `ДОК-${9100 + i}`, dealId: pick(deals).id }))

// Matrices bound to identifier kinds — masks differ by literal prefix so each kind
// is distinguishable (§4). Value = the whole match incl. prefix (e.g. «СЧ-2000»).
const MATRICES: MatchMatrix[] = [
  { mask: 'СЧ-dddd', kind: 'invoice-number' },
  { mask: 'ЗАК-dddd', kind: 'order-number' },
  { mask: 'СД-dd', kind: 'deal-id' },
  { mask: 'СП-ddd', kind: 'smart-id' },
  { mask: 'ДОК-dddd', kind: 'document-number' }
]

// ─────────────────────── the algorithm (returns a category) ───────────────────────
interface Payment { ourAcc: string, counterAcc: string, amount: number, currency: string, purpose: string }

function classify(p: Payment): Category {
  if (!companyByAccount(p.ourAcc)) return 'my-company-not-found'
  if (!companyByAccount(p.counterAcc)) return 'client-not-found'

  const ids = recognizeByMatrices(p.purpose, MATRICES, 'cyrillic')
  if (ids.length === 0) return 'no-identifier'

  const searchCandidates: AllocationCandidate[] = []
  for (const id of ids) {
    const route = routeIdentifier(id.kind)
    if (route.targetKind === 'deal') {
      const d = deals.find(x => x.id === id.value)
      if (!d || !live(d.stage)) continue
      if (!inScope(d.companyId)) return 'idor-rejected'
      return 'trigger-deal'
    }
    if (route.targetKind === 'smart-process') {
      const s = smarts.find(x => x.id === id.value)
      if (!s) continue
      if (!inScope(s.companyId)) return 'idor-rejected'
      return 'trigger-smart'
    }
    if (route.strategy === 'via-document') {
      const doc = genDocs.find(x => x.number === id.value)
      if (!doc) continue
      const d = deals.find(x => x.id === doc.dealId)
      if (!d || !live(d.stage)) continue
      if (!inScope(d.companyId)) return 'idor-rejected'
      return 'trigger-document'
    }
    // NB: §2 reads "invoice not found → then search deal payments" (sequential);
    // here both branches collect into one searchCandidates[] and rely on
    // collapseSameTarget. Equivalent for the generator (one id kind per purpose);
    // a purpose carrying two DIFFERENT id kinds would diverge — out of scope here.
    if (route.targetKind === 'invoice') {
      searchCandidates.push(...invoices
        .filter(i => i.number === id.value && inScope(i.companyId) && live(i.stage))
        .map(i => ({ kind: 'invoice' as const, id: i.id, amount: i.amount, currency: i.currency })))
    }
    if (route.targetKind === 'deal-payment' && route.strategy === 'via-order') {
      searchCandidates.push(...payments
        .filter(x => x.order === id.value && inScope(x.companyId) && live(x.stage))
        .map(x => ({ kind: 'deal-payment' as const, id: x.order, amount: x.amount, currency: x.currency })))
    }
  }

  if (searchCandidates.length > 0) {
    const d = resolveAllocation({ amount: p.amount, currency: p.currency, candidates: searchCandidates })
    if (d.action === 'manual') return 'manual-no-exact'
    if (d.action === 'none') return 'no-candidates'
    return d.ambiguous ? 'allocate-ambiguous' : 'allocate'
  }
  return 'no-candidates'
}

// ─────────────────────── random payment generator ───────────────────────
// `expectedApply` = a clean auto-application is the CORRECT outcome (a live,
// in-scope, exact entity is referenced by a RECOGNIZABLE identifier).
interface Gen { p: Payment, expectedApply: boolean }

function genPayment(): Gen {
  const ourAcc = chance(0.95) ? MY_ACC : 'ACC-UNKNOWN'
  const counterAcc = chance(0.9) ? CLIENT_ACC : 'ACC-UNKNOWN'
  const mode = pick([
    'invoice-exact', 'invoice-partial', 'invoice-currency', 'invoice-missing',
    'order-exact', 'deal-trigger', 'deal-idor', 'smart-trigger', 'doc-bridge',
    'no-id', 'ambiguous', 'bad-separator'
  ] as const)

  let purpose = 'оплата по договору'
  let amount = pick([100, 250, 700, 1000])
  let currency = pick(CURRENCIES)
  let expectedApply = false
  const liveInv = invoices.filter(i => inScope(i.companyId) && live(i.stage))

  const setInv = (inv: Inv, purposeText: string, amt = inv.amount, cur = inv.currency, expect = false) => {
    purpose = purposeText
    amount = amt
    currency = cur
    expectedApply = expect
  }

  if (mode === 'invoice-exact' && liveInv.length) {
    const inv = pick(liveInv)
    setInv(inv, `оплата ${inv.number}`, inv.amount, inv.currency, true)
  } else if (mode === 'ambiguous') {
    const inv = invoices.find(i => i.number === 'СЧ-2000')!
    setInv(inv, 'оплата СЧ-2000', inv.amount, inv.currency, true)
  } else if (mode === 'invoice-partial' && liveInv.length) {
    const inv = pick(liveInv)
    setInv(inv, `оплата ${inv.number}`, Math.round(inv.amount * 0.5 * 100) / 100, inv.currency)
  } else if (mode === 'invoice-currency' && liveInv.length) {
    const inv = pick(liveInv)
    setInv(inv, `оплата ${inv.number}`, inv.amount, CURRENCIES.find(c => c !== inv.currency)!)
  } else if (mode === 'invoice-missing') {
    purpose = 'оплата СЧ-8888'
  } else if (mode === 'order-exact') {
    const liveP = payments.filter(x => inScope(x.companyId) && live(x.stage))
    if (liveP.length) {
      const pay = pick(liveP)
      purpose = `оплата ${pay.order}`
      amount = pay.amount
      currency = pay.currency
      expectedApply = true
    }
  } else if (mode === 'deal-trigger') {
    const liveD = deals.filter(d => inScope(d.companyId) && live(d.stage))
    if (liveD.length) {
      purpose = `оплата ${pick(liveD).id}`
      expectedApply = true
    }
  } else if (mode === 'deal-idor') {
    const other = deals.filter(d => d.companyId === OTHER_CO && live(d.stage))
    if (other.length) purpose = `оплата ${pick(other).id}`
  } else if (mode === 'smart-trigger') {
    const liveS = smarts.filter(s => inScope(s.companyId))
    if (liveS.length) {
      purpose = `оплата ${pick(liveS).id}`
      expectedApply = true
    }
  } else if (mode === 'doc-bridge') {
    const doc = pick(genDocs)
    purpose = `оплата ${doc.number}`
    const d = deals.find(x => x.id === doc.dealId)
    expectedApply = !!d && inScope(d.companyId) && live(d.stage)
  } else if (mode === 'bad-separator' && liveInv.length) {
    // number written with a SPACE instead of the dash — mask «СЧ-dddd» won't catch
    // it (known leak «separator flexibility», follow-up #109): exists but unrecognized.
    const inv = pick(liveInv)
    setInv(inv, `оплата ${inv.number.replace('-', ' ')}`, inv.amount, inv.currency, true)
  }

  if (ourAcc === 'ACC-UNKNOWN' || counterAcc === 'ACC-UNKNOWN') expectedApply = false
  return { p: { ourAcc, counterAcc, amount, currency, purpose }, expectedApply }
}

// ─────────────────────── run + aggregate ───────────────────────
const counts = new Map<Category, number>()
const leaks = new Map<Category, { n: number, samples: string[] }>()
let applied = 0, notApplied = 0

for (let i = 0; i < N; i++) {
  const { p, expectedApply } = genPayment()
  const cat = classify(p)
  counts.set(cat, (counts.get(cat) ?? 0) + 1)
  if (APPLIED.has(cat)) applied++
  else notApplied++
  if (expectedApply && !APPLIED.has(cat)) {
    const e = leaks.get(cat) ?? { n: 0, samples: [] }
    e.n++
    if (e.samples.length < 3) e.samples.push(`amount=${p.amount} ${p.currency} · "${p.purpose}"`)
    leaks.set(cat, e)
  }
}

const pct = (n: number) => `${(100 * n / N).toFixed(1)}%`
const bar = (n: number) => '█'.repeat(Math.round(40 * n / N))
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])

console.log('═══ ФУЗЗ-ПРОГОН АЛГОРИТМА РАЗНЕСЕНИЯ (#109) ═══')
console.log(`seed=${argSeed}  N=${N}  CRM: инвойсов=${invoices.length} оплат=${payments.length} сделок=${deals.length}\n`)
console.log(`Внесено (авто): ${applied} (${pct(applied)})   ·   НЕ внесено: ${notApplied} (${pct(notApplied)})\n`)
console.log('РАСПРЕДЕЛЕНИЕ ИСХОДОВ (пики сверху):')
for (const [cat, n] of sorted) {
  console.log(`  ${APPLIED.has(cat) ? '✔' : '·'} ${RU[cat].padEnd(42)} ${String(n).padStart(5)}  ${pct(n).padStart(6)}  ${bar(n)}`)
}
console.log('\n⚠ ПРОСАДКИ (существовала корректная цель, но авторазнесение НЕ произошло) — на анализ:')
const leakEntries = [...leaks.entries()].sort((a, b) => b[1].n - a[1].n)
if (leakEntries.length === 0) console.log('  (нет — все ожидаемые внесения сработали)')
for (const [cat, e] of leakEntries) {
  console.log(`  ✖ ${RU[cat]} — ${e.n} шт`)
  for (const s of e.samples) console.log(`      ├ ${s}`)
}
