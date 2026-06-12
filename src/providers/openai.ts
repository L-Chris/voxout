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

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'
const DEFAULT_TTS_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_ASR_MODEL = 'gpt-4o-transcribe'
const DEFAULT_VOICE = 'alloy'
const DEFAULT_RESPONSE_FORMAT = 'mp3'
const OPENAI_TTS_MODELS = [
  'gpt-4o-mini-tts',
  'tts-1',
  'tts-1-hd',
]
const OPENAI_ASR_MODELS = [
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-diarize',
  'whisper-1',
]

interface OpenAiVoicePayload {
  id?: string
  name?: string
  object?: string
  created_at?: number
}

interface OpenAiTranscriptionPayload {
  text?: string
  segments?: Array<{
    start?: number
    end?: number
    text?: string
  }>
}

export class OpenAiProvider implements TtsProvider, AsrProvider, VoiceCloneProvider {
  readonly id = 'openai'
  readonly name = 'OpenAI'
  readonly capabilities = { tts: true, ttsStreaming: true, asr: true, voiceClone: true }
  readonly fields = [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'baseUrl', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'ttsModel', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: OPENAI_TTS_MODELS },
    { key: 'asrModel', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: OPENAI_ASR_MODELS },
    { key: 'defaultVoice', label: 'Default Voice', type: 'text' as const, placeholder: DEFAULT_VOICE },
    { key: 'responseFormat', label: 'Response Format', type: 'text' as const, placeholder: DEFAULT_RESPONSE_FORMAT },
  ]

  async listVoices(): Promise<TtsVoice[]> {
    return OPENAI_PRESET_VOICES.map(voice => ({
      ...voice,
      capabilities: this.capabilities,
    }))
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const responseFormat = normalizeResponseFormat(request.outputFormat ?? getConfigString(context, 'responseFormat') ?? DEFAULT_RESPONSE_FORMAT)
    const response = await this.createSpeech(request, context, responseFormat)
    const audio = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `OpenAI speech request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('OpenAI speech response audio was empty.')
    return {
      audio,
      mimeType: getMimeType(responseFormat, response.headers.get('content-type') ?? undefined),
      durationMs: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const responseFormat = normalizeResponseFormat(request.outputFormat ?? getConfigString(context, 'responseFormat') ?? DEFAULT_RESPONSE_FORMAT)
    const streamFormat = request.streamFormat ?? 'audio'
    const response = await this.createSpeech(request, context, responseFormat, streamFormat)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `OpenAI speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('OpenAI speech stream response was empty.')
    return {
      stream: response.body,
      mimeType: streamFormat === 'sse'
        ? response.headers.get('content-type')?.split(';')[0] || 'text/event-stream'
        : getMimeType(responseFormat, response.headers.get('content-type') ?? undefined),
    }
  }

  private async createSpeech(
    request: SynthesizeRequest,
    context: ProviderContext,
    responseFormat: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
    streamFormat?: 'audio' | 'sse',
  ): Promise<Response> {
    const apiKey = getApiKey(context)
    const text = request.text.trim()
    const response = await fetch(`${getBaseUrl(context)}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(compactObject({
        model: request.model ?? getConfigString(context, 'ttsModel') ?? DEFAULT_TTS_MODEL,
        input: text,
        voice: request.voice ?? getConfigString(context, 'defaultVoice') ?? DEFAULT_VOICE,
        response_format: responseFormat,
        speed: normalizeSpeed(request.speed),
        stream_format: streamFormat,
        instructions: normalizeInstructions(request.instructions),
      })),
    })
    return response
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const apiKey = getApiKey(context)
    const audio = parseAudioData(request.audioData, request.mimeType)
    const form = new FormData()
    form.set('name', request.name)
    if (request.consent) form.set('consent', request.consent)
    form.set('audio_sample', new Blob([audio.data], { type: audio.mimeType }), request.fileName || audio.fileName)

    const response = await fetch(`${getBaseUrl(context)}/audio/voices`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    })
    const payload = await readJsonResponse<OpenAiVoicePayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `OpenAI voice clone request failed: ${response.status}`)
    }
    if (!payload.id) throw new Error('OpenAI voice clone response did not include id.')
    return {
      provider: this.id,
      voice: {
        voiceId: payload.id,
        providerVoiceId: payload.id,
        name: payload.name ?? request.name,
        description: request.description,
        language: request.language,
        metadata: {
          object: payload.object ?? null,
          created_at: payload.created_at ?? null,
        },
      },
      raw: payload,
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const apiKey = getApiKey(context)
    const audio = await resolveTranscriptionAudio(request)
    const responseFormat = normalizeTranscriptionResponseFormat(request.responseFormat, request.format)
    const form = new FormData()
    form.set('model', request.model ?? getConfigString(context, 'asrModel') ?? DEFAULT_ASR_MODEL)
    form.set('file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName)
    form.set('response_format', responseFormat)
    const language = normalizeLanguage(request.language)
    if (language) form.set('language', language)
    const prompt = normalizePrompt(request.prompt)
    if (prompt) form.set('prompt', prompt)

    const response = await fetch(`${getBaseUrl(context)}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (responseFormat === 'text' || responseFormat === 'srt' || responseFormat === 'vtt') {
      const text = await response.text()
      if (!response.ok) throw new Error(text || `OpenAI transcription request failed: ${response.status}`)
      return {
        provider: this.id,
        format: request.format ?? 'txt',
        text: text.trim(),
      }
    }
    const payload = await readJsonResponse<OpenAiTranscriptionPayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `OpenAI transcription request failed: ${response.status}`)
    }
    const text = payload.text?.trim() ?? ''
    if (!text) throw new Error('OpenAI transcription response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      segments: payload.segments?.map(segment => ({
        from: segment.start ?? 0,
        to: segment.end ?? 0,
        content: segment.text ?? '',
      })),
      raw: request.format === 'raw' ? payload : undefined,
    }
  }
}

