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
import {
  getConfigString,
  getPayloadError,
  getSecretString,
  mergeJsonBody,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

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
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, asr_streaming: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: OPENAI_TTS_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: OPENAI_ASR_MODELS },
    { key: 'default_voice', label: 'Default Voice', type: 'text' as const, placeholder: DEFAULT_VOICE },
    { key: 'response_format', label: 'Response Format', type: 'text' as const, placeholder: DEFAULT_RESPONSE_FORMAT },
  ]

  async listVoices(): Promise<TtsVoice[]> {
    return OPENAI_PRESET_VOICES.map(voice => ({
      ...voice,
      capabilities: this.capabilities,
    }))
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response_format = normalizeResponseFormat(request.output_format ?? getConfigString(context, 'response_format') ?? DEFAULT_RESPONSE_FORMAT)
    const response = await this.createSpeech(request, context, response_format)
    const audio = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `OpenAI speech request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('OpenAI speech response audio was empty.')
    return {
      audio,
      mime_type: getMimeType(response_format, response.headers.get('content-type') ?? undefined),
      duration_ms: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response_format = normalizeResponseFormat(request.output_format ?? getConfigString(context, 'response_format') ?? DEFAULT_RESPONSE_FORMAT)
    const stream_format = request.stream_format ?? 'audio'
    const response = await this.createSpeech(request, context, response_format, stream_format)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `OpenAI speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('OpenAI speech stream response was empty.')
    return {
      stream: response.body,
      mime_type: stream_format === 'sse'
        ? response.headers.get('content-type')?.split(';')[0] || 'text/event-stream'
        : getMimeType(response_format, response.headers.get('content-type') ?? undefined),
    }
  }

  private async createSpeech(
    request: SynthesizeRequest,
    context: ProviderContext,
    response_format: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm',
    stream_format?: 'audio' | 'sse',
  ): Promise<Response> {
    const api_key = getApiKey(context)
    const text = request.text.trim()
    const response = await fetch(`${getBaseUrl(context)}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(mergeJsonBody({
        model: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
        input: text,
        voice: request.voice ?? getConfigString(context, 'default_voice') ?? DEFAULT_VOICE,
        response_format: response_format,
        speed: normalizeSpeed(request.speed),
        stream_format: stream_format,
        instructions: normalizeInstructions(request.instructions),
      }, request.extra_params)),
    })
    return response
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const api_key = getApiKey(context)
    const audio = request.audio_sample
    const form = new FormData()
    form.set('name', request.name)
    if (request.consent) form.set('consent', request.consent)
    form.set('audio_sample', new Blob([audio.data], { type: audio.mime_type }), audio.file_name)

    const response = await fetch(`${getBaseUrl(context)}/audio/voices`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api_key}` },
      body: form,
    })
    const payload = await readJsonResponse<OpenAiVoicePayload>(response, 'errorMessageObject')
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `OpenAI voice clone request failed: ${response.status}`)
    }
    if (!payload.id) throw new Error('OpenAI voice clone response did not include id.')
    return {
      provider: this.id,
      voice: {
        voice_id: payload.id,
        provider_voice_id: payload.id,
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
    const api_key = getApiKey(context)
    const response_format = normalizeTranscriptionResponseFormat(request.response_format, request.format)
    const response = await fetch(`${getBaseUrl(context)}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api_key}` },
      body: createTranscriptionForm(request, context, response_format),
    })
    if (response_format === 'text' || response_format === 'srt' || response_format === 'vtt') {
      const text = await response.text()
      if (!response.ok) throw new Error(text || `OpenAI transcription request failed: ${response.status}`)
      return {
        provider: this.id,
        format: request.format ?? 'txt',
        text: text.trim(),
      }
    }
    const payload = await readJsonResponse<OpenAiTranscriptionPayload>(response, 'errorMessageObject')
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

  async streamTranscribe(request: TranscribeRequest, context: ProviderContext = {}) {
    const api_key = getApiKey(context)
    const response_format = normalizeTranscriptionResponseFormat(request.response_format, request.format)
    const form = createTranscriptionForm(request, context, response_format)
    form.set('stream', 'true')
    const response = await fetch(`${getBaseUrl(context)}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${api_key}` },
      body: form,
    })
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `OpenAI transcription stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('OpenAI transcription stream response was empty.')
    return {
      stream: response.body,
      mime_type: response.headers.get('content-type')?.split(';')[0] || 'text/event-stream',
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

function createTranscriptionForm(
  request: TranscribeRequest,
  context: ProviderContext,
  response_format: 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json',
): FormData {
  const form = new FormData()
  form.set('model', request.model ?? getConfigString(context, 'asr_model') ?? DEFAULT_ASR_MODEL)
  form.set('file', new Blob([request.file.data], { type: request.file.mime_type }), request.file.file_name)
  form.set('response_format', response_format)
  const language = normalizeLanguage(request.language)
  if (language) form.set('language', language)
  const prompt = normalizePrompt(request.prompt)
  if (prompt) form.set('prompt', prompt)
  return form
}

function getApiKey(context: ProviderContext): string {
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('openai api_key is required in provider settings.')
  return api_key
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
}

function normalizeResponseFormat(value: string): 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm' {
  const normalized = value.toLowerCase()
  if (normalized === 'opus' || normalized === 'aac' || normalized === 'flac' || normalized === 'wav' || normalized === 'pcm') return normalized
  return 'mp3'
}

function normalizeTranscriptionResponseFormat(
  response_format: TranscribeRequest['response_format'],
  format: TranscribeRequest['format'],
): 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json' {
  if (response_format === 'text' || response_format === 'srt' || response_format === 'verbose_json' || response_format === 'vtt' || response_format === 'diarized_json') return response_format
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
