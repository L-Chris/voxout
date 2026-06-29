import { Blob } from 'node:buffer'
import type {
  JsonObject,
  ProviderContext,
  ProviderFile,
  SynthesizeRequest,
  TtsProvider,
  TtsVoice,
  VideoCreateRequest,
  VideoProvider,
  VoiceCloneProvider,
  VoiceCloneRequest,
  VoiceCloneResult,
} from '../types.js'
import {
  appendJsonParamsToForm,
  fetchWithProviderTimeout,
  getConfigString,
  getJsonStringParam,
  getPayloadError,
  getSecretString,
  logProviderResponseError,
  mergeJsonBody,
  omitJsonParams,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://api.boson.ai'
const DEFAULT_TTS_MODEL = 'higgs-tts-3'
const DEFAULT_RESPONSE_FORMAT = 'mp3'
const DEFAULT_VIDEO_MODEL = 'higgs-avatar'
const DEFAULT_VIDEO_SIZE = '640x640'
const DEFAULT_TTS_VOICE = 'chloe'
const BOSON_TTS_MODELS = ['higgs-tts-3']
const BOSON_RESPONSE_FORMATS = ['mp3', 'opus', 'pcm', 'wav', 'aac', 'flac']
const BOSON_VIDEO_MODELS = ['higgs-avatar']
const BOSON_VIDEO_SIZES = ['640x640', '640x480', '480x640']
const BOSON_TTS_VOICES = ['chloe', 'eleanor', 'jake', 'marcus', 'nora', 'oliver']

interface BosonVoicePayload {
  voice?: string
  description?: string | null
  created_at?: string | null
  ref_text?: string
}

interface BosonVoiceListPayload {
  object?: string
  data?: BosonVoicePayload[]
}

export class BosonProvider implements TtsProvider, VideoProvider, VoiceCloneProvider {
  readonly id = 'boson'
  readonly name = 'Boson'
  readonly capabilities = { tts: true, tts_streaming: true, video: true, video_streaming: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: BOSON_TTS_MODELS },
    { key: 'response_format', label: 'Response Format', type: 'text' as const, placeholder: DEFAULT_RESPONSE_FORMAT, options: BOSON_RESPONSE_FORMATS },
    { key: 'tts_voice', label: 'TTS Voice', type: 'text' as const, placeholder: DEFAULT_TTS_VOICE, options: BOSON_TTS_VOICES },
    { key: 'video_model', label: 'Video Model', type: 'text' as const, placeholder: DEFAULT_VIDEO_MODEL, options: BOSON_VIDEO_MODELS },
    { key: 'video_size', label: 'Video Size', type: 'text' as const, placeholder: DEFAULT_VIDEO_SIZE, options: BOSON_VIDEO_SIZES },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const presetVoices = BOSON_TTS_VOICES.map(voice => ({
      id: voice,
      name: formatPresetVoiceName(voice),
      provider: this.id,
      capabilities: this.capabilities,
    }))
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) return presetVoices

    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/v1/audio/voices`, {
      headers: {
        authorization: `Bearer ${api_key}`,
      },
    }, context)
    const payload = await readJsonResponse<BosonVoiceListPayload>(response, 'errorMessageObject')
    if (!response.ok) {
      const detail = getPayloadError(payload)
      logProviderResponseError(this.id, 'list_voices', response, detail ?? payload)
      return presetVoices
    }
    const customVoices = (payload.data ?? [])
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
      .map(voice => ({ ...voice, capabilities: this.capabilities }))
    return [...presetVoices, ...customVoices]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response_format = normalizeResponseFormat(request.output_format ?? getConfigString(context, 'response_format') ?? DEFAULT_RESPONSE_FORMAT)
    const response = await this.createSpeech(request, context, response_format, false)
    const audio = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = parseErrorText(audio)
      logProviderResponseError(this.id, 'speech', response, detail)
      throw new Error(detail || `Boson speech request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('Boson speech response audio was empty.')
    return {
      audio,
      mime_type: response.headers.get('content-type')?.split(';')[0] || getAudioMimeType(response_format),
      duration_ms: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    if ((request.stream_format ?? 'audio') === 'sse') throw new Error('Boson speech streaming only supports raw audio streams.')
    const response = await this.createSpeech(request, context, 'pcm', true)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError(this.id, 'speech_stream', response, detail)
      throw new Error(detail || `Boson speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('Boson speech stream response was empty.')
    return {
      stream: response.body,
      mime_type: response.headers.get('content-type')?.split(';')[0] || 'audio/L16',
    }
  }

  async createVideo(request: VideoCreateRequest, context: ProviderContext = {}): Promise<JsonObject> {
    const response = await this.postVideoRequest('/v1/videos', request, context)
    const payload = await readJsonResponse<JsonObject>(response, 'errorMessageObject')
    if (!response.ok) {
      const detail = getPayloadError(payload)
      logProviderResponseError(this.id, 'video_create', response, detail ?? payload)
      throw new Error(detail || `Boson video creation failed: ${response.status}`)
    }
    return normalizeVideoPayload(payload, 'Boson video creation')
  }

  async retrieveVideo(video_id: string, context: ProviderContext = {}): Promise<JsonObject> {
    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/v1/videos/${encodeURIComponent(video_id)}`, {
      headers: {
        authorization: `Bearer ${getApiKey(context)}`,
      },
    }, context)
    const payload = await readJsonResponse<JsonObject>(response, 'errorMessageObject')
    if (!response.ok) {
      const detail = getPayloadError(payload)
      logProviderResponseError(this.id, 'video_retrieve', response, detail ?? payload)
      throw new Error(detail || `Boson video retrieval failed: ${response.status}`)
    }
    return normalizeVideoPayload(payload, 'Boson video retrieval')
  }

  async downloadVideoContent(video_id: string, variant: 'video' | undefined, context: ProviderContext = {}) {
    const url = new URL(`${getBaseUrl(context)}/v1/videos/${encodeURIComponent(video_id)}/content`)
    if (variant) url.searchParams.set('variant', variant)
    const response = await fetchWithProviderTimeout(url, {
      headers: {
        authorization: `Bearer ${getApiKey(context)}`,
      },
    }, context)
    const video = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = parseErrorText(video)
      logProviderResponseError(this.id, 'video_content', response, detail)
      throw new Error(detail || `Boson video content download failed: ${response.status}`)
    }
    return {
      video,
      mime_type: response.headers.get('content-type')?.split(';')[0] || 'video/mp4',
    }
  }

  async streamVideo(request: VideoCreateRequest, context: ProviderContext = {}) {
    const response = await this.postVideoRequest('/v1/videos/stream', request, context)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError(this.id, 'video_stream', response, detail)
      throw new Error(detail || `Boson video stream failed: ${response.status}`)
    }
    if (!response.body) throw new Error('Boson video stream response was empty.')
    return {
      stream: response.body,
      mime_type: response.headers.get('content-type')?.split(';')[0] || 'video/mp4',
      video_id: response.headers.get('x-video-id') ?? undefined,
    }
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const ref_text = getJsonStringParam(request.extra_params, 'ref_text')
    if (!ref_text) throw new Error('extra_params.ref_text is required for Boson voice cloning.')
    const description = getJsonStringParam(request.extra_params, 'description') ?? request.name
    const form = new FormData()
    form.set('ref_audio', new Blob([request.audio_sample.data], { type: request.audio_sample.mime_type }), request.audio_sample.file_name)
    form.set('ref_text', ref_text)
    if (description) form.set('description', description)
    appendJsonParamsToForm(form, omitJsonParams(request.extra_params, ['ref_text', 'description']))

    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/v1/audio/voices`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${getApiKey(context)}`,
      },
      body: form,
    }, context)
    const payload = await readJsonResponse<BosonVoicePayload>(response, 'errorMessageObject')
    if (!response.ok) {
      const detail = getPayloadError(payload)
      logProviderResponseError(this.id, 'voice_clone', response, detail ?? payload)
      throw new Error(detail || `Boson voice clone request failed: ${response.status}`)
    }
    if (!payload.voice) throw new Error('Boson voice clone response did not include voice.')
    return {
      provider: this.id,
      voice: {
        voice_id: payload.voice,
        provider_voice_id: payload.voice,
        name: request.name,
        description: payload.description ?? description,
        preview_audio_data: `data:${request.audio_sample.mime_type};base64,${request.audio_sample.data.toString('base64')}`,
        preview_mime_type: request.audio_sample.mime_type,
        metadata: {
          created_at: payload.created_at ?? null,
          ref_text: payload.ref_text ?? ref_text,
        },
      },
      raw: payload,
    }
  }

  private postVideoRequest(path: '/v1/videos' | '/v1/videos/stream', request: VideoCreateRequest, context: ProviderContext): Promise<Response> {
    const api_key = getApiKey(context)
    const body = createVideoBody(request, context)
    const isMultipart = body instanceof FormData
    return fetchWithProviderTimeout(`${getBaseUrl(context)}${path}`, {
      method: 'POST',
      headers: isMultipart
        ? { authorization: `Bearer ${api_key}` }
        : {
            authorization: `Bearer ${api_key}`,
            'content-type': 'application/json',
          },
      body: isMultipart ? body : JSON.stringify(body),
    }, context)
  }

  private createSpeech(request: SynthesizeRequest, context: ProviderContext, response_format: string, stream: boolean): Promise<Response> {
    const api_key = getApiKey(context)
    const input = request.text.trim()
    if (!input) throw new Error('input is required')
    return fetchWithProviderTimeout(`${getBaseUrl(context)}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(mergeJsonBody({
        input,
        model: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
        voice: hasReferenceAudio(request.extra_params) ? undefined : request.voice ?? getConfigString(context, 'tts_voice') ?? DEFAULT_TTS_VOICE,
        response_format,
        stream: stream || undefined,
      }, request.extra_params)),
    }, context)
  }
}

function normalizeResponseFormat(value: string): string {
  if (BOSON_RESPONSE_FORMATS.includes(value)) return value
  throw new Error(`Boson response_format must be one of: ${BOSON_RESPONSE_FORMATS.join(', ')}`)
}

function hasReferenceAudio(extra_params: JsonObject | undefined): boolean {
  return typeof extra_params?.ref_audio === 'string' && extra_params.ref_audio.trim().length > 0
}

function createVideoBody(request: VideoCreateRequest, context: ProviderContext): FormData | Record<string, unknown> {
  const model = request.model ?? getConfigString(context, 'video_model') ?? DEFAULT_VIDEO_MODEL
  const size = request.size ?? getConfigString(context, 'video_size') ?? DEFAULT_VIDEO_SIZE
  const input_tts = withDefaultTtsVoice(request.input_tts, context)
  const base = {
    model,
    ref_image: request.ref_image,
    input: request.input,
    input_tts,
    size,
  }
  if (isProviderFile(request.ref_image) || isProviderFile(request.input)) {
    const form = new FormData()
    form.set('model', model)
    form.set('size', size)
    appendVideoSource(form, 'ref_image', request.ref_image)
    if (request.input) appendVideoSource(form, 'input', request.input)
    if (input_tts) form.set('input_tts', JSON.stringify(input_tts))
    appendJsonParamsToForm(form, request.extra_params)
    return form
  }
  return mergeJsonBody(base, request.extra_params)
}

function withDefaultTtsVoice(input_tts: JsonObject | undefined, context: ProviderContext): JsonObject | undefined {
  if (!input_tts) return undefined
  if (typeof input_tts.voice === 'string' && input_tts.voice.trim()) return input_tts
  return {
    ...input_tts,
    voice: getConfigString(context, 'tts_voice') ?? DEFAULT_TTS_VOICE,
  }
}

function appendVideoSource(form: FormData, key: 'ref_image' | 'input', value: string | ProviderFile): void {
  if (isProviderFile(value)) {
    form.set(key, new Blob([value.data], { type: value.mime_type }), value.file_name)
    return
  }
  form.set(key, value)
}

function normalizeVoice(payload: BosonVoicePayload, provider: string): TtsVoice | undefined {
  const id = payload.voice?.trim()
  if (!id) return undefined
  return {
    id,
    name: payload.description?.trim() || id,
    provider,
  }
}

function formatPresetVoiceName(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function getApiKey(context: ProviderContext): string {
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('Boson API key is required.')
  return api_key
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? process.env.BOSON_API_BASE_URL ?? DEFAULT_BASE_URL)
}

function isProviderFile(value: unknown): value is ProviderFile {
  return Boolean(value)
    && typeof value === 'object'
    && Buffer.isBuffer((value as ProviderFile).data)
    && typeof (value as ProviderFile).mime_type === 'string'
    && typeof (value as ProviderFile).file_name === 'string'
}

function normalizeVideoPayload(payload: unknown, operation: string): JsonObject {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`${operation} response was not a JSON object.`)
  }
  return payload as JsonObject
}

function parseErrorText(value: Buffer): string {
  const text = value.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as unknown
    return getPayloadError(parsed) ?? text
  } catch {
    return text
  }
}

function getAudioMimeType(format: string): string {
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'opus') return 'audio/ogg'
  if (format === 'wav') return 'audio/wav'
  if (format === 'aac') return 'audio/aac'
  if (format === 'flac') return 'audio/flac'
  if (format === 'pcm') return 'audio/L16'
  return 'application/octet-stream'
}