const OPENAI_PRESET_VOICES: TtsVoice[] = [
  { id: 'alloy', name: 'Alloy', locale: 'en-US', gender: 'Female', provider: 'openai' },
  { id: 'ash', name: 'Ash', locale: 'en-US', gender: 'Male', provider: 'openai' },
  { id: 'ballad', name: 'Ballad', locale: 'en-US', gender: 'Male', provider: 'openai' },
  { id: 'coral', name: 'Coral', locale: 'en-US', gender: 'Female', provider: 'openai' },
  { id: 'echo', name: 'Echo', locale: 'en-US', gender: 'Male', provider: 'openai' },
  { id: 'fable', name: 'Fable', locale: 'en-US', gender: 'Male', provider: 'openai' },
  { id: 'nova', name: 'Nova', locale: 'en-US', gender: 'Female', provider: 'openai' },
  { id: 'onyx', name: 'Onyx', locale: 'en-US', gender: 'Male', provider: 'openai' },
  { id: 'sage', name: 'Sage', locale: 'en-US', gender: 'Female', provider: 'openai' },
  { id: 'shimmer', name: 'Shimmer', locale: 'en-US', gender: 'Female', provider: 'openai' },
  { id: 'verse', name: 'Verse', locale: 'en-US', gender: 'Male', provider: 'openai' },
  { id: 'marin', name: 'Marin', locale: 'en-US', gender: 'Female', provider: 'openai' },
  { id: 'cedar', name: 'Cedar', locale: 'en-US', gender: 'Male', provider: 'openai' },
]

function getApiKey(context: ProviderContext): string {
  const apiKey = getSecretString(context, 'apiKey')
  if (!apiKey) throw new Error('openai apiKey is required in provider settings.')
  return apiKey
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
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

function normalizeResponseFormat(value: string): 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' {
  const normalized = value.toLowerCase()
  if (normalized === 'opus' || normalized === 'aac' || normalized === 'flac' || normalized === 'wav' || normalized === 'pcm') return normalized
  return 'mp3'
}

