import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import { join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProviderConfigStore } from './config-store.js'
import { loadDotEnv } from './env.js'
import { getAsrProvider, getSoundEffectProvider, getTtsProvider, listAsrProviders, listProviderDefinitions, listSoundEffectProviders, listTtsProviders } from './providers/registry.js'
import { sendPublicFile } from './public.js'
import { getProviderTimeoutMs, withTimeout } from './timeout.js'
import type {
  ProviderConfigInput,
  ProviderRuntimeConfig,
  SoundEffectRequest,
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
    const isHead = req.method === 'HEAD'
    const isGetLike = req.method === 'GET' || isHead

    if (isGetLike && url.pathname === '/health') {
      return sendJson(res, {
        ok: true,
        database: configStore.isDatabaseEnabled() ? 'enabled' : 'disabled',
      }, 200, isHead)
    }

    if (isGetLike && url.pathname === '/api/providers') {
      const configMap = await getConfigMap()
      return sendJson(res, {
        providers: listProviderDefinitions(configMap),
        database: configStore.isDatabaseEnabled(),
      }, 200, isHead)
    }

    const voicesMatch = /^\/api\/providers\/([^/]+)\/voices$/.exec(url.pathname)
    if (isGetLike && voicesMatch) {
      const providerId = decodeURIComponent(voicesMatch[1] ?? '')
      const provider = getTtsProvider(providerId)
      const context = await getRuntimeConfig(provider.id)
      const voices = await provider.listVoices(context)
      return sendJson(res, { voices }, 200, isHead)
    }

    if (isGetLike && url.pathname === '/v1/models') {
      return sendJson(res, { object: 'list', data: listOpenAiModels() }, 200, isHead)
    }

    const configMatch = /^\/api\/providers\/([^/]+)\/config$/.exec(url.pathname)
    if (req.method === 'PUT' && configMatch) {
      const providerId = decodeURIComponent(configMatch[1] ?? '')
      assertKnownProvider(providerId)
      const body = await readJson<ProviderConfigInput>(req)
      const record = await configStore.upsertConfig(providerId, body)
      return sendJson(res, { provider: record })
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/speech') {
      return createOpenAiSpeech(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/effect') {
      return createAudioEffect(req, res)
    }

    if (req.method === 'POST' && url.pathname === '/v1/audio/transcriptions') {
      return createOpenAiTranscription(req, res)
    }

    const audioMatch = /^\/audio\/([^/]+)$/.exec(url.pathname)
    if (isGetLike && audioMatch) {
      return sendAudio(res, audioMatch[1] ?? '', isHead)
    }

    if (isGetLike && await sendPublicFile(res, publicDir, url.pathname, isHead)) {
      return
    }

    return sendJson(res, { error: 'Not found' }, 404, isHead)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return sendJson(res, { error: message }, 400, req.method === 'HEAD')
  }
})

server.listen(port, () => {
  console.log(`voxout listening on http://127.0.0.1:${port}`)
})

async function createOpenAiSpeech(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<Record<string, unknown>>(req)
  const providerId = getOpenAiModelProvider(body.model, body.provider)
  const input = typeof body.input === 'string' ? body.input : ''
  if (!input.trim()) throw new Error('input is required')

  const provider = getTtsProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)
  const responseFormat = typeof body.response_format === 'string' ? body.response_format : undefined
  const request = normalizeSynthesizeInput(provider.id, {
    text: input,
    voice: typeof body.voice === 'string' ? body.voice : undefined,
    outputFormat: responseFormat,
    speed: typeof body.speed === 'number' ? body.speed : undefined,
  })
  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.synthesize(request, context),
    timeoutMs,
    `Speech generation timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.audio, normalizeSpeechMimeType(responseFormat, result.mimeType))
}

async function createAudioEffect(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson<Record<string, unknown>>(req)
  const providerId = getOpenAiModelProvider(body.model, body.provider)
  const provider = getSoundEffectProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const request = normalizeSoundEffectInput(provider.id, body)
  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.createSoundEffect(request, context),
    timeoutMs,
    `Sound effect generation timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  sendBinary(res, result.audio, result.mimeType)
}

