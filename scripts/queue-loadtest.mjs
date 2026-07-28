#!/usr/bin/env node
// Нагрузочный прогон ОБРАТНОГО ДАВЛЕНИЯ поллера на реальном Redis + реальном BullMQ (dev-only).
//
// Зачем: на объёмах Маркета (~10 500 счетов Альфы + ~20 600 Приора) поведение очереди — это
// вопрос выживания, а не оптимизации. Банки лимитируют на OAuth-КЛИЕНТА (всё приложение), поэтому
// полный обход длится куда дольше тика крона, и постановка задач обязана быть ИДЕМПОТЕНТНОЙ:
// стабильный jobId + `removeOnComplete` (см. FETCH_JOB_RETENTION). Этот скрипт измеряет разницу.
//
// Банк-креды НЕ нужны: проверяется механика очереди (ключ задачи + удержание), а не транспорт.
//
//   redis-server --port 6399 --save '' --appendonly no --daemonize yes
//   pnpm loadtest:queue            # новый режим (стабильный jobId) — очередь ограничена
//   pnpm loadtest:queue 6 epoch    # старый режим (метка тика) — линейный рост, как было
//
// Аргументы: [тиков=6] [stable|epoch]. Переменные: REDIS_PORT (6399), LOAD_ALFA, LOAD_PRIOR.
//
// ⚠️ Работает в СВОЁМ Redis (по умолчанию :6399) и делает obliterate своих очередей —
// не запускать против боевого/дев-Redis приложения.

import { Queue } from 'bullmq'

const PORT = Number(process.env.REDIS_PORT || 6399)
const ALFA = Number(process.env.LOAD_ALFA || 10_500)
const PRIOR = Number(process.env.LOAD_PRIOR || 20_600)
const TICKS = Number(process.argv[2] || 6)
const MODE = process.argv[3] === 'epoch' ? 'epoch' : 'stable'
const connection = { host: '127.0.0.1', port: PORT }

// Зеркалят server/queue/topology.ts (fetchJobId / fetchQueueFor) и producers.ts
// (FETCH_JOB_RETENTION) — намеренно скопированы, чтобы скрипт не тянул Nitro-граф импортов.
const joinId = parts => parts.map(p => String(p).replace(/\|/g, '/')).join('|')
const fetchJobId = j => joinId(j.epoch
  ? ['fetch', j.memberId, j.providerId, j.account, j.dateFrom, j.dateTo, j.epoch]
  : ['fetch', j.memberId, j.providerId, j.account, j.dateFrom, j.dateTo])
const fetchQueueFor = p => (p === 'prior-by' ? 'bank-fetch-prior' : 'bank-fetch')
const FETCH_JOB_RETENTION = { removeOnComplete: true, removeOnFail: { age: 3600, count: 500 } }

const qAlfa = new Queue('bank-fetch', { connection })
const qPrior = new Queue('bank-fetch-prior', { connection })
const queues = { 'bank-fetch': qAlfa, 'bank-fetch-prior': qPrior }

/** Один тик крона: по одной задаче на каждый подключённый счёт флота. */
async function tick(dateFrom, dateTo, epoch) {
  const jobs = []
  for (let i = 0; i < ALFA; i++) jobs.push({ memberId: `M${i % 400}`, providerId: 'alfa-by', account: `BYA${i}`, dateFrom, dateTo, ...(epoch ? { epoch } : {}) })
  for (let i = 0; i < PRIOR; i++) jobs.push({ memberId: `M${i % 400}`, providerId: 'prior-by', account: `BYP${i}`, dateFrom, dateTo, ...(epoch ? { epoch } : {}) })
  const CHUNK = 1000
  for (let i = 0; i < jobs.length; i += CHUNK) {
    await Promise.all(jobs.slice(i, i + CHUNK).map((j) => {
      const name = fetchQueueFor(j.providerId)
      return queues[name].add(name, j, { jobId: fetchJobId(j), ...FETCH_JOB_RETENTION })
    }))
  }
  return jobs.length
}

const depth = async () => {
  const a = await qAlfa.getJobCounts('waiting', 'delayed')
  const p = await qPrior.getJobCounts('waiting', 'delayed')
  return a.waiting + a.delayed + p.waiting + p.delayed
}

async function main() {
  await qAlfa.obliterate({ force: true }).catch(() => {})
  await qPrior.obliterate({ force: true }).catch(() => {})

  console.log(`режим: ${MODE === 'epoch' ? 'СТАРЫЙ (метка тика в jobId)' : 'НОВЫЙ (стабильный jobId)'}`)
  console.log(`флот: ${ALFA} Альфа + ${PRIOR} Приор = ${ALFA + PRIOR} счетов, тиков: ${TICKS}\n`)
  console.log('тик | поставлено | глубина очереди | Δ')
  console.log('----+------------+-----------------+---------')

  const series = []
  let prev = 0
  for (let t = 1; t <= TICKS; t++) {
    const planned = await tick('2026-07-27', '2026-07-28', MODE === 'epoch' ? `tick${t}` : undefined)
    const d = await depth()
    series.push(d)
    console.log(` ${String(t).padStart(2)} | ${String(planned).padStart(10)} | ${String(d).padStart(15)} | ${d - prev >= 0 ? '+' : ''}${d - prev}`)
    prev = d
  }

  const first = series[0]
  const last = series.at(-1)
  const mem = /used_memory_human:(\S+)/.exec(await qAlfa.client.then(c => c.info('memory')))?.[1]
  console.log('\n--- ИТОГ ---')
  console.log(`глубина: ${first} → ${last} (×${(last / first).toFixed(2)}), Redis: ${mem}`)
  if (MODE === 'stable') {
    console.log(last === first
      ? `✅ ОГРАНИЧЕНА — за ${TICKS} тиков очередь не выросла (дедуп по стабильному jobId)`
      : `❌ выросла на ${last - first}: обратное давление НЕ работает`)
  } else {
    console.log(`⚠️  ЛИНЕЙНЫЙ РОСТ — +${Math.round((last - first) / (TICKS - 1))} задач за тик; при тике 5 мин это ~${Math.round((last - first) / (TICKS - 1) * 12 / 1000)}k задач/час`)
  }

  await qAlfa.close()
  await qPrior.close()
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('прогон упал:', e?.message ?? e)
  process.exit(1)
})
