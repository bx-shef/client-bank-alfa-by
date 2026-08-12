// Минимальный статик-сервер для собранной статики (`.output/public`). Общий для двух потребителей:
// `scripts/screenshot.mjs` (ручной прогон, docs/VISUAL_VERIFICATION.md) и визуальных
// регресс-тестов (`tests/visual/pages.spec.ts`, #3).
//
// Общий — потому что копия успела разойтись в первый же день (в тесте появились `.txt` и
// `.webmanifest`), а traversal-гард — ровно тот код, который нельзя чинить в одном месте из двух.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname, normalize, sep } from 'node:path'

export const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.txt': 'text/plain', '.webmanifest': 'application/manifest+json'
}

/**
 * Поднимает сервер на свободном порту и отдаёт `{ server, port }`.
 * @param {string} rootDir абсолютный путь к каталогу со статикой
 * @returns {Promise<{ server: import('node:http').Server, port: number }>}
 */
export function startStaticServer(rootDir) {
  const server = createServer(async (req, res) => {
    try {
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
      let filePath = join(rootDir, normalize(urlPath))
      // Defence-in-depth: никогда не отдаём за пределы rootDir, даже если в пути есть `../`.
      if (filePath !== rootDir && !filePath.startsWith(rootDir + sep)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      if ((await stat(filePath).catch(() => null))?.isDirectory()) {
        filePath = join(filePath, 'index.html')
      }
      const body = await readFile(filePath)
      res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404)
      res.end('Not found')
    }
  })
  return new Promise((resolve, reject) => {
    // Ошибка ПОСЛЕ listen (сброшенное соединение, EMFILE) иначе роняет процесс без внятного
    // сообщения — в тестовом воркере это выглядело бы как загадочное падение всего файла.
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('не удалось определить порт статик-сервера'))
        return
      }
      resolve({ server, port: addr.port })
    })
  })
}