async function createOpenAiTranscription(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const form = await readMultipartForm(req)
  const providerId = getOpenAiModelProvider(form.fields.model, form.fields.provider)
  const provider = getAsrProvider(providerId)
  const context = await getRuntimeConfig(provider.id)
  ensureEnabled(provider.id, context)

  const file = form.files.file
  const responseFormat = normalizeTranscriptionResponseFormat(form.fields.response_format)
  const request: TranscribeRequest = {
    url: form.fields.url,
    bvid: form.fields.bvid,
    audioData: form.fields.audioData,
    mimeType: form.fields.mimeType,
    language: form.fields.language,
    format: responseFormat === 'srt' ? 'srt' : responseFormat === 'verbose_json' ? 'raw' : 'txt',
  }
  if (file) {
    request.audioData = `data:${normalizeMimeType(file.contentType)};base64,${file.data.toString('base64')}`
    request.mimeType = normalizeMimeType(file.contentType)
  }
  if (!request.url && !request.bvid && !request.audioData) {
    throw new Error('file, url, bvid, or audioData is required')
  }

  const timeoutMs = getProviderTimeoutMs(context)
  const result = await withTimeout(
    provider.transcribe(request, context),
    timeoutMs,
    `Transcription timed out after ${timeoutMs}ms for provider ${provider.id}`,
  )
  const text = result.text ?? ''
  if (responseFormat === 'text' || responseFormat === 'srt') {
    return sendText(res, text, 'text/plain; charset=utf-8')
  }
  if (responseFormat === 'verbose_json') {
    return sendJson(res, {
      text,
      segments: result.segments,
      raw: result.raw,
    })
  }
  return sendJson(res, { text })
}

function listOpenAiModels(): Array<{
  id: string
  object: 'model'
  created: number
  owned_by: string
  capabilities: Record<string, boolean>
}> {
  const models = new Map<string, {
    id: string
    object: 'model'
    created: number
    owned_by: string
    capabilities: Record<string, boolean>
  }>()
  for (const provider of [...listTtsProviders(), ...listAsrProviders(), ...listSoundEffectProviders()]) {
    const existing = models.get(provider.id)
    models.set(provider.id, {
      id: provider.id,
      object: 'model',
      created: 0,
      owned_by: 'voxout',
      capabilities: {
        ...(existing?.capabilities ?? {}),
        ...(provider.capabilities ?? {}),
      },
    })
  }
  return [...models.values()]
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
    try {
      getAsrProvider(providerId)
      return
    } catch {
      getSoundEffectProvider(providerId)
    }
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
    rate: typeof value.rate === 'string' ? value.rate : typeof value.speed === 'number' ? String(value.speed) : undefined,
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

function normalizeSoundEffectInput(providerId: string, input: unknown): SoundEffectRequest {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {}
  const prompt = typeof value.input === 'string'
    ? value.input
    : typeof value.prompt === 'string'
      ? value.prompt
      : ''
  if (!prompt.trim()) throw new Error('input is required')
  return {
    provider: providerId,
    prompt,
    outputFormat: typeof value.response_format === 'string'
      ? value.response_format
      : typeof value.output_format === 'string'
        ? value.output_format
        : undefined,
    durationSeconds: typeof value.duration_seconds === 'number'
      ? value.duration_seconds
      : typeof value.durationSeconds === 'number'
        ? value.durationSeconds
        : undefined,
    promptInfluence: typeof value.prompt_influence === 'number'
      ? value.prompt_influence
      : typeof value.promptInfluence === 'number'
        ? value.promptInfluence
        : undefined,
    loop: typeof value.loop === 'boolean' ? value.loop : undefined,
  }
}

function setCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,OPTIONS')
}

function sendJson(res: ServerResponse, value: unknown, status = 200, headOnly = false): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  })
  res.end(headOnly ? undefined : body)
}

