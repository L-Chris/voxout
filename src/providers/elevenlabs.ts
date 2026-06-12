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
  readonly capabilities = { tts: true, ttsStreaming: true, asr: true, soundEffects: true, isolation: true, voiceDesign: true, voiceClone: true }
  readonly fields = [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'baseUrl', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'ttsModel', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: ELEVENLABS_TTS_MODELS },
    { key: 'asrModel', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: ELEVENLABS_ASR_MODELS },
    { key: 'soundEffectModel', label: 'Sound Effect Model', type: 'text' as const, placeholder: DEFAULT_SOUND_EFFECT_MODEL },
    { key: 'voiceDesignModel', label: 'Voice Design Model', type: 'text' as const, placeholder: 'eleven_multilingual_ttv_v2' },
    { key: 'defaultVoiceId', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'outputFormat', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT },
    { key: 'promptInfluence', label: 'Prompt Influence', type: 'number' as const, placeholder: '0.3' },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) return [getDefaultVoice(this.id, context)]

    const url = new URL(`${getApiRoot(context)}/v2/voices`)
    url.searchParams.set('page_size', '100')
    const response = await fetch(url, {
      headers: { 'xi-api-key': apiKey },
    })
    if (!response.ok) return [getDefaultVoice(this.id, context)]

    const payload = await response.json() as { voices?: ElevenLabsVoicePayload[] }
    const voices = (payload.voices ?? [])
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
    return voices.length ? voices : [getDefaultVoice(this.id, context)]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const apiKey = getApiKey(context)
    const text = request.segment.text.trim()
    const voiceId = request.segment.voiceId ?? request.voiceId ?? request.segment.voice ?? request.voice ?? getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID
    const outputFormat = request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/text-to-speech/${encodeURIComponent(voiceId)}`)
    url.searchParams.set('output_format', outputFormat)

    const response = await postJsonAudio(url, {
      text,
      model_id: getConfigString(context, 'ttsModel') ?? DEFAULT_TTS_MODEL,
      language_code: normalizeLanguageCode(request.lang),
    }, apiKey)
    return response
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    if (request.streamFormat === 'sse') throw new Error('ElevenLabs TTS streaming supports stream_format "audio" only.')
    const apiKey = getApiKey(context)
    const text = request.segment.text.trim()
    const voiceId = request.segment.voiceId ?? request.voiceId ?? request.segment.voice ?? request.voice ?? getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID
    const outputFormat = request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/text-to-speech/${encodeURIComponent(voiceId)}/stream`)
    url.searchParams.set('output_format', outputFormat)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify(compactObject({
        text,
        model_id: getConfigString(context, 'ttsModel') ?? DEFAULT_TTS_MODEL,
        language_code: normalizeLanguageCode(request.lang),
      })),
    })
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `ElevenLabs text-to-speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('ElevenLabs text-to-speech stream response was empty.')
    return {
      stream: response.body,
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const apiKey = getApiKey(context)
    const form = new FormData()
    form.set('model_id', request.model ?? getConfigString(context, 'asrModel') ?? DEFAULT_ASR_MODEL)
    const language = normalizeLanguageCode(request.language)
    if (language) form.set('language_code', language)

    if (request.url?.trim()) {
      form.set('source_url', request.url.trim())
    } else if (request.audioData?.trim()) {
      const audio = parseAudioData(request.audioData.trim(), request.mimeType)
      form.set('file', new Blob([audio.data], { type: audio.mimeType }), audio.fileName)
    } else {
      throw new Error('ElevenLabs ASR requires url or audioData.')
    }

    const response = await fetch(`${getBaseUrl(context)}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
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
    const apiKey = getApiKey(context)
    const outputFormat = request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/sound-generation`)
    if (outputFormat) url.searchParams.set('output_format', outputFormat)

    return postJsonAudio(url, {
      text: request.prompt.trim(),
      model_id: getConfigString(context, 'soundEffectModel') ?? getConfigString(context, 'model') ?? DEFAULT_SOUND_EFFECT_MODEL,
      duration_seconds: normalizeDurationSeconds(request.durationSeconds) ?? normalizeDurationSeconds(getConfigNumber(context, 'durationSeconds')),
      prompt_influence: normalizePromptInfluence(request.promptInfluence) ?? normalizePromptInfluence(getConfigNumber(context, 'promptInfluence')),
      loop: request.loop ?? getConfigBoolean(context, 'loop'),
    }, apiKey, 'ElevenLabs sound effect')
  }

  async isolateAudio(request: AudioIsolationRequest, context: ProviderContext = {}) {
    const apiKey = getApiKey(context)
    const audio = parseAudioData(request.audioData, request.mimeType)
    const form = new FormData()
    form.set('audio', new Blob([audio.data], { type: audio.mimeType }), audio.fileName)
    form.set('file_format', request.fileFormat ?? 'other')
    if (request.previewBase64) form.set('preview_b64', request.previewBase64)

    const response = await fetch(`${getBaseUrl(context)}/audio-isolation`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    })
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = buffer.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `ElevenLabs audio isolation request failed: ${response.status}`)
    }
    return {
      audio: buffer,
      mimeType: response.headers.get('content-type')?.split(';')[0] || audio.mimeType,
      durationMs: 0,
    }
  }

  async designVoice(request: VoiceDesignRequest, context: ProviderContext = {}): Promise<VoiceDesignResult> {
    const apiKey = getApiKey(context)
    const outputFormat = request.outputFormat ?? getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${getBaseUrl(context)}/text-to-voice/design`)
    url.searchParams.set('output_format', outputFormat)

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify(compactObject({
        voice_description: request.voiceDescription,
        model_id: request.model ?? getConfigString(context, 'voiceDesignModel') ?? 'eleven_multilingual_ttv_v2',
        text: request.text,
        auto_generate_text: request.autoGenerateText,
        loudness: request.loudness,
        seed: request.seed,
        guidance_scale: request.guidanceScale,
        quality: request.quality,
        reference_audio_base64: request.referenceAudioData ? stripDataUrlPrefix(request.referenceAudioData) : undefined,
        prompt_strength: request.promptStrength,
      })),
    })
    const payload = await readJsonResponse<ElevenLabsDesignPayload>(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `ElevenLabs voice design request failed: ${response.status}`)
    }
    const voices = (payload.previews ?? [])
      .filter(preview => preview.generated_voice_id)
      .map((preview, index) => {
        const mediaType = preview.media_type || getMimeTypeFromOutputFormat(outputFormat)
        return {
          voiceId: preview.generated_voice_id ?? `elevenlabs-preview-${index + 1}`,
          providerVoiceId: preview.generated_voice_id,
          name: request.name ?? `ElevenLabs Voice ${index + 1}`,
          description: request.voiceDescription,
          language: preview.language,
          previewAudioData: preview.audio_base_64
            ? `data:${mediaType};base64,${stripDataUrlPrefix(preview.audio_base_64)}`
            : undefined,
          previewMimeType: mediaType,
          durationSeconds: preview.duration_secs,
          metadata: {
            model: request.model ?? getConfigString(context, 'voiceDesignModel') ?? 'eleven_multilingual_ttv_v2',
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
    const apiKey = getApiKey(context)
    const audio = parseAudioData(request.audioData, request.mimeType)
    const form = new FormData()
    form.set('name', request.name)
    if (request.description) form.set('description', request.description)
    form.set('files[]', new Blob([audio.data], { type: audio.mimeType }), request.fileName || audio.fileName)

    const response = await fetch(`${getBaseUrl(context)}/voices/add`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
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
        voiceId: payload.voice_id,
        providerVoiceId: payload.voice_id,
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

async function postJsonAudio(url: URL, body: Record<string, unknown>, apiKey: string, label = 'ElevenLabs text-to-speech') {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'xi-api-key': apiKey,
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
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
    durationMs: 0,
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')) as Partial<T>
}

function getApiKey(context: ProviderContext): string {
  const apiKey = getSecretString(context, 'apiKey')
  if (!apiKey) throw new Error('elevenlabs apiKey is required in provider settings.')
  return apiKey
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
}

function getApiRoot(context: ProviderContext): string {
  return getBaseUrl(context).replace(/\/v1$/i, '')
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
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

function getConfigNumber(context: ProviderContext, key: string): number | undefined {
  const raw = context.config?.[key]
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function getConfigBoolean(context: ProviderContext, key: string): boolean | undefined {
  const value = context.config?.[key]
  if (typeof value === 'boolean') return value
  return undefined
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
  const id = getConfigString(context, 'defaultVoiceId') ?? DEFAULT_VOICE_ID
  return { id, name: id, provider }
}

function parseAudioData(value: string, mimeType?: string): { data: Buffer, mimeType: string, fileName: string } {
  const dataUrlMatch = /^data:([^;,]+)?;base64,(.*)$/is.exec(value)
  if (dataUrlMatch) {
    const resolvedMimeType = dataUrlMatch[1] || mimeType || 'audio/mpeg'
    return {
      data: Buffer.from(dataUrlMatch[2] ?? '', 'base64'),
      mimeType: resolvedMimeType,
      fileName: getAudioFileName(resolvedMimeType),
    }
  }
  const resolvedMimeType = mimeType || 'audio/mpeg'
  return {
    data: Buffer.from(value, 'base64'),
    mimeType: resolvedMimeType,
    fileName: getAudioFileName(resolvedMimeType),
  }
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',')
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
}

function getMimeTypeFromOutputFormat(outputFormat: string): string {
  const normalized = outputFormat.toLowerCase()
  if (normalized.startsWith('pcm_')) return 'audio/wav'
  if (normalized.startsWith('ulaw_')) return 'audio/basic'
  return 'audio/mpeg'
}

function getAudioFileName(mimeType: string): string {
  if (mimeType.includes('wav')) return 'audio.wav'
  if (mimeType.includes('mp4')) return 'audio.mp4'
  if (mimeType.includes('webm')) return 'audio.webm'
  return 'audio.mp3'
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

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    return { error: text } as T
  }
}

function getPayloadError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  if (typeof error === 'string') return error
  const detail = (payload as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  return undefined
}
