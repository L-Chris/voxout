import { Blob } from 'node:buffer'
import type {
  AsrProvider,
  AudioIsolationProvider,
  AudioIsolationRequest,
  ProviderContext,
  SoundEffectProvider,
  SoundEffectRequest,
  SynthesizeRequest,
  TranscribeRequest,
  TranscribeResult,
  TtsProvider,
  TtsVoice,
  VoiceCloneProvider,
  VoiceCloneRequest,
  VoiceCloneResult,
  VoiceDesignProvider,
  VoiceDesignRequest,
  VoiceDesignResult,
} from '../types.js'
import {
  compactObject,
  getConfigBoolean,
  getConfigNumber,
  getConfigString,
  getPayloadError,
  getSecretString,
  mergeJsonBody,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1'
const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2'
const DEFAULT_ASR_MODEL = 'scribe_v2'
const DEFAULT_SOUND_EFFECT_MODEL = 'eleven_text_to_sound_v2'
const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128'
const ELEVENLABS_TTS_MODELS = [
  'eleven_multilingual_v2',
  'eleven_turbo_v2_5',
  'eleven_flash_v2_5',
  'eleven_v3',
]
const ELEVENLABS_ASR_MODELS = ['scribe_v2', 'scribe_v1']

interface ElevenLabsVoicePayload {
  voice_id?: string
  name?: string
  labels?: Record<string, string>
  verified_languages?: Array<{ locale?: string, language?: string }>
}

interface ElevenLabsTranscriptPayload {
  text?: string
  words?: Array<{
    text?: string
    start?: number
    end?: number
  }>
}

interface ElevenLabsDesignPayload {
  previews?: Array<{
    audio_base_64?: string
    generated_voice_id?: string
    media_type?: string
    duration_secs?: number
    language?: string
  }>
  text?: string
}

interface ElevenLabsClonePayload {
  voice_id?: string
  requires_verification?: boolean
}

export class ElevenLabsProvider implements TtsProvider, AsrProvider, SoundEffectProvider, AudioIsolationProvider, VoiceDesignProvider, VoiceCloneProvider {
  readonly id = 'elevenlabs'
  readonly name = 'ElevenLabs'
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, sound_effects: true, isolation: true, voice_design: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: ELEVENLABS_TTS_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: ELEVENLABS_ASR_MODELS },
    { key: 'sound_effect_model', label: 'Sound Effect Model', type: 'text' as const, placeholder: DEFAULT_SOUND_EFFECT_MODEL },
    { key: 'voice_design_model', label: 'Voice Design Model', type: 'text' as const, placeholder: 'eleven_multilingual_ttv_v2' },
    { key: 'default_voice_id', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'output_format', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT },
    { key: 'prompt_influence', label: 'Prompt Influence', type: 'number' as const, placeholder: '0.3' },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) return [getDefaultVoice(this.id, context)]

    const url = new URL(`${getApiRoot(context)}/v2/voices`)
    url.searchParams.set('page_size', '100')
    const response = await fetch(url, {
      headers: { 'xi-api-key': api_key },
    })
    if (!response.ok) return [getDefaultVoice(this.id, context)]

    const payload = await response.json() as { voices?: ElevenLabsVoicePayload[] }
    const voices = (payload.voices ?? [])
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
    return voices.length ? voices : [getDefaultVoice(this.id, context)]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const api_key = getApiKey(context)
    const text = request.text.trim()
    const voice_id = request.voice ?? getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
    const output_format = request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/text-to-speech/${encodeURIComponent(voice_id)}`)
    url.searchParams.set('output_format', output_format)

    const response = await postJsonAudio(url, mergeJsonBody({
      text,
      model_id: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
      language_code: normalizeLanguageCode(request.lang),
      voice_settings: normalizeVoiceSettings(request),
    }, request.extra_params), api_key)
    return response
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    if (request.stream_format === 'sse') throw new Error('ElevenLabs TTS streaming supports stream_format "audio" only.')
    const api_key = getApiKey(context)
    const text = request.text.trim()
    const voice_id = request.voice ?? getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
    const output_format = request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/text-to-speech/${encodeURIComponent(voice_id)}/stream`)
    url.searchParams.set('output_format', output_format)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': api_key,
      },
      body: JSON.stringify(mergeJsonBody({
        text,
        model_id: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
        language_code: normalizeLanguageCode(request.lang),
        voice_settings: normalizeVoiceSettings(request),
      }, request.extra_params)),
    })
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `ElevenLabs text-to-speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('ElevenLabs text-to-speech stream response was empty.')
    return {
      stream: response.body,
      mime_type: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const api_key = getApiKey(context)
    const form = new FormData()
    form.set('model_id', request.model ?? getConfigString(context, 'asr_model') ?? DEFAULT_ASR_MODEL)
    const language = normalizeLanguageCode(request.language)
    if (language) form.set('language_code', language)

    form.set('file', new Blob([request.file.data], { type: request.file.mime_type }), request.file.file_name)

    const response = await fetch(`${getBaseUrl(context)}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': api_key },
      body: form,
    })
    const payload = await readJsonResponse<ElevenLabsTranscriptPayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `ElevenLabs speech-to-text request failed: ${response.status}`)
    }

    const text = payload.text?.trim() ?? ''
    if (!text) throw new Error('ElevenLabs speech-to-text response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      segments: normalizeWords(payload.words),
      raw: request.format === 'raw' ? payload : undefined,
    }
  }

  async createSoundEffect(request: SoundEffectRequest, context: ProviderContext = {}) {
    const api_key = getApiKey(context)
    const output_format = request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/sound-generation`)
    if (output_format) url.searchParams.set('output_format', output_format)

    return postJsonAudio(url, mergeJsonBody({
      text: request.prompt.trim(),
      model_id: request.model ?? getConfigString(context, 'sound_effect_model') ?? getConfigString(context, 'model') ?? DEFAULT_SOUND_EFFECT_MODEL,
      duration_seconds: normalizeDurationSeconds(request.duration_seconds) ?? normalizeDurationSeconds(getConfigNumber(context, 'duration_seconds')),
      prompt_influence: normalizePromptInfluence(request.prompt_influence) ?? normalizePromptInfluence(getConfigNumber(context, 'prompt_influence')),
      loop: request.loop ?? getConfigBoolean(context, 'loop'),
    }, request.extra_params), api_key, 'ElevenLabs sound effect')
  }

  async isolateAudio(request: AudioIsolationRequest, context: ProviderContext = {}) {
    const api_key = getApiKey(context)
    const form = new FormData()
    form.set('audio', new Blob([request.file.data], { type: request.file.mime_type }), request.file.file_name)
    form.set('file_format', request.file_format ?? 'other')
    if (request.preview_b64) form.set('preview_b64', request.preview_b64)

    const response = await fetch(`${getBaseUrl(context)}/audio-isolation`, {
      method: 'POST',
      headers: { 'xi-api-key': api_key },
      body: form,
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = buffer.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `ElevenLabs audio isolation request failed: ${response.status}`)
    }
    return {
      audio: buffer,
      mime_type: response.headers.get('content-type')?.split(';')[0] || request.file.mime_type,
      duration_ms: 0,
    }
  }

  async designVoice(request: VoiceDesignRequest, context: ProviderContext = {}): Promise<VoiceDesignResult> {
    const api_key = getApiKey(context)
    const options = request.extra_params ?? {}
    const passthroughOptions = { ...options }
    delete passthroughOptions.reference_audio_base64
    const output_format = request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/text-to-voice/design`)
    url.searchParams.set('output_format', output_format)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': api_key,
      },
      body: JSON.stringify(mergeJsonBody({
        voice_description: request.input,
        model_id: request.model ?? getConfigString(context, 'voice_design_model') ?? 'eleven_multilingual_ttv_v2',
        text: request.text,
        auto_generate_text: options.auto_generate_text,
        loudness: options.loudness,
        seed: options.seed,
        guidance_scale: options.guidance_scale,
        quality: options.quality,
        reference_audio_base64: typeof options.reference_audio_base64 === 'string' ? stripDataUrlPrefix(options.reference_audio_base64) : undefined,
        prompt_strength: options.prompt_strength,
      }, passthroughOptions)),
    })
    const payload = await readJsonResponse<ElevenLabsDesignPayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `ElevenLabs voice design request failed: ${response.status}`)
    }
    const voices = (payload.previews ?? [])
      .filter(preview => preview.generated_voice_id)
      .map((preview, index) => {
        const mediaType = preview.media_type || getMimeTypeFromOutputFormat(output_format)
        return {
          voice_id: preview.generated_voice_id ?? `elevenlabs-preview-${index + 1}`,
          provider_voice_id: preview.generated_voice_id,
          name: request.name ?? `ElevenLabs Voice ${index + 1}`,
          description: request.input,
          language: preview.language,
          preview_audio_data: preview.audio_base_64
            ? `data:${mediaType};base64,${stripDataUrlPrefix(preview.audio_base_64)}`
            : undefined,
          preview_mime_type: mediaType,
          duration_seconds: preview.duration_secs,
          metadata: {
            model: request.model ?? getConfigString(context, 'voice_design_model') ?? 'eleven_multilingual_ttv_v2',
          },
        }
      })
    return {
      provider: this.id,
      text: payload.text,
      voices,
      raw: payload,
    }
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const api_key = getApiKey(context)
    const audio = request.audio_sample
    const form = new FormData()
    form.set('name', request.name)
    if (request.description) form.set('description', request.description)
    form.set('files[]', new Blob([audio.data], { type: audio.mime_type }), audio.file_name)

    const response = await fetch(`${getBaseUrl(context)}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': api_key },
      body: form,
    })
    const payload = await readJsonResponse<ElevenLabsClonePayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `ElevenLabs voice clone request failed: ${response.status}`)
    }
    if (!payload.voice_id) throw new Error('ElevenLabs voice clone response did not include voice_id.')
    return {
      provider: this.id,
      voice: {
        voice_id: payload.voice_id,
        provider_voice_id: payload.voice_id,
        name: request.name,
        description: request.description,
        language: request.language,
        metadata: {
          requires_verification: payload.requires_verification ?? null,
        },
      },
      raw: payload,
    }
  }
}

async function postJsonAudio(url: URL, body: Record<string, unknown>, api_key: string, label = 'ElevenLabs text-to-speech') {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'xi-api-key': api_key,
    },
    body: JSON.stringify(compactObject(body)),
  })
  const arrayBuffer = await response.arrayBuffer()
  const audio = Buffer.from(arrayBuffer)
  if (!response.ok) {
    const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
    throw new Error(detail || `${label} request failed: ${response.status}`)
  }
  if (audio.length < 128) throw new Error(`${label} response audio was empty.`)
  return {
    audio,
    mime_type: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    duration_ms: 0,
  }
}

function getApiKey(context: ProviderContext): string {
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('elevenlabs api_key is required in provider settings.')
  return api_key
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
}

function getApiRoot(context: ProviderContext): string {
  return getBaseUrl(context).replace(/\/v1$/i, '')
}

function normalizeDurationSeconds(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(0.5, Math.min(30, Number(value.toFixed(2))))
}

function normalizePromptInfluence(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.min(1, value))
}

function normalizeLanguageCode(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'auto') return undefined
  return normalized
}

function normalizeVoiceSettings(request: SynthesizeRequest): { speed?: number } | undefined {
  const speed = normalizeSpeed(request.speed)
  return speed == null ? undefined : { speed }
}

function normalizeSpeed(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0.7, Math.min(1.2, Number(value.toFixed(2))))
}

function normalizeVoice(voice: ElevenLabsVoicePayload, provider: string): TtsVoice | null {
  if (!voice.voice_id) return null
  const locale = voice.verified_languages?.[0]?.locale ?? voice.verified_languages?.[0]?.language
  return {
    id: voice.voice_id,
    name: voice.name ?? voice.voice_id,
    locale,
    gender: voice.labels?.gender,
    provider,
  }
}

function getDefaultVoice(provider: string, context: ProviderContext): TtsVoice {
  const id = getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
  return { id, name: id, provider }
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',')
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
}

function getMimeTypeFromOutputFormat(output_format: string): string {
  const normalized = output_format.toLowerCase()
  if (normalized.startsWith('pcm_')) return 'audio/wav'
  if (normalized.startsWith('ulaw_')) return 'audio/basic'
  return 'audio/mpeg'
}

function normalizeWords(words: ElevenLabsTranscriptPayload['words']) {
  if (!Array.isArray(words)) return undefined
  return words
    .filter(word => typeof word.text === 'string')
    .map(word => ({
      from: Number(word.start ?? 0),
      to: Number(word.end ?? word.start ?? 0),
      content: String(word.text ?? ''),
    }))
}
