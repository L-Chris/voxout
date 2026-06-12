import { Blob } from 'node:buffer'
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

const DEFAULT_BASE_URL = 'https://api.cartesia.ai'
const DEFAULT_API_VERSION = '2026-03-01'
const DEFAULT_TTS_MODEL = 'sonic-3.5'
const DEFAULT_ASR_MODEL = 'ink-whisper'
const DEFAULT_VOICE_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4'
const DEFAULT_OUTPUT_FORMAT = 'mp3'
const CARTESIA_TTS_MODELS = ['sonic-3.5', 'sonic-3', 'sonic-latest']
const CARTESIA_ASR_MODELS = [DEFAULT_ASR_MODEL]

interface CartesiaVoicePayload {
  id?: string
  name?: string
  description?: string
  gender?: string
  language?: string
  country?: string
  created_at?: string
}

interface CartesiaVoiceListPayload {
  data?: CartesiaVoicePayload[]
  has_more?: boolean
  next_page?: string | null
}

interface CartesiaTranscriptPayload {
  text?: string
  language?: string
  duration?: number
  words?: Array<{
    word?: string
    start?: number
    end?: number
  }>
  error?: unknown
  message?: string
  detail?: unknown
}

export class CartesiaProvider implements TtsProvider, AsrProvider, VoiceCloneProvider {
  readonly id = 'cartesia'
  readonly name = 'Cartesia'
  readonly capabilities = { tts: true, ttsStreaming: true, asr: true, voiceClone: true }
  readonly fields = [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'baseUrl', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'apiVersion', label: 'API Version', type: 'text' as const, placeholder: DEFAULT_API_VERSION },
    { key: 'ttsModel', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: CARTESIA_TTS_MODELS },
    { key: 'asrModel', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: CARTESIA_ASR_MODELS },
    { key: 'defaultVoiceId', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'outputFormat', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT, options: ['mp3', 'wav', 'pcm'] },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) return [getDefaultVoice(this.id, context)]

    const voicePayloads = await listCartesiaVoices(context, apiKey)
    const voices = voicePayloads
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
    return voices.length ? voices : [getDefaultVoice(this.id, context)]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response = await this.createSpeech(request, context, '/tts/bytes')
    const audio = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `Cartesia text-to-speech request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('Cartesia text-to-speech response audio was empty.')
    return {
      audio,
      mimeType: response.headers.get('content-type')?.split(';')[0] || getMimeType(request, context),
      durationMs: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response = await this.createSpeech(request, context, '/tts/sse')
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `Cartesia text-to-speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('Cartesia text-to-speech stream response was empty.')
    if ((request.streamFormat ?? 'audio') === 'sse') {
      return {
        stream: response.body,
        mimeType: response.headers.get('content-type')?.split(';')[0] || 'text/event-stream',
      }
    }
    return {
      stream: decodeCartesiaAudioSseStream(response.body),
      mimeType: getMimeType(request, context),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const apiKey = getApiKey(context)
    const audio = await resolveAudio(request)
    const form = new FormData()
    form.set('model', request.model ?? getConfigString(context, 'asrModel') ?? DEFAULT_ASR_MODEL)
    form.set('file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName)
    form.set('timestamp_granularities[]', 'word')
    const language = normalizeLanguage(request.language)
    if (language) form.set('language', language)

    const response = await fetchWithTimeout(`${getBaseUrl(context)}/stt`, {
      method: 'POST',
      headers: getHeaders(context, apiKey),
      body: form,
    }, context)
    const payload = await readJsonResponse<CartesiaTranscriptPayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `Cartesia speech-to-text request failed: ${response.status}`)
    }
    const text = payload.text?.trim() ?? ''
    if (!text) throw new Error('Cartesia speech-to-text response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      segments: normalizeWords(payload.words),
      raw: request.format === 'raw' ? payload : undefined,
    }
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const apiKey = getApiKey(context)
    const audio = parseAudioData(request.audioData, request.mimeType)
    const form = new FormData()
    form.set('clip', new Blob([audio.data], { type: audio.mimeType }), request.fileName || audio.fileName)
    form.set('name', request.name)
    form.set('language', normalizeLanguage(request.language) ?? 'en')
    if (request.description) form.set('description', request.description)
    const baseVoiceId = getConfigString(context, 'baseVoiceId')
    if (baseVoiceId) form.set('base_voice_id', baseVoiceId)

    const response = await fetchWithTimeout(`${getBaseUrl(context)}/voices/clone`, {
      method: 'POST',
      headers: getHeaders(context, apiKey),
      body: form,
    }, context)
    const payload = await readJsonResponse<CartesiaVoicePayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `Cartesia voice clone request failed: ${response.status}`)
    }
    if (!payload.id) throw new Error('Cartesia voice clone response did not include id.')
    return {
      provider: this.id,
      voice: {
        voiceId: payload.id,
        providerVoiceId: payload.id,
        name: payload.name ?? request.name,
        description: payload.description ?? request.description,
        language: payload.language ?? request.language,
        metadata: {
          created_at: payload.created_at ?? null,
        },
      },
      raw: payload,
    }
  }

  private createSpeech(request: SynthesizeRequest, context: ProviderContext, path: '/tts/bytes' | '/tts/sse'): Promise<Response> {
    const apiKey = getApiKey(context)
    return fetchWithTimeout(`${getBaseUrl(context)}${path}`, {
      method: 'POST',
      headers: {
        ...getHeaders(context, apiKey),
        'content-type': 'application/json',
      },
      body: JSON.stringify(compactObject({
        model_id: getConfigString(context, 'ttsModel') ?? DEFAULT_TTS_MODEL,
        transcript: request.segment.text.trim(),
        voice: {
          mode: 'id',
          id: request.segment.voiceId ?? request.voiceId ?? request.segment.voice ?? request.voice ?? getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID,
        },
        output_format: normalizeOutputFormat(request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT),
        language: normalizeLanguage(request.lang),
        generation_config: compactObject({
          speed: normalizeSpeed(request.rate),
        }),
        pronunciation_dict_id: getConfigString(context, 'pronunciationDictId'),
      })),
    }, context)
  }
}