function sendText(res: ServerResponse, value: string, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(value)),
  })
  res.end(value)
}

function sendBinary(res: ServerResponse, value: Buffer, contentType: string): void {
  res.writeHead(200, {
    'content-type': contentType,
    'content-length': String(value.length),
  })
  res.end(value)
}

async function sendAudio(res: ServerResponse, fileName: string, headOnly = false): Promise<void> {
  if (!/^[a-f0-9]{64}\.(?:wav|mp3)$/.test(fileName)) {
    sendJson(res, { error: 'Invalid audio file name' }, 400, headOnly)
    return
  }
  const filePath = normalize(join(audioDir, fileName))
  if (!filePath.startsWith(normalize(audioDir))) {
    sendJson(res, { error: 'Invalid audio path' }, 400, headOnly)
    return
  }
  const fileStat = await stat(filePath).catch(() => null)
  if (!fileStat?.isFile()) {
    sendJson(res, { error: 'Audio not found' }, 404, headOnly)
    return
  }
  res.writeHead(200, {
    'content-type': fileName.endsWith('.mp3') ? 'audio/mpeg' : 'audio/wav',
    'content-length': String(fileStat.size),
  })
  if (headOnly) {
    res.end()
    return
  }
  createReadStream(filePath).pipe(res)
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text || '{}') as T
}

async function readMultipartForm(req: IncomingMessage): Promise<{
  fields: Record<string, string>
  files: Record<string, { fileName: string, contentType: string, data: Buffer }>
}> {
  const contentType = req.headers['content-type'] ?? ''
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[1]
    ?? /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)?.[2]
  if (!boundary) throw new Error('multipart/form-data boundary is required')
  const body = await readRequestBuffer(req)
  const boundaryBuffer = Buffer.from(`--${boundary}`)
  const fields: Record<string, string> = {}
  const files: Record<string, { fileName: string, contentType: string, data: Buffer }> = {}
  let cursor = body.indexOf(boundaryBuffer)

  while (cursor >= 0) {
    cursor += boundaryBuffer.length
    if (body[cursor] === 45 && body[cursor + 1] === 45) break
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), cursor)
    if (headerEnd < 0) break
    const headers = body.slice(cursor, headerEnd).toString('utf8')
    const dataStart = headerEnd + 4
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
    if (nextBoundary < 0) break
    const data = body.slice(dataStart, nextBoundary)
    const disposition = /^content-disposition:\s*([^\r\n]+)/im.exec(headers)?.[1] ?? ''
    const name = /name="([^"]+)"/.exec(disposition)?.[1]
    const fileName = /filename="([^"]*)"/.exec(disposition)?.[1]
    const partContentType = /^content-type:\s*([^\r\n]+)/im.exec(headers)?.[1]?.trim() ?? 'application/octet-stream'
    if (name && fileName != null) {
      files[name] = { fileName, contentType: partContentType, data }
    } else if (name) {
      fields[name] = data.toString('utf8')
    }
    cursor = body.indexOf(boundaryBuffer, nextBoundary + 2)
  }
  return { fields, files }
}

async function readRequestBuffer(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function getOpenAiModelProvider(model: unknown, provider: unknown): string {
  const providerId = typeof provider === 'string' && provider.trim()
    ? provider.trim()
    : typeof model === 'string' && model.trim()
      ? model.trim()
      : ''
  if (!providerId) throw new Error('model is required')
  return providerId
}

function normalizeSpeechMimeType(responseFormat: string | undefined, providerMimeType: string): string {
  const format = responseFormat?.toLowerCase()
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'wav' || format === 'pcm') return 'audio/wav'
  return providerMimeType
}

function normalizeTranscriptionResponseFormat(value: string | undefined): 'json' | 'text' | 'srt' | 'verbose_json' {
  if (value === 'text' || value === 'srt' || value === 'verbose_json') return value
  return 'json'
}

function normalizeMimeType(value: string | undefined): string {
  return value?.split(';')[0]?.trim() || 'application/octet-stream'
}
