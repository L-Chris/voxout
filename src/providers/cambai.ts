import { Blob } from 'node:buffer'
import type {
  AsrProvider,
  AudioGenerationResult,
  AudioIsolationProvider,
  AudioIsolationRequest,
  JsonObject,
  JsonValue,
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
  VoiceCreateRequest,
  VoiceDesignProvider,
  VoiceDesignRequest,
  VoiceDesignResult,
} from '../types.js'
import {
  appendJsonParamsToForm,
  compactObject,
  fetchWithProviderTimeout,
  getConfigNumber,
  getConfigString,
  getJsonStringParam,
  getPayloadError,
  getPositiveConfigNumber,
  getSecretString,
  logProviderResponseError,
  mergeJsonBody,
  omitJsonParams,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://client.camb.ai/apis'
const DEFAULT_TTS_MODEL = 'mars-8.1-flash-beta'
const DEFAULT_ASR_MODEL = 'cambai-transcribe'
const DEFAULT_SOUND_EFFECT_MODEL = 'cambai-text-to-sound'
const DEFAULT_VOICE_DESIGN_MODEL = 'cambai-text-to-voice'
const DEFAULT_VOICE_ID = '147320'
const DEFAULT_LANGUAGE = 'en-us'
const DEFAULT_OUTPUT_FORMAT = 'wav'
const DEFAULT_SOUND_EFFECT_AUDIO_TYPE = 'sound'
const DEFAULT_POLL_INTERVAL_MS = 3000
const DEFAULT_POLL_ATTEMPTS = 20
const DEFAULT_VOICE_SAMPLE_TEXT = 'Hello, this is a short preview of the generated voice.'
const DEFAULT_CLONE_GENDER = 0
const DEFAULT_CLONE_AGE = 30
const CAMBAI_TTS_MODELS = [
  'mars-8.1-flash-beta',
  'mars-8.1-pro-beta',
  'mars-flash',
  'mars-pro',
  'mars-instruct',
]
const CAMBAI_OUTPUT_FORMATS = ['wav', 'mp3', 'flac', 'adts', 'aac', 'pcm', 'pcm_s16le', 'pcm_s16be', 'pcm_s32be', 'pcm_s32le', 'pcm_f32le', 'pcm_f32be']
const TERMINAL_ERROR_STATUSES = new Set(['ERROR', 'FAILED', 'TIMEOUT', 'PAYMENT_REQUIRED'])

interface CambVoicePayload {
  id?: number | string
  voice_name?: string
  gender?: number | null
  age?: number | null
  language?: string | null
  description?: string | null
  is_published?: boolean | null
}

interface CambTaskPayload {
  task_id?: string
}

interface CambStatusPayload {
  status?: string
  run_id?: number | string | null
  message?: string
  exception_reason?: string
  foreground_audio_url?: string
  background_audio_url?: string
  foreground_url?: string
  background_url?: string
}

interface CambTranscriptionItem {
  start?: number
  end?: number
  text?: string
  speaker?: string
}

interface CambAudioUrlPayload {
  output_url?: string
  file_url?: string
  url?: string
}

interface CambAudioSeparationPayload {
  foreground_audio_url?: string
  background_audio_url?: string
}

interface CambTextToVoicePayload {
  previews?: string[]
}

interface CambCreateVoicePayload {
  voice_id?: number | string
}

export class CambAiProvider implements TtsProvider, AsrProvider, SoundEffectProvider, AudioIsolationProvider, VoiceDesignProvider, VoiceCloneProvider {
  readonly id = 'cambai'
  readonly name = 'Camb.ai'
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, sound_effects: true, isolation: true, voice_design: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: CAMBAI_TTS_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: [DEFAULT_ASR_MODEL] },
    { key: 'sound_effect_model', label: 'Sound Effect Model', type: 'text' as const, placeholder: DEFAULT_SOUND_EFFECT_MODEL, options: [DEFAULT_SOUND_EFFECT_MODEL] },
    { key: 'voice_design_model', label: 'Voice Design Model', type: 'text' as const, placeholder: DEFAULT_VOICE_DESIGN_MODEL, options: [DEFAULT_VOICE_DESIGN_MODEL] },
    { key: 'default_voice_id', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'default_language', label: 'Default Language', type: 'text' as const, placeholder: DEFAULT_LANGUAGE },
    { key: 'output_format', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT, options: CAMBAI_OUTPUT_FORMATS },
    { key: 'audio_type', label: 'Text-to-Sound Type', type: 'text' as const, placeholder: DEFAULT_SOUND_EFFECT_AUDIO_TYPE, options: ['sound', 'music'] },
    { key: 'separation_stem', label: 'Separation Stem', type: 'text' as const, placeholder: 'foreground', options: ['foreground', 'background'] },
    { key: 'poll_interval_ms', label: 'Poll Interval (ms)', type: 'number' as const, placeholder: String(DEFAULT_POLL_INTERVAL_MS) },
    { key: 'poll_attempts', label: 'Poll Attempts', type: 'number' as const, placeholder: String(DEFAULT_POLL_ATTEMPTS) },
    { key: 'clone_gender', label: 'Clone Gender', type: 'number' as const, placeholder: String(DEFAULT_CLONE_GENDER) },
    { key: 'clone_age', label: 'Clone Age', type: 'number' as const, placeholder: String(DEFAULT_CLONE_AGE) },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) return [getDefaultVoice(this.id, context)]

    const response = await fetchCamb(context, '/list-voices', {
      headers: { 'x-api-key': api_key },
    })
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError(this.id, 'list_voices', response, detail)
      return [getDefaultVoice(this.id, context)]
    }

    const payload = await readJsonResponse<CambVoicePayload[] | { voices?: CambVoicePayload[] }>(response)
    const voicePayload = Array.isArray(payload) ? payload : payload.voices ?? []
    const voices = voicePayload
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
    return voices.length ? voices : [getDefaultVoice(this.id, context)]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response_format = normalizeOutputFormat(request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT)
    const response = await this.createSpeech(request, context, response_format)
    return readAudioResponse(response, this.id, 'speech', getMimeType(response_format, response.headers.get('content-type') ?? undefined))
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    if (request.stream_format === 'sse') throw new Error('Camb.ai TTS streaming supports stream_format "audio" only.')
    const response_format = normalizeOutputFormat(request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT)
    const response = await this.createSpeech(request, context, response_format)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError(this.id, 'speech_stream', response, detail)
      throw new Error(detail || `Camb.ai text-to-speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('Camb.ai text-to-speech stream response was empty.')
    return {
      stream: response.body,
      mime_type: getMimeType(response_format, response.headers.get('content-type') ?? undefined),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const api_key = getApiKey(context)
    const form = new FormData()
    form.set('language', normalizeLanguage(request.language, context))
    form.set('media_file', new Blob([request.file.data], { type: request.file.mime_type }), request.file.file_name)
    appendJsonParamsToForm(form, omitJsonParams(request.extra_params, ['language', 'file', 'media_file', 'audio_url', 'media_url']))

    const createPayload = await requestJson<CambTaskPayload>(context, '/transcribe', api_key, {
      method: 'POST',
      body: form,
    }, 'transcription_create')
    const run_id = await pollTaskRunId(context, api_key, '/transcribe', createPayload.task_id, 'transcription')
    const resultPayload = await requestJson<CambTranscriptionItem[]>(context, `/transcription-result/${encodeURIComponent(run_id)}`, api_key, {}, 'transcription_result')
    const segments = (Array.isArray(resultPayload) ? resultPayload : [])
      .filter(item => item.text)
      .map(item => ({
        from: item.start ?? 0,
        to: item.end ?? 0,
        content: item.text ?? '',
      }))
    const text = segments.map(segment => segment.content).join(' ').replace(/\s+/g, ' ').trim()
    if (!text) throw new Error('Camb.ai transcription response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      segments,
      raw: request.format === 'raw' ? resultPayload : undefined,
    }
  }

  async createSoundEffect(request: SoundEffectRequest, context: ProviderContext = {}): Promise<AudioGenerationResult> {
    const api_key = getApiKey(context)
    const audio_type = normalizeAudioType(getJsonStringParam(request.extra_params, 'audio_type') ?? getConfigString(context, 'audio_type') ?? DEFAULT_SOUND_EFFECT_AUDIO_TYPE)
    const body = mergeJsonBody({
      prompt: request.prompt.trim(),
      duration: normalizeSoundDuration(request.duration_seconds),
      audio_type,
    }, omitJsonParams(request.extra_params, ['audio_type']))
    const createPayload = await requestJson<CambTaskPayload>(context, '/text-to-sound', api_key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }, 'sound_effect_create')
    const run_id = await pollTaskRunId(context, api_key, '/text-to-sound', createPayload.task_id, 'sound_effect')
    const response = await fetchCamb(context, `/text-to-sound-result/${encodeURIComponent(run_id)}`, {
      headers: { 'x-api-key': api_key },
    })
    return readAudioOrUrlResponse(response, context, this.id, 'sound_effect_result', 'audio/wav')
  }

  async isolateAudio(request: AudioIsolationRequest, context: ProviderContext = {}): Promise<AudioGenerationResult> {
    const api_key = getApiKey(context)
    const form = new FormData()
    form.set('media_file', new Blob([request.file.data], { type: request.file.mime_type }), request.file.file_name)
    appendJsonParamsToForm(form, omitJsonParams(request.extra_params, ['stem', 'media_file']))

    const createPayload = await requestJson<CambTaskPayload>(context, '/audio-separation', api_key, {
      method: 'POST',
      body: form,
    }, 'audio_separation_create')
    const status = await pollTask(context, api_key, '/audio-separation', createPayload.task_id, 'audio_separation')
    let result: CambAudioSeparationPayload | undefined
    if (status.foreground_audio_url || status.background_audio_url || status.foreground_url || status.background_url) {
      result = {
        foreground_audio_url: status.foreground_audio_url ?? status.foreground_url,
        background_audio_url: status.background_audio_url ?? status.background_url,
      }
    } else if (status.run_id != null) {
      result = await requestJson<CambAudioSeparationPayload>(
        context,
        `/audio-separation-result/${encodeURIComponent(String(status.run_id))}`,
        api_key,
        {},
        'audio_separation_result',
      )
    } else {
      throw new Error('Camb.ai audio separation completed without a run_id or audio URLs.')
    }

    const stem = normalizeStem(getJsonStringParam(request.extra_params, 'stem') ?? getConfigString(context, 'separation_stem') ?? 'foreground')
    const url = stem === 'background' ? result.background_audio_url : result.foreground_audio_url
    if (!url) throw new Error(`Camb.ai audio separation response did not include ${stem}_audio_url.`)
    const response = await fetchCamb(context, url, {})
    return readAudioResponse(response, this.id, `audio_separation_${stem}`, request.file.mime_type)
  }

  async designVoice(request: VoiceDesignRequest, context: ProviderContext = {}): Promise<VoiceDesignResult> {
    const api_key = getApiKey(context)
    const text = normalizePrompt(request.input) ?? normalizePrompt(getConfigString(context, 'voice_sample_text')) ?? DEFAULT_VOICE_SAMPLE_TEXT
    const createPayload = await requestJson<CambTaskPayload>(context, '/text-to-voice', api_key, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mergeJsonBody({
        text,
        voice_description: request.instructions.trim(),
      }, request.extra_params)),
    }, 'voice_design_create')
    const run_id = await pollTaskRunId(context, api_key, '/text-to-voice', createPayload.task_id, 'voice_design')
    const payload = await requestJson<CambTextToVoicePayload>(context, `/text-to-voice-result/${encodeURIComponent(run_id)}`, api_key, {}, 'voice_design_result')
    const previewUrls = payload.previews ?? []
    const voices = await Promise.all(previewUrls.map(async (url, index) => {
      const preview = await downloadAudioUrl(context, url, this.id, 'voice_design_preview')
      return {
        voice_id: `cambai-preview-${run_id}-${index + 1}`,
        provider_voice_id: `cambai-preview-${run_id}-${index + 1}`,
        name: request.name ?? `Camb.ai Voice ${index + 1}`,
        description: request.instructions,
        language: normalizeLanguage(request.extra_params ? getJsonStringParam(request.extra_params, 'language') : undefined, context),
        preview_audio_data: `data:${preview.mime_type};base64,${preview.audio.toString('base64')}`,
        preview_mime_type: preview.mime_type,
        metadata: {
          run_id,
          preview_url: url,
        },
      }
    }))
    if (!voices.length) throw new Error('Camb.ai voice design response did not include previews.')
    return {
      provider: this.id,
      text,
      voices,
      raw: payload,
    }
  }

  async createDesignedVoice(request: VoiceCreateRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    if (!request.preview_audio_data) throw new Error('preview_audio is required for Camb.ai voice preview creation.')
    const audio = dataUrlToAudioFile(request.preview_audio_data, `${request.name || 'cambai-preview'}.mp3`, request.preview_mime_type)
    const payload = await createCustomVoice({
      context,
      api_key: getApiKey(context),
      name: request.name,
      description: request.instructions,
      audio,
      extra_params: request.extra_params,
      language: request.language,
    })
    return voiceResultFromPayload(this.id, payload, request.name, request.instructions, request.language, {
      generated_voice_id: request.generated_voice_id,
      labels: request.labels ?? null,
      played_not_selected_voice_ids: request.played_not_selected_voice_ids ?? null,
    }, request.preview_audio_data, request.preview_mime_type)
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const api_key = getApiKey(context)
    const description = getJsonStringParam(request.extra_params, 'description')
    const language = getJsonStringParam(request.extra_params, 'language')
    const payload = await createCustomVoice({
      context,
      api_key,
      name: request.name,
      description,
      audio: request.audio_sample,
      extra_params: request.extra_params,
      language,
    })
    return voiceResultFromPayload(this.id, payload, request.name, description, language)
  }

  private createSpeech(request: SynthesizeRequest, context: ProviderContext, response_format: string): Promise<Response> {
    const api_key = getApiKey(context)
    const body = mergeJsonBody({
      text: request.text.trim(),
      language: normalizeLanguage(request.lang, context),
      voice_id: getVoiceId(request, context),
      speech_model: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
      user_instructions: normalizePrompt(request.instructions),
      output_configuration: compactObject({
        format: response_format,
        sample_rate: getPositiveConfigNumber(context, 'sample_rate'),
        apply_enhancement: getConfigBooleanLike(context, 'apply_enhancement'),
      }),
      voice_settings: compactObject({
        speaking_rate: normalizeSpeed(request.speed),
        enhance_reference_audio_quality: getConfigBooleanLike(context, 'enhance_reference_audio_quality'),
        maintain_source_accent: getConfigBooleanLike(context, 'maintain_source_accent'),
      }),
    }, request.extra_params)
    return fetchCamb(context, '/tts-stream', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': api_key,
      },
      body: JSON.stringify(body),
    })
  }
}

async function requestJson<T>(context: ProviderContext, path: string, api_key: string, init: RequestInit, operation: string): Promise<T> {
  const response = await fetchCamb(context, path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      'x-api-key': api_key,
    },
  })
  const payload = await readJsonResponse<T>(response)
  if (!response.ok) {
    const detail = getPayloadError(payload)
    logProviderResponseError('cambai', operation, response, detail ?? payload)
    throw new Error(detail || `Camb.ai ${operation} request failed: ${response.status}`)
  }
  return payload
}

async function fetchCamb(context: ProviderContext, pathOrUrl: string, init: RequestInit): Promise<Response> {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : `${getBaseUrl(context)}${pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`}`
  return fetchWithProviderTimeout(url, init, context)
}

async function readAudioOrUrlResponse(response: Response, context: ProviderContext, provider: string, operation: string, fallbackMime: string): Promise<AudioGenerationResult> {
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
  if (response.ok && contentType?.includes('json')) {
    const payload = await readJsonResponse<CambAudioUrlPayload>(response)
    const url = payload.output_url ?? payload.file_url ?? payload.url
    if (!url) throw new Error('Camb.ai audio result response did not include an output URL.')
    return downloadAudioUrl(context, url, provider, operation)
  }
  return readAudioResponse(response, provider, operation, contentType || fallbackMime)
}

async function readAudioResponse(response: Response, provider: string, operation: string, fallbackMime: string): Promise<AudioGenerationResult> {
  const audio = Buffer.from(await response.arrayBuffer())
  if (!response.ok) {
    const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
    logProviderResponseError(provider, operation, response, detail)
    throw new Error(detail || `Camb.ai ${operation} request failed: ${response.status}`)
  }
  if (audio.length < 128) throw new Error(`Camb.ai ${operation} response audio was empty.`)
  return {
    audio,
    mime_type: response.headers.get('content-type')?.split(';')[0] || fallbackMime,
    duration_ms: 0,
  }
}

async function downloadAudioUrl(context: ProviderContext, url: string, provider: string, operation: string): Promise<AudioGenerationResult> {
  const response = await fetchCamb(context, url, {})
  return readAudioResponse(response, provider, operation, response.headers.get('content-type')?.split(';')[0] || 'audio/wav')
}

async function createCustomVoice(input: {
  context: ProviderContext
  api_key: string
  name: string
  description?: string
  audio: { data: Buffer, mime_type: string, file_name: string }
  extra_params?: JsonObject
  language?: string
}): Promise<CambCreateVoicePayload> {
  const form = new FormData()
  form.set('voice_name', input.name)
  form.set('gender', String(normalizeGender(getJsonParam(input.extra_params, 'gender') ?? getConfigNumber(input.context, 'clone_gender') ?? DEFAULT_CLONE_GENDER)))
  form.set('age', String(normalizeAge(getJsonParam(input.extra_params, 'age') ?? getConfigNumber(input.context, 'clone_age') ?? DEFAULT_CLONE_AGE)))
  form.set('file', new Blob([input.audio.data], { type: input.audio.mime_type }), input.audio.file_name)
  const description = input.description ?? getJsonStringParam(input.extra_params, 'description')
  if (description) form.set('description', description)
  const language = input.language ?? getJsonStringParam(input.extra_params, 'language')
  if (language) form.set('language', normalizeLocale(language))
  const enhance_audio = getJsonParam(input.extra_params, 'enhance_audio') ?? getConfigBooleanLike(input.context, 'enhance_audio')
  if (enhance_audio != null) form.set('enhance_audio', String(Boolean(enhance_audio)))
  appendJsonParamsToForm(form, omitJsonParams(input.extra_params, ['gender', 'age', 'description', 'language', 'enhance_audio']))

  const payload = await requestJson<CambCreateVoicePayload>(input.context, '/create-custom-voice', input.api_key, {
    method: 'POST',
    body: form,
  }, 'voice_clone')
  if (payload.voice_id == null) throw new Error('Camb.ai custom voice response did not include voice_id.')
  return payload
}

function voiceResultFromPayload(
  provider: string,
  payload: CambCreateVoicePayload,
  name: string,
  description?: string,
  language?: string,
  metadata: Record<string, JsonValue> = {},
  preview_audio_data?: string,
  preview_mime_type?: string,
): VoiceCloneResult {
  const voice_id = String(payload.voice_id)
  return {
    provider,
    voice: {
      voice_id,
      provider_voice_id: voice_id,
      name,
      description,
      language,
      preview_audio_data,
      preview_mime_type,
      metadata: {
        ...metadata,
        provider_voice_id: voice_id,
      },
    },
    raw: payload,
  }
}

async function pollTaskRunId(context: ProviderContext, api_key: string, basePath: string, task_id: string | undefined, operation: string): Promise<string> {
  const status = await pollTask(context, api_key, basePath, task_id, operation)
  if (status.run_id == null) throw new Error(`Camb.ai ${operation} completed without a run_id.`)
  return String(status.run_id)
}

async function pollTask(context: ProviderContext, api_key: string, basePath: string, task_id: string | undefined, operation: string): Promise<CambStatusPayload> {
  if (!task_id) throw new Error(`Camb.ai ${operation} response did not include task_id.`)
  const attempts = Math.max(1, Math.floor(getPositiveConfigNumber(context, 'poll_attempts') ?? DEFAULT_POLL_ATTEMPTS))
  const interval_ms = Math.max(0, Math.floor(getPositiveConfigNumber(context, 'poll_interval_ms') ?? DEFAULT_POLL_INTERVAL_MS))
  let lastStatus = 'PENDING'
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0 && interval_ms > 0) await delay(interval_ms)
    const payload = await requestJson<CambStatusPayload | string>(context, `${basePath}/${encodeURIComponent(task_id)}`, api_key, {}, `${operation}_status`)
    const status = normalizeStatusPayload(payload)
    lastStatus = status.status ?? lastStatus
    if (status.status === 'SUCCESS') return status
    if (status.status && TERMINAL_ERROR_STATUSES.has(status.status)) {
      const detail = status.message ?? status.exception_reason ?? status.status
      throw new Error(`Camb.ai ${operation} failed: ${detail}`)
    }
  }
  throw new Error(`Camb.ai ${operation} did not complete after ${attempts} polling attempts; last status: ${lastStatus}.`)
}

