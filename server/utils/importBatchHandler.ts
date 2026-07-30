// Чистый обработчик `GET /api/import/batch` (#417) — итоги конкретных загрузок для UI.
// Тонкий роут только подаёт I/O; здесь — гейт и форма ответа, всё под тестами.
//
// Гейт тот же, что у `/api/import`: портал установлен (есть ключ по домену) → фрейм-токен доказан
// ДЛЯ ЭТОГО домена (блок спуфинга `X-B24-Domain`). Админом быть не нужно — сотрудник смотрит итог
// СВОЕЙ загрузки, а данные member-scoped.
//
// ⚠ Скоуп по порталу обязателен и в запросе к стору: ключ загрузки — sha256 файла, то есть его
// знает всякий, у кого есть такой же файл (например тот же банк-шаблон). Без member-скоупа чужой
// портал читал бы наши счётчики по угаданному ключу.

import type { ImportBatchResult } from '../../app/types/importBatch'
import { MAX_BATCH_IDS } from './importBatchStore'

export interface ImportBatchDeps {
  memberIdByDomain: (domain: string) => Promise<string | null>
  /** Доказывает, что токен выдан ИМЕННО этим порталом; бросает, если нет. */
  validateFrame: (domain: string, accessToken: string) => Promise<string>
  getBatches: (memberId: string, ids: string[]) => Promise<ImportBatchResult[]>
}

export interface ImportBatchInput {
  accessToken: string
  domain: string
  /** Список ключей: `?ids=a,b,c`. */
  ids: string
}

export interface ImportBatchResponse {
  status: number
  body: Record<string, unknown>
}

/** Разобрать `ids` из строки запроса: непустые, без дублей, не больше капа. */
export function parseBatchIds(raw: string): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(',')) {
    const id = part.trim()
    // Ключ — sha256-hex; всё иное отбрасываем, чтобы в запрос не уехал произвольный текст.
    if (!/^[a-f0-9]{64}$/i.test(id)) continue
    seen.add(id.toLowerCase())
    if (seen.size >= MAX_BATCH_IDS) break
  }
  return [...seen]
}

export async function handleImportBatch(
  deps: ImportBatchDeps,
  input: ImportBatchInput
): Promise<ImportBatchResponse> {
  const { accessToken, domain } = input
  if (!accessToken || !domain) {
    return { status: 400, body: { error: 'frame auth (Bearer token + domain) required' } }
  }
  const ids = parseBatchIds(input.ids)
  // Пустой список — не ошибка, а «нечего спрашивать»: UI зовёт роут по таймеру и мог остаться без
  // ключей после чистки. Отвечаем пусто, БЕЗ обращений к порталу и БД.
  if (!ids.length) return { status: 200, body: { batches: [] } }

  const memberId = await deps.memberIdByDomain(domain)
  if (!memberId) return { status: 409, body: { error: 'portal not installed (no key)' } }

  try {
    await deps.validateFrame(domain, accessToken)
  } catch {
    return { status: 403, body: { error: 'invalid frame token for this portal' } }
  }

  const batches = await deps.getBatches(memberId, ids)
  return { status: 200, body: { batches } }
}
