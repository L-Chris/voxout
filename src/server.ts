import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AudioCache } from './cache.js'
import { loadDotEnv } from './env.js'
import { getProvider, listProviders } from './providers/registry.js'
import { TaskManager } from './task-manager.js'
import { getSynthesisTimeoutMs, withTimeout } from './timeout.js'
import type { SynthesizeRequest, TtsJobRequest } from './types.js'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
await loadDotEnv([
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(rootDir, '.env'),
  join(rootDir, '.env.local'),
])

const port = Number(process.env.PORT ?? 4177)
const audioDir = process.env.TTS_AUDIO_DIR ?? join(rootDir, 'audio')
const cache = new AudioCache(audioDir)
const tasks = new TaskManager(cache)

await mkdir(audioDir, { recursive: true })

const server = createServer(async (req, res) => {
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, { ok: true })
    }

    if (req.method === 'GET' && url.pathname === '/v1/tts/providers') {
      return sendJson(res, { providers: listProviders() })
    }

    if (req.method === 'GET' && url.pathname === '/v1/tts/voices') {
      const provider = getProvider(url.searchParams.get('provider') ?? undefined)
      return sendJson(res, { voices: await provider.listVoices() })
    }

    if (req.method === 'POST' && url.pathname === '/v1/tts/synthesize') {
      const body = await readJson<SynthesizeRequest>(req)
      validateSynthesizeRequest(body)
      const provider = getProvider(body.provider)
      const timeoutMs = getSynthesisTimeoutMs()
      const result = await withTimeout(
        cache.getOrCreate(body, () => provider.synthesize(body)),
        timeoutMs,
        `TTS synthesis timed out after ${timeoutMs}ms for segment ${body.segment.id}`,
      )
      return sendJson(res, result)
    }

    if (req.method === 'POST' && url.pathname === '/v1/tts/jobs') {
      const body = await readJson<TtsJobRequest>(req)
      validateJobRequest(body)
      return sendJson(res, tasks.createJob(body), 202)
    }

    const jobMatch = /^\/v1\/tts\/jobs\/([^/]+)(?:\/segments)?$/.exec(url.pathname)
    if (req.method === 'GET' && jobMatch) {
      const jobId = jobMatch[1]
      if (url.pathname.endsWith('/segments')) {
        const results = tasks.getJobResults(jobId)
        if (!results) return sendJson(res, { error: 'Job not found' }, 404)
        return sendJson(res, { results })
      }
      const job = tasks.getJob(jobId)
      if (!job) return sendJson(res, { error: 'Job not found' }, 404)
      return sendJson(res, job)
    }

    const audioMatch = /^\/v1\/tts\/audio\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && audioMatch) {
      return sendAudio(res, audioMatch[1])
    }

    return sendJson(res, { error: 'Not found' }, 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sendJson(res, { error: message }, 400)
  }
})

server.listen(port, () => {
  console.log(`rebook-tts listening on http://127.0.0.1:${port}`)
})

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
}

function sendJson(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(value))
}

function sendAudio(res: ServerResponse, fileName: string): void {
  if (!/^[a-f0-9]{64}\.(?:wav|mp3)$/.test(fileName)) {
    sendJson(res, { error: 'Invalid audio file name' }, 400)
    return
  }
  const filePath = normalize(join(audioDir, fileName))
  if (!filePath.startsWith(normalize(audioDir))) {
    sendJson(res, { error: 'Invalid audio path' }, 400)
    return
  }
  stat(filePath).catch(() => null).then(fileStat => {
    if (!fileStat?.isFile()) {
      sendJson(res, { error: 'Audio not found' }, 404)
      return
    }
    res.writeHead(200, { 'content-type': fileName.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav' })
    createReadStream(filePath).pipe(res)
  })
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text || '{}') as T
}

function validateSynthesizeRequest(value: SynthesizeRequest): void {
  if (!value || typeof value !== 'object') throw new Error('Invalid request body')
  if (!value.segment || typeof value.segment.text !== 'string' || !value.segment.text.trim()) {
    throw new Error('segment.text is required')
  }
  if (!value.segment.id || typeof value.segment.id !== 'string') {
    throw new Error('segment.id is required')
  }
}

function validateJobRequest(value: TtsJobRequest): void {
  if (!value || !Array.isArray(value.segments) || value.segments.length === 0) {
    throw new Error('segments must be a non-empty array')
  }
  for (const segment of value.segments) {
    validateSynthesizeRequest({ provider: value.provider, segment })
  }
}
