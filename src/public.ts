import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import type { ServerResponse } from 'node:http'

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export async function sendPublicFile(res: ServerResponse, publicDir: string, pathname: string): Promise<boolean> {
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  if (!/^[a-zA-Z0-9._/-]+$/.test(relativePath) || relativePath.includes('..')) return false
  const filePath = normalize(join(publicDir, relativePath))
  if (!filePath.startsWith(normalize(publicDir))) return false
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) return false
  res.writeHead(200, { 'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' })
  createReadStream(filePath).pipe(res)
  return true
}
