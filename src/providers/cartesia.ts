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
  appendJsonParamsToForm,
  compactObject,
  fetchWithProviderTimeout,
  getConfigString,
  getPayloadError,
  getSecretString,
  mergeJsonBody,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

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
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'api_version', label: 'API Version', type: 'text' as const, placeholder: DEFAULT_API_VERSION },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: CARTESIA_TTS_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: CARTESIA_ASR_MODELS },
    { key: 'default_voice_id', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'output_format', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT, options: ['mp3', 'wav', 'pcm'] },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) return [getDefaultVoice(this.id, context)]

    const voicePayloads = await listCartesiaVoices(context, api_key)
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
      mime_type: response.headers.get('content-type')?.split(';')[0] || getMimeType(request, context),
      duration_ms: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response = await this.createSpeech(request, context, '/tts/sse')
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `Cartesia text-to-speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('Cartesia text-to-speech stream response was empty.')
    if ((request.stream_format ?? 'audio') === 'sse') {
      return {
        stream: response.body,
        mime_type: response.headers.get('content-type')?.split(';')[0] || 'text/event-stream',
      }
    }
    return {
      stream: decodeCartesiaAudioSseStream(response.body),
      mime_type: getMimeType(request, context),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const api_key = getApiKey(context)
    const form = new FormData()
    form.set('model', request.model ?? getConfigString(context, 'asr_model') ?? DEFAULT_ASR_MODEL)
    form.set('file', new Blob([request.file.data], { type: request.file.mime_type }), request.file.file_name)
    form.set('timestamp_granularities[]', 'word')
    const language = normalizeLanguage(request.language)
    if (language) form.set('language', language)

    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/stt`, {
      method: 'POST',
      headers: getHeaders(context, api_key),
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
    const api_key = getApiKey(context)
    const audio = request.audio_sample
    const form = new FormData()
    form.set('clip', new Blob([audio.data], { type: audio.mime_type }), audio.file_name)
    form.set('name', request.name)
    form.set('language', normalizeLanguage(request.language) ?? 'en')
    if (request.description) form.set('description', request.description)
    const base_voice_id = getConfigString(context, 'base_voice_id')
    if (base_voice_id) form.set('base_voice_id', base_voice_id)
    appendJsonParamsToForm(form, request.extra_params)

    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/voices/clone`, {
      method: 'POST',
      headers: getHeaders(context, api_key),
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
        voice_id: payload.id,
        provider_voice_id: payload.id,
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
    const api_key = getApiKey(context)
    return fetchWithProviderTimeout(`${getBaseUrl(context)}${path}`, {
      method: 'POST',
      headers: {
        ...getHeaders(context, api_key),
        'content-type': 'application/json',
      },
      body: JSON.stringify(mergeJsonBody({
        model_id: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
        transcript: request.text.trim(),
        voice: {
          mode: 'id',
          id: request.voice ?? getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID,
        },
        output_format: normalizeOutputFormat(request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT),
        language: normalizeLanguage(request.lang),
        generation_config: compactObject({
          speed: normalizeSpeed(request.speed),
        }),
        pronunciation_dict_id: getConfigString(context, 'pronunciation_dict_id'),
      }, request.extra_params)),
    }, context)
  }
}

async function listCartesiaVoices(context: ProviderContext, api_key: string): Promise<CartesiaVoicePayload[]> {
  const voices: CartesiaVoicePayload[] = []
  let startingAfter: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${getBaseUrl(context)}/voices`)
    url.searchParams.set('limit', '100')
    if (startingAfter) url.searchParams.set('starting_after', startingAfter)
    const response = await fetchWithProviderTimeout(url, {
      headers: getHeaders(context, api_key),
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
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('cartesia api_key is required in provider settings.')
  return api_key
}

function getHeaders(context: ProviderContext, api_key: string): Record<string, string> {
  return {
    authorization: `Bearer ${api_key}`,
    'Cartesia-Version': getConfigString(context, 'api_version') ?? DEFAULT_API_VERSION,
  }
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
}

function normalizeOutputFormat(value: string): Record<string, string | number> {
  const normalized = value.toLowerCase()
  if (normalized === 'wav') return { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 }
  if (normalized === 'pcm' || normalized === 'raw') return { container: 'raw', encoding: 'pcm_s16le', sample_rate: 44100 }
  return { container: 'mp3', bit_rate: 128000, sample_rate: 44100 }
}

function getMimeType(request: SynthesizeRequest, context: ProviderContext): string {
  const normalized = (request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT).toLowerCase()
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
  const id = getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
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

function normalizeSpeed(value: number | undefined): number | undefined {
  if (value == null) return undefined
  return Number.isFinite(value) && value > 0 ? value : undefined
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