function normalizeTranscriptionResponseFormat(
  responseFormat: TranscribeRequest['responseFormat'],
  format: TranscribeRequest['format'],
): 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json' {
  if (responseFormat === 'text' || responseFormat === 'srt' || responseFormat === 'verbose_json' || responseFormat === 'vtt' || responseFormat === 'diarized_json') return responseFormat
  if (format === 'txt') return 'text'
  if (format === 'srt') return 'srt'
  if (format === 'vtt') return 'vtt'
  if (format === 'diarized_json') return 'diarized_json'
  if (format === 'raw') return 'verbose_json'
  return 'json'
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || trimmed === 'auto') return undefined
  return trimmed
}

function normalizePrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function getMimeType(format: string, responseType: string | undefined): string {
  const type = responseType?.split(';')[0]?.trim()
  if (type) return type
  if (format === 'wav' || format === 'pcm') return 'audio/wav'
  if (format === 'aac') return 'audio/aac'
  if (format === 'flac') return 'audio/flac'
  if (format === 'opus') return 'audio/ogg'
  return 'audio/mpeg'
}

function normalizeSpeed(value: number | undefined): number | undefined {
  if (value == null) return undefined
  return Number.isFinite(value) ? value : undefined
}

function normalizeInstructions(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function parseAudioData(value: string, mimeType: string | undefined): { data: Buffer, mimeType: string, fileName: string } {
  const match = /^data:([^;,]+)[^,]*,(.+)$/s.exec(value)
  const resolvedMimeType = match?.[1] ?? mimeType ?? 'application/octet-stream'
  const base64 = match?.[2] ?? value
  return {
    data: Buffer.from(base64, 'base64'),
    mimeType: resolvedMimeType,
    fileName: getAudioFileName(resolvedMimeType),
  }
}

async function resolveTranscriptionAudio(request: TranscribeRequest): Promise<{ data: Buffer, mimeType: string, fileName: string }> {
  if (request.audioData?.trim()) return parseAudioData(request.audioData.trim(), request.mimeType)
  if (request.url?.trim()) {
    const response = await fetch(request.url.trim())
    if (!response.ok) throw new Error(`Failed to download audio for OpenAI transcription: ${response.status}`)
    const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() || request.mimeType || 'application/octet-stream'
    return {
      data: Buffer.from(await response.arrayBuffer()),
      mimeType,
      fileName: getFileNameFromUrl(request.url.trim(), mimeType),
    }
  }
  throw new Error('OpenAI ASR requires file, url, or audioData.')
}

function getAudioFileName(mimeType: string): string {
  if (mimeType.includes('wav')) return 'voice.wav'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'voice.mp3'
  if (mimeType.includes('flac')) return 'voice.flac'
  if (mimeType.includes('ogg')) return 'voice.ogg'
  if (mimeType.includes('aac')) return 'voice.aac'
  if (mimeType.includes('webm')) return 'voice.webm'
  if (mimeType.includes('mp4')) return 'voice.mp4'
  return 'voice.bin'
}

function getFileNameFromUrl(value: string, mimeType: string): string {
  try {
    const name = new URL(value).pathname.split('/').filter(Boolean).pop()
    return name || getAudioFileName(mimeType)
  } catch {
    return getAudioFileName(mimeType)
  }
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
    return { error: { message: text.slice(0, 500) } } as T
  }
}

function getPayloadError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const value = payload as { error?: { message?: unknown }, message?: unknown, detail?: unknown }
  if (typeof value.error?.message === 'string') return value.error.message
  if (typeof value.message === 'string') return value.message
  if (typeof value.detail === 'string') return value.detail
  return undefined
}