function normalizeStatusPayload(payload: CambStatusPayload | string): CambStatusPayload {
  if (typeof payload === 'string') return { status: payload }
  if (!payload.status && payload.run_id != null) return { ...payload, status: 'SUCCESS' }
  return {
    ...payload,
    status: payload.status?.toUpperCase(),
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getApiKey(context: ProviderContext): string {
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('cambai api_key is required in provider settings.')
  return api_key
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
}

function getDefaultVoice(provider: string, context: ProviderContext): TtsVoice {
  const id = getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
  return { id, name: 'Camb.ai Default', locale: getConfigString(context, 'default_language') ?? DEFAULT_LANGUAGE, provider }
}

function normalizeVoice(voice: CambVoicePayload, provider: string): TtsVoice | null {
  if (voice.id == null) return null
  return {
    id: String(voice.id),
    name: voice.voice_name ?? String(voice.id),
    locale: typeof voice.language === 'string' ? voice.language : undefined,
    gender: normalizeGenderLabel(voice.gender),
    provider,
    capabilities: { tts: true, tts_streaming: true, voice_clone: !voice.is_published },
  }
}

function normalizeGenderLabel(value: number | null | undefined): string | undefined {
  if (value === 1) return 'Male'
  if (value === 2) return 'Female'
  if (value === 9) return 'Not Applicable'
  if (value === 0) return 'Unspecified'
  return undefined
}

function getVoiceId(request: SynthesizeRequest, context: ProviderContext): number {
  const raw = request.voice ?? getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
  const id = Number(raw)
  if (!Number.isInteger(id) || id < 1) throw new Error('Camb.ai voice_id must be a positive integer.')
  return id
}

function normalizeLanguage(value: string | undefined, context: ProviderContext): string {
  return normalizeLocale(value) ?? normalizeLocale(getConfigString(context, 'default_language')) ?? DEFAULT_LANGUAGE
}

function normalizeLocale(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase()
  if (!normalized || normalized === 'auto') return undefined
  return normalized
}

function normalizeOutputFormat(value: string): string {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'pcm') return 'pcm_s16le'
  if (normalized === 'aac') return 'adts'
  if (CAMBAI_OUTPUT_FORMATS.includes(normalized)) return normalized
  return DEFAULT_OUTPUT_FORMAT
}

function getMimeType(format: string, responseType: string | undefined): string {
  const type = responseType?.split(';')[0]?.trim()
  if (type) return type
  if (format === 'mp3') return 'audio/mpeg'
  if (format === 'flac') return 'audio/flac'
  if (format === 'adts' || format === 'aac') return 'audio/aac'
  if (format.startsWith('pcm_')) return 'audio/pcm'
  return 'audio/wav'
}

function normalizeSpeed(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return value
}

function normalizePrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed || undefined
}

