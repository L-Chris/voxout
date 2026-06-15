import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import type { ServerResponse } from 'node:http'
import { sendError } from './http.js'

export async function sendAudio(res: ServerResponse, audioDir: string, file_name: string, headOnly = false): Promise<void> {
  if (!/^[a-f0-9]{64}\.(?:wav|mp3)$/.test(file_name)) {
    sendError(res, 'Invalid audio file name', 400, headOnly)
    return
  }
  const filePath = normalize(join(audioDir, file_name))
  if (!filePath.startsWith(normalize(audioDir))) {
    sendError(res, 'Invalid audio path', 400, headOnly)
    return
  }
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) {
    sendError(res, 'Audio not found', 404, headOnly)
    return
  }
  res.writeHead(200, {
    'content-type': file_name.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
    'content-length': String(fileStat.size),
  })
  if (headOnly) {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}