async function listCartesiaVoices(context: ProviderContext, apiKey: string): Promise<CartesiaVoicePayload[]> {
  const voices: CartesiaVoicePayload[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${getBaseUrl(context)}/voices`)
    url.searchParams.set('limit', '100')
    if (startingAfter) url.searchParams.set('starting_after', startingAfter)
    const response = await fetchWithTimeout(url, {
      headers: getHeaders(context, apiKey),
    }, context)
    if (!response.ok) return voices

    const payload = await readJsonResponse<CartesiaVoiceListPayload>(response)
    voices.push(...(payload.data ?? []))
    if (!payload.has_more || !payload.next_page) break
    startingAfter = payload.next_page
  }
  return voices
}

function getApiKey(context: ProviderContext): string {
  const apiKey = getSecretString(context, 'apiKey')
  if (!apiKey) throw new Error('cartesia apiKey is required in provider settings.')
  return apiKey
}

function getHeaders(context: ProviderContext, apiKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${apiKey}`,
    'Cartesia-Version': getConfigString(context, 'apiVersion') ?? DEFAULT_API_VERSION,
  }
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
}

function normalizeOutputFormat(value: string): Record<string, string | number> {
  const normalized = value.toLowerCase()
  if (normalized === 'wav') return { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }
  if (normalized === 'pcm' || normalized === 'raw') return { container: 'raw', encoding: 'pcm_s16le', sample_rate: 44100 }
  return { container: 'mp3', bit_rate: 128000, sample_rate: 44100 }
}

function getMimeType(request: SynthesizeRequest, context: ProviderContext): string {
  const normalized = (request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT).toLowerCase()
  if (normalized === 'wav') return 'audio/wav'
  if (normalized === 'pcm' || normalized === 'raw') return 'audio/pcm'
  return 'audio/mpeg'
}

