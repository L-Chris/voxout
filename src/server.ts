import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AudioCache } from './cache.js'
import { ProviderConfigStore } from './config-store.js'
import { loadDotEnv } from './env.js'
import { getAsrProvider, getTtsProvider, listProviderDefinitions } from './providers/registry.js'
import { sendPublicFile } from './public.js'
import { getSynthesisTimeoutMs, withTimeout } from './timeout.js'
import type {
  InvokeRequest,
  ProviderConfigInput,
  ProviderRuntimeConfig,
  SynthesizeRequest,
  TranscribeRequest,
} from './types.js'

const rootDir = fileURLToPath(new URL('..', import.meta.url))
await loadDotEnv([
  join(process.cwd(), '.env'),
  join(process.cwd(), '.env.local'),
  join(rootDir, '.env'),
  join(rootDir, '.env.local'),
])

const port = Number(process.env.PORT ?? 4177)
const audioDir = process.env.TTS_AUDIO_DIR ?? join(rootDir, 'audio')
const publicDir = join(rootDir, 'public')
const cache = new AudioCache(audioDir)
const configStore = new ProviderConfigStore()

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
      return sendJson(res, {
        ok: true,
        database: configStore.isDatabaseEnabled() ? 'enabled' : 'disabled',
      })
    }

    if (req.method === 'GET' && url.pathname === '/api/providers') {
      const configMap = await getConfigMap()
      return sendJson(res, {
        providers: listProviderDefinitions(configMap),
        database: configStore.isDatabaseEnabled(),
      })
    }

    const configMatch = /^\/api\/providers\/([^/]+)\/config$/.exec(url.pathname)
    if (req.method === 'PUT' && configMatch) {
      const providerId = decodeURIComponent(configMatch[1] ?? '')
      assertKnownProvider(providerId)
      const body = await readJson<ProviderConfigInput>(req)
      const record = await configStore.upsertConfig(providerId, body)
      return sendJson(res, { provider: record })
    }

    if (req.method === 'POST' && url.pathname === '/api/invoke') {
      const body = await readJson<InvokeRequest>(req)
      const result = await invokeProvider(body)
      return sendJson(res, result)
    }

    const audioMatch = /^\/audio\/([^/]+)$/.exec(url.pathname)
    if (req.method === 'GET' && audioMatch) {
      return sendAudio(res, audioMatch[1] ?? '')
    }

    if (req.method === 'GET' && await sendPublicFile(res, publicDir, url.pathname)) {
      return
    }

    return sendJson(res, { error: 'Not found' }, 404)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sendJson(res, { error: message }, 400)
  }
})

server.listen(port, () => {
  console.log(`voxout listening on http://127.0.0.1:${port}`)
})

async function invokeProvider(request: InvokeRequest): Promise<unknown> {
  const providerId = request.provider?.trim()
  if (!providerId) throw new Error('provider is required')

  if (request.operation === 'transcribe' || request.capability === 'asr') {
    const provider = getAsrProvider(providerId)
    const context = await getRuntimeConfig(provider.id)
    ensureEnabled(provider.id, context)
    return {
      provider: provider.id,
      operation: 'transcribe',
      result: await provider.transcribe(normalizeTranscribeInput(request.input), context),
    }
  }

  const provider = getTtsProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)
  const synthesizeRequest = normalizeSynthesizeInput(provider.id, request.input)
  const timeoutMs = getSynthesisTimeoutMs()
  const result = await withTimeout(
    cache.getOrCreate(
      synthesizeRequest,
      () => provider.synthesize(synthesizeRequest, context),
    ),
    timeoutMs,
    `TTS synthesis timed out after ${timeoutMs}ms for segment ${synthesizeRequest.segment.id}`,
  )
  return {
    provider: provider.id,
    operation: 'synthesize',
    result,
  }
}

async function getConfigMap(): Promise<Map<string, ProviderRuntimeConfig>> {
  const records = await configStore.listConfigs()
  return new Map(records.map(record => [record.providerId, record]))
}

async function getRuntimeConfig(providerId: string): Promise<ProviderRuntimeConfig> {
  return configStore.getConfig(providerId)
}

function ensureEnabled(providerId: string, context: ProviderRuntimeConfig): void {
  if (!context.enabled) throw new Error(`Provider is disabled: ${providerId}`)
}

function assertKnownProvider(providerId: string): void {
  try {
    getTtsProvider(providerId)
    return
  } catch {
    getAsrProvider(providerId)
  }
}

function normalizeSynthesizeInput(providerId: string, input: unknown): SynthesizeRequest {
  const value = input && typeof input === 'object' ? input as Partial<SynthesizeRequest> & Record<string, unknown> : {}
  if (value.segment && typeof value.segment === 'object') {
    return {
      ...value,
      provider: providerId,
      segment: {
        ...value.segment,
        id: String((value.segment as { id?: unknown }).id ?? randomUUID()),
        text: String((value.segment as { text?: unknown }).text ?? ''),
        provider: providerId,
      },
    } as SynthesizeRequest
  }
  const text = typeof value.text === 'string' ? value.text : ''
  if (!text.trim()) throw new Error('input.text is required for synthesize')
  return {
    provider: providerId,
    voice: typeof value.voice === 'string' ? value.voice : undefined,
    lang: typeof value.lang === 'string' ? value.lang : undefined,
    outputFormat: typeof value.outputFormat === 'string' ? value.outputFormat : undefined,
    rate: typeof value.rate === 'string' ? value.rate : undefined,
    pitch: typeof value.pitch === 'string' ? value.pitch : undefined,
    volume: typeof value.volume === 'string' ? value.volume : undefined,
    voicePrompt: typeof value.voicePrompt === 'string' ? value.voicePrompt : undefined,
    stylePrompt: typeof value.stylePrompt === 'string' ? value.stylePrompt : undefined,
    segment: {
      id: typeof value.id === 'string' ? value.id : randomUUID(),
      text,
      provider: providerId,
      voice: typeof value.voice === 'string' ? value.voice : undefined,
      soundEffectPrompt: typeof value.soundEffectPrompt === 'string' ? value.soundEffectPrompt : undefined,
      soundEffectDurationSeconds: typeof value.soundEffectDurationSeconds === 'number' ? value.soundEffectDurationSeconds : undefined,
      voicePrompt: typeof value.voicePrompt === 'string' ? value.voicePrompt : undefined,
      stylePrompt: typeof value.stylePrompt === 'string' ? value.stylePrompt : undefined,
    },
  }
}

function normalizeTranscribeInput(input: unknown): TranscribeRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const request: TranscribeRequest = {
    url: typeof value.url === 'string' ? value.url : undefined,
    bvid: typeof value.bvid === 'string' ? value.bvid : undefined,
    format: value.format === 'srt' || value.format === 'raw' ? value.format : 'txt',
  }
  if (!request.url && !request.bvid) throw new Error('input.url or input.bvid is required for transcribe')
  return request
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS')
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
