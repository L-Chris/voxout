import { Blob } from 'node:buffer'
import WebSocket from 'ws'
import type {
  AsrProvider,
  ProviderContext,
  SynthesizeRequest,
  TranscribeRequest,
  TranscribeResult,
  TtsProvider,
  TtsVoice,
  VoiceCloneProvider,
  VoiceCloneRequest,
  VoiceCloneResult,
} from '../types.js'
import { getProviderTimeoutMs } from '../timeout.js'

const DEFAULT_BASE_URL = 'https://api.gradium.ai/api'
const DEFAULT_WS_URL = 'wss://api.gradium.ai/api'
const DEFAULT_MODEL = 'default'
const DEFAULT_VOICE_ID = 'YTpq7expH9539ERJ'
const DEFAULT_OUTPUT_FORMAT = 'wav'
const GRADIUM_MODELS = [DEFAULT_MODEL]
const GRADIUM_OUTPUT_FORMATS = ['wav', 'pcm', 'opus', 'ulaw_8000', 'mulaw_8000', 'alaw_8000', 'pcm_8000', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100', 'pcm_48000']

interface GradiumVoicePayload {
  uid?: string
  name?: string
  is_catalog?: boolean
  is_pro_clone?: boolean
  description?: string | null
  language?: string | null
  tags?: unknown[]
}

interface GradiumCreateVoicePayload {
  uid?: string | null
  error?: string | null
  was_updated?: boolean
}

interface GradiumStreamMessage {
  type?: string
  audio?: string
  text?: string
  message?: string
  error?: string
}

export class GradiumProvider implements TtsProvider, AsrProvider, VoiceCloneProvider {
  readonly id = 'gradium'
  readonly name = 'Gradium'
  readonly capabilities = { tts: true, ttsStreaming: true, asr: true, voiceClone: true }
  readonly fields = [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'baseUrl', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'wsUrl', label: 'WebSocket URL', type: 'url' as const, placeholder: DEFAULT_WS_URL },
    { key: 'ttsModel', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_MODEL, options: GRADIUM_MODELS },
    { key: 'asrModel', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_MODEL, options: GRADIUM_MODELS },
    { key: 'defaultVoiceId', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'outputFormat', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT, options: GRADIUM_OUTPUT_FORMATS },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) return [getDefaultVoice(this.id, context)]

    const payload = await listGradiumVoices(context, apiKey)
    const voices = payload
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
    return voices.length ? voices : [getDefaultVoice(this.id, context)]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const apiKey = getApiKey(context)
    const outputFormat = normalizeOutputFormat(request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT)
    const response = await fetchWithTimeout(`${getBaseUrl(context)}/post/speech/tts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        text: request.segment.text.trim(),
        voice_id: getVoiceId(request, context),
        output_format: outputFormat,
        only_audio: true,
      }),
    }, context)
    const audio = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `Gradium text-to-speech request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('Gradium text-to-speech response audio was empty.')
    return {
      audio,
      mimeType: response.headers.get('content-type')?.split(';')[0] || getMimeType(outputFormat),
      durationMs: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    if ((request.streamFormat ?? 'audio') === 'sse') throw new Error('Gradium TTS streaming supports stream_format "audio" only.')
    const outputFormat = normalizeOutputFormat(request.outputFormat ?? getConfigString(context, 'outputFormat') ?? 'pcm')
    return {
      stream: createGradiumAudioStream(request, context, outputFormat),
      mimeType: getMimeType(outputFormat),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const apiKey = getApiKey(context)
    const audio = await resolveAudio(request)
    const inputFormat = getGradiumInputFormat(audio.mimeType)
    const url = new URL(`${getBaseUrl(context)}/post/speech/asr`)
    url.searchParams.set('model', request.model ?? getConfigString(context, 'asrModel') ?? DEFAULT_MODEL)
    url.searchParams.set('input_format', inputFormat)
    const language = normalizeLanguage(request.language)
    if (language) url.searchParams.set('json_config', JSON.stringify({ language }))

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': audio.mimeType,
        'x-api-key': apiKey,
      },
      body: new Blob([audio.data], { type: audio.mimeType }),
    }, context)
    const text = await response.text()
    if (!response.ok) throw new Error(text.slice(0, 500) || `Gradium speech-to-text request failed: ${response.status}`)
    const parsed = parseGradiumTranscription(text)
    if (!parsed.text) throw new Error('Gradium speech-to-text response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text: parsed.text,
      raw: request.format === 'raw' ? parsed.raw : undefined,
    }
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const apiKey = getApiKey(context)
    const audio = parseAudioData(request.audioData, request.mimeType)
    const form = new FormData()
    form.set('audio_file', new Blob([audio.data], { type: audio.mimeType }), request.fileName || audio.fileName)
    form.set('name', request.name)
    form.set('input_format', getGradiumInputFormat(audio.mimeType))
    if (request.description) form.set('description', request.description)
    if (request.language) form.set('language', normalizeLanguage(request.language) ?? request.language)
    form.set('start_s', '0')
    form.set('timeout_s', String(getConfigNumber(context, 'cloneTimeoutSeconds') ?? 10))

    const response = await fetchWithTimeout(`${getBaseUrl(context)}/voices/`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey },
      body: form,
    }, context)
    const payload = await readJsonResponse<GradiumCreateVoicePayload>(response)
    if (!response.ok) {
      throw new Error(payload.error || `Gradium voice clone request failed: ${response.status}`)
    }
    if (payload.error) throw new Error(payload.error)
    if (!payload.uid) throw new Error('Gradium voice clone response did not include uid.')
    return {
      provider: this.id,
      voice: {
        voiceId: payload.uid,
        providerVoiceId: payload.uid,
        name: request.name,
        description: request.description,
        language: request.language,
        metadata: {
          was_updated: payload.was_updated ?? false,
        },
      },
      raw: payload,
    }
  }
}