function normalizeVoice(voice: CartesiaVoicePayload, provider: string): TtsVoice | null {
  if (!voice.id) return null
  return {
    id: voice.id,
    name: voice.name ?? voice.id,
    locale: normalizeLocale(voice.language, voice.country),
    gender: voice.gender,
    provider,
  }
}

function getDefaultVoice(provider: string, context: ProviderContext): TtsVoice {
  const id = getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID
  return { id, name: id, provider }
}

function normalizeLocale(language: string | undefined, country: string | undefined): string | undefined {
  if (!language) return undefined
  return country ? `${language}-${country}` : language
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'auto') return undefined
  return normalized.split(/[-_]/)[0]
}

function normalizeSpeed(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

async function resolveAudio(request: TranscribeRequest): Promise<{ data: Buffer, mimeType: string, fileName: string }> {
  if (request.audioData?.trim()) return parseAudioData(request.audioData.trim(), request.mimeType)
  if (request.url?.trim()) {
    const response = await fetch(request.url.trim())
    if (!response.ok) throw new Error(`Failed to download audio for Cartesia transcription: ${response.status}`)
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || request.mimeType || 'audio/mpeg'
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType,
      fileName: getFileNameFromUrl(request.url.trim(), mimeType),
    }
  }
  throw new Error('Cartesia ASR requires file, url, or audioData.')
}

function parseAudioData(value: string, mimeType?: string): { data: Buffer, mimeType: string, fileName: string } {
  const match = /^data:([^;,]+)?;base64,(.*)$/is.exec(value)
  const resolvedMimeType = match?.[1] || mimeType || 'audio/mpeg'
  return {
    data: Buffer.from(match?.[2] ?? value, 'base64'),
    mimeType: resolvedMimeType,
    fileName: getAudioFileName(resolvedMimeType),
  }
}

function getAudioFileName(mimeType: string): string {
  if (mimeType.includes('wav')) return 'audio.wav'
  if (mimeType.includes('flac')) return 'audio.flac'
  if (mimeType.includes('ogg')) return 'audio.ogg'
  if (mimeType.includes('webm')) return 'audio.webm'
  return 'audio.mp3'
}

function getFileNameFromUrl(value: string, mimeType: string): string {
  try {
    return new URL(value).pathname.split('/').filter(Boolean).pop() || getAudioFileName(mimeType)
  } catch {
    return getAudioFileName(mimeType)
  }
}

function normalizeWords(words: CartesiaTranscriptPayload['words']) {
  if (!Array.isArray(words)) return undefined
  return words
    .filter(word => typeof word.word === 'string')
    .map(word => ({
      from: Number(word.start ?? 0),
      to: Number(word.end ?? word.start ?? 0),
      content: String(word.word ?? ''),
    }))
}

function decodeCartesiaAudioSseStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  return stream.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })
      buffer = flushCartesiaSseBuffer(buffer, controller)
    },
    flush(controller) {
      flushCartesiaSseBuffer(buffer + '\n\n', controller)
    },
  }))
}

function flushCartesiaSseBuffer(buffer: string, controller: TransformStreamDefaultController<Uint8Array>): string {
  let boundary = buffer.indexOf('\n\n')
  while (boundary >= 0) {
    const block = buffer.slice(0, boundary)
    buffer = buffer.slice(boundary + 2)
    const data = block
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('')
    if (data && data !== '[DONE]') {
      try {
        const payload = JSON.parse(data) as { data?: string }
        if (payload.data) controller.enqueue(Buffer.from(payload.data, 'base64'))
      } catch {
        // Ignore keepalive or metadata frames that are not JSON.
      }
    }
    boundary = buffer.indexOf('\n\n')
  }
  return buffer
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

function getSecretString(context: ProviderContext, key: string): string | undefined {
  const value = context.secrets?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
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

function getPayloadError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as { error?: unknown, message?: unknown, detail?: unknown }
  if (typeof value.error === 'string') return value.error
  if (typeof value.message === 'string') return value.message
  if (typeof value.detail === 'string') return value.detail
  return undefined
}