function normalizeSoundDuration(value: number | undefined): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined
  return Math.max(0.5, Math.min(10, Number(value.toFixed(2))))
}

function normalizeAudioType(value: string): 'sound' | 'music' {
  return value.trim().toLowerCase() === 'music' ? 'music' : 'sound'
}

function normalizeStem(value: string): 'foreground' | 'background' {
  return value.trim().toLowerCase() === 'background' ? 'background' : 'foreground'
}

function getConfigBooleanLike(context: ProviderContext, key: string): boolean | undefined {
  const value = context.config?.[key]
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') {
    if (value === 'true' || value === '1') return true
    if (value === 'false' || value === '0') return false
  }
  return undefined
}

function getJsonParam(params: JsonObject | undefined, key: string): JsonValue | undefined {
  return params?.[key]
}

function normalizeGender(value: JsonValue): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (number === 0 || number === 1 || number === 2 || number === 9) return number
  return DEFAULT_CLONE_GENDER
}

function normalizeAge(value: JsonValue): number {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number < 1) return DEFAULT_CLONE_AGE
  return Math.floor(number)
}

function dataUrlToAudioFile(value: string, file_name: string, fallbackMime?: string): { data: Buffer, mime_type: string, file_name: string } {
  const match = /^data:([^;,]+)?(?:;base64)?,(.*)$/s.exec(value)
  if (!match) return { data: Buffer.from(value, 'base64'), mime_type: fallbackMime ?? 'audio/mpeg', file_name }
  const isBase64 = value.slice(0, value.indexOf(',')).includes(';base64')
  return {
    data: isBase64 ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]), 'utf8'),
    mime_type: match[1] || fallbackMime || 'audio/mpeg',
    file_name,
  }
}