async function listGradiumVoices(context: ProviderContext, apiKey: string): Promise<GradiumVoicePayload[]> {
  const voices: GradiumVoicePayload[] = []
  const limit = 100
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${getBaseUrl(context)}/voices/`)
    url.searchParams.set('skip', String(page * limit))
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('include_catalog', 'true')
    const response = await fetchWithTimeout(url, {
      headers: { 'x-api-key': apiKey },
    }, context)
    if (!response.ok) return voices
    const payload = await readJsonResponse<GradiumVoicePayload[]>(response)
    const pageVoices = Array.isArray(payload) ? payload : []
    voices.push(...pageVoices)
    if (pageVoices.length < limit) break
  }
  return voices
}

function createGradiumAudioStream(request: SynthesizeRequest, context: ProviderContext, outputFormat: string): ReadableStream<Uint8Array> {
  const apiKey = getApiKey(context)
  const ws = new WebSocket(`${getWsUrl(context)}/speech/tts`, {
    headers: { 'x-api-key': apiKey },
  })
  let settled = false
  const timeoutMs = getProviderTimeoutMs(context)
  let timer: ReturnType<typeof setTimeout> | undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        settled = true
        ws.close()
        controller.error(new Error('Gradium text-to-speech stream timed out.'))
      }, timeoutMs)

      ws.on('open', () => {
        ws.send(JSON.stringify(compactObject({
          type: 'setup',
          voice_id: getVoiceId(request, context),
          model_name: getConfigString(context, 'ttsModel') ?? DEFAULT_MODEL,
          output_format: outputFormat,
          close_ws_on_eos: true,
        })))
        ws.send(JSON.stringify({ type: 'text', text: request.segment.text.trim() }))
        ws.send(JSON.stringify({ type: 'end_of_stream' }))
      })

      ws.on('message', data => {
        const message = parseWebSocketMessage(data)
        if (message.type === 'audio' && message.audio) {
          controller.enqueue(Buffer.from(message.audio, 'base64'))
        } else if (message.type === 'error') {
          settled = true
          clearStreamTimer(timer)
          ws.close()
          controller.error(new Error(message.message || message.error || 'Gradium text-to-speech stream failed.'))
        } else if (message.type === 'end_of_stream') {
          settled = true
          clearStreamTimer(timer)
          ws.close()
          controller.close()
        }
      })

      ws.on('error', error => {
        if (settled) return
        settled = true
        clearStreamTimer(timer)
        controller.error(error)
      })

      ws.on('close', () => {
        if (settled) return
        settled = true
        clearStreamTimer(timer)
        controller.close()
      })
    },
    cancel() {
      settled = true
      clearStreamTimer(timer)
      ws.close()
    },
  })
}

function parseWebSocketMessage(data: WebSocket.RawData): GradiumStreamMessage {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : String(data)
  try {
    return JSON.parse(text) as GradiumStreamMessage
  } catch {
    return { type: 'error', message: text }
  }
}

function parseGradiumTranscription(value: string): { text: string, raw: unknown[] | string } {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const messages: unknown[] = []
  const text: string[] = []
  for (const line of lines) {
    try {
      const message = JSON.parse(line) as GradiumStreamMessage
      messages.push(message)
      if ((message.type === 'text' || message.type === 'end_text') && message.text) text.push(message.text)
      if (message.type === 'error') throw new Error(message.message || message.error || 'Gradium speech-to-text failed.')
    } catch (error) {
      if (error instanceof Error && line.startsWith('{')) throw error
      text.push(line)
    }
  }
  return {
    text: text.join('').trim(),
    raw: messages.length ? messages : value,
  }
}

function getVoiceId(request: SynthesizeRequest, context: ProviderContext): string {
  return request.segment.voiceId ?? request.voiceId ?? request.segment.voice ?? request.voice ?? getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID
}

function normalizeVoice(voice: GradiumVoicePayload, provider: string): TtsVoice | null {
  if (!voice.uid) return null
  return {
    id: voice.uid,
    name: voice.name ?? voice.uid,
    locale: voice.language ?? undefined,
    provider,
    capabilities: { tts: true, ttsStreaming: true, voiceClone: !voice.is_catalog },
  }
}

function getDefaultVoice(provider: string, context: ProviderContext): TtsVoice {
  const id = getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID
  return { id, name: 'Gradium Default', provider }
}

function getApiKey(context: ProviderContext): string {
  const apiKey = getSecretString(context, 'apiKey')
  if (!apiKey) throw new Error('gradium apiKey is required in provider settings.')
  return apiKey
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
}

function getWsUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'wsUrl') ?? getBaseUrl(context).replace(/^http/i, 'ws') ?? DEFAULT_WS_URL)
}

function normalizeOutputFormat(value: string): string {
  const normalized = value.toLowerCase()
  if (GRADIUM_OUTPUT_FORMATS.includes(normalized)) return normalized
  if (normalized === 'mp3') return 'wav'
  return DEFAULT_OUTPUT_FORMAT
}

function getMimeType(format: string): string {
  if (format === 'opus') return 'audio/ogg'
  if (format.includes('ulaw') || format.includes('mulaw') || format.includes('alaw')) return 'audio/basic'
  if (format === 'pcm' || format.startsWith('pcm_')) return 'audio/pcm'
  return 'audio/wav'
}

async function resolveAudio(request: TranscribeRequest): Promise<{ data: Buffer, mimeType: string, fileName: string }> {
  if (request.audioData?.trim()) return parseAudioData(request.audioData.trim(), request.mimeType)
  if (request.url?.trim()) {
    const response = await fetch(request.url.trim())
    if (!response.ok) throw new Error(`Failed to download audio for Gradium transcription: ${response.status}`)
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || request.mimeType || 'audio/wav'
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType,
      fileName: getFileNameFromUrl(request.url.trim(), mimeType),
    }
  }
  throw new Error('Gradium ASR requires file, url, or audioData.')
}

function parseAudioData(value: string, mimeType?: string): { data: Buffer, mimeType: string, fileName: string } {
  const match = /^data:([^;,]+)?;base64,(.*)$/is.exec(value)
  const resolvedMimeType = match?.[1] || mimeType || 'audio/wav'
  return {
    data: Buffer.from(match?.[2] ?? value, 'base64'),
    mimeType: resolvedMimeType,
    fileName: getAudioFileName(resolvedMimeType),
  }
}

function getGradiumInputFormat(mimeType: string): string {
  if (mimeType.includes('opus') || mimeType.includes('ogg')) return 'opus'
  if (mimeType.includes('pcm')) return 'pcm'
  return 'wav'
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'auto') return undefined
  return normalized.split(/[-_]/)[0]
}

function getAudioFileName(mimeType: string): string {
  if (mimeType.includes('opus') || mimeType.includes('ogg')) return 'audio.ogg'
  if (mimeType.includes('pcm')) return 'audio.pcm'
  return 'audio.wav'
}

function getFileNameFromUrl(value: string, mimeType: string): string {
  try {
    return new URL(value).pathname.split('/').filter(Boolean).pop() || getAudioFileName(mimeType)
  } catch {
    return getAudioFileName(mimeType)
  }
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, context: ProviderContext): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), getProviderTimeoutMs(context))
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function getConfigString(context: ProviderContext, key: string): string | undefined {
  const value = context.config?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function getConfigNumber(context: ProviderContext, key: string): number | undefined {
  const raw = context.config?.[key]
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function getSecretString(context: ProviderContext, key: string): string | undefined {
  const value = context.secrets?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function clearStreamTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) clearTimeout(timer)
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')) as Partial<T>
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  if (!text.trim()) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    return { error: text } as T
  }
}
