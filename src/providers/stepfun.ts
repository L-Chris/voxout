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
  compactObject,
  fetchWithProviderTimeout,
  getConfigString,
  getJsonStringParam,
  getPayloadError,
  getSecretString,
  logProviderResponseError,
  mergeJsonBody,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://api.stepfun.com/v1'
const DEFAULT_TTS_MODEL = 'step-tts-mini'
const DEFAULT_ASR_MODEL = 'stepaudio-2.5-asr'
const DEFAULT_VOICE = 'cixingnansheng'
const DEFAULT_RESPONSE_FORMAT = 'mp3'
const STEPFUN_TTS_MODELS = ['step-tts-2', 'step-tts-mini', 'stepaudio-2.5-tts']
const STEPFUN_ASR_MODELS = ['stepaudio-2.5-asr', 'stepaudio-2-asr-pro']
const STEPFUN_RESPONSE_FORMATS = ['mp3', 'opus', 'flac', 'wav', 'pcm'] as const
const STEPFUN_INSTRUCTION_MODELS = new Set(['stepaudio-2.5-tts'])

type StepFunResponseFormat = typeof STEPFUN_RESPONSE_FORMATS[number]

interface StepFunFilePayload {
  id?: string
  object?: string
  bytes?: number
  created_at?: number
  filename?: string
  purpose?: string
  status?: string
}

interface StepFunVoicePayload {
  id?: string
  object?: string
  duplicated?: boolean
  error?: unknown
}

interface StepFunVoiceListPayload {
  object?: string
  data?: Array<{
    id?: string
    file_id?: string
    created_at?: number
  }>
  has_more?: boolean
  first_id?: string
  last_id?: string
}

interface StepFunSystemVoicePayload {
  voices?: string[]
  'voices-details'?: Record<string, {
    'voice-name'?: string
    'voice-description'?: string
    recommended_scene?: string
  }>
}
type StepFunSystemVoiceDetail = NonNullable<StepFunSystemVoicePayload['voices-details']>[string]

interface StepFunAsrEvent {
  type?: string
  delta?: string
  text?: string
  message?: string
  start_time?: number
  end_time?: number
  usage?: unknown
}

export class StepFunProvider implements TtsProvider, AsrProvider, VoiceCloneProvider {
  readonly id = 'stepfun'
  readonly name = 'StepFun'
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, asr_streaming: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: STEPFUN_TTS_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: STEPFUN_ASR_MODELS },
    { key: 'default_voice', label: 'Default Voice', type: 'text' as const, placeholder: DEFAULT_VOICE, options: STEPFUN_VOICES.map(voice => voice.id) },
    { key: 'response_format', label: 'Response Format', type: 'text' as const, placeholder: DEFAULT_RESPONSE_FORMAT, options: [...STEPFUN_RESPONSE_FORMATS] },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const api_key = getSecretString(context, 'api_key')
    const voices = api_key ? await listSystemVoices(context, api_key) : STEPFUN_VOICES
    const clonedVoices = api_key ? await listClonedVoices(context, api_key) : []
    return [...voices, ...clonedVoices].map(voice => ({
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
      logProviderResponseError(this.id, 'speech', response, detail)
      throw new Error(detail || `StepFun speech request failed: ${response.status}`)
    }
    const content_type = getResponseContentType(response)
    if (content_type && !isAudioContentType(content_type)) {
      throw new Error('StepFun speech response was not audio. extra_params.return_url is not supported by Voxout /v1/audio/speech.')
    }
    if (audio.length < 128) throw new Error('StepFun speech response audio was empty.')
    return {
      audio,
      mime_type: getMimeType(response_format, content_type),
      duration_ms: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const response_format = normalizeResponseFormat(request.output_format ?? getConfigString(context, 'response_format') ?? DEFAULT_RESPONSE_FORMAT)
    const stream_format = normalizeStreamFormat(request.stream_format ?? 'audio')
    const response = await this.createSpeech(request, context, response_format, stream_format)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError(this.id, 'speech_stream', response, detail)
      throw new Error(detail || `StepFun speech stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('StepFun speech stream response was empty.')
    return {
      stream: response.body,
      mime_type: stream_format === 'sse'
        ? getResponseContentType(response) || 'text/event-stream'
        : getMimeType(response_format, getResponseContentType(response)),
    }
  }

  private createSpeech(
    request: SynthesizeRequest,
    context: ProviderContext,
    response_format: StepFunResponseFormat,
    stream_format?: 'audio' | 'sse',
  ): Promise<Response> {
    const api_key = getApiKey(context)
    const input = request.text.trim()
    if (!input) throw new Error('input is required')
    const model = request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL
    return fetchWithProviderTimeout(`${getBaseUrl(context)}/audio/speech`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(mergeJsonBody({
        model,
        input,
        voice: request.voice ?? getConfigString(context, 'default_voice') ?? DEFAULT_VOICE,
        response_format,
        speed: normalizeSpeed(request.speed),
        stream_format,
        instruction: normalizeInstruction(request.instructions, model),
      }, request.extra_params)),
    }, context)
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const response = await this.createAsrSse(request, context)
    const text = await response.text()
    if (!response.ok) {
      logProviderResponseError(this.id, 'transcription', response, text)
      throw new Error(text.replace(/\s+/g, ' ').trim().slice(0, 500) || `StepFun transcription request failed: ${response.status}`)
    }
    const events = parseSseEvents(text)
    const errorEvent = events.find(event => event.type === 'error')
    if (errorEvent) throw new Error(errorEvent.message || 'StepFun transcription stream returned an error.')
    const done = [...events].reverse().find(event => event.type === 'transcript.text.done' && typeof event.text === 'string')
    const outputText = done?.text?.trim() || events.filter(event => event.type === 'transcript.text.delta').map(event => event.delta ?? '').join('').trim()
    if (!outputText) throw new Error('StepFun transcription response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text: outputText,
      segments: normalizeAsrSegments(events),
      raw: request.format === 'raw' ? { events } : undefined,
    }
  }

  async streamTranscribe(request: TranscribeRequest, context: ProviderContext = {}) {
    const response = await this.createAsrSse(request, context)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError(this.id, 'transcription_stream', response, detail)
      throw new Error(detail || `StepFun transcription stream request failed: ${response.status}`)
    }
    if (!response.body) throw new Error('StepFun transcription stream response was empty.')
    return {
      stream: response.body,
      mime_type: getResponseContentType(response) || 'text/event-stream',
    }
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const api_key = getApiKey(context)
    const file = await uploadFile(context, api_key, request.audio_sample)
    if (!file.id) throw new Error('StepFun file upload response did not include id.')
    const text = getJsonStringParam(request.extra_params, 'text')
    const model = getJsonStringParam(request.extra_params, 'model') ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL
    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/audio/voices`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(mergeJsonBody({
        file_id: file.id,
        model,
        text,
      }, request.extra_params)),
    }, context)
    const payload = await readJsonResponse<StepFunVoicePayload>(response, 'errorMessageObject')
    if (!response.ok) {
      const detail = getPayloadError(payload)
      logProviderResponseError(this.id, 'voice_clone', response, detail ?? payload)
      throw new Error(detail || `StepFun voice clone request failed: ${response.status}`)
    }
    if (!payload.id) throw new Error('StepFun voice clone response did not include id.')
    return {
      provider: this.id,
      voice: {
        voice_id: payload.id,
        provider_voice_id: payload.id,
        name: request.name,
        preview_audio_data: `data:${request.audio_sample.mime_type};base64,${request.audio_sample.data.toString('base64')}`,
        preview_mime_type: request.audio_sample.mime_type,
        metadata: {
          file_id: file.id,
          file_status: file.status ?? null,
          model,
          text: text ?? null,
          duplicated: payload.duplicated ?? false,
        },
      },
      raw: payload,
    }
  }

  private createAsrSse(request: TranscribeRequest, context: ProviderContext): Promise<Response> {
    const api_key = getApiKey(context)
    const format = inferAudioFormat(request.file)
    const transcription = compactObject({
      language: normalizeLanguage(request.language),
      model: request.model ?? getConfigString(context, 'asr_model') ?? DEFAULT_ASR_MODEL,
      enable_timestamp: request.timestamp_granularities?.length ? true : undefined,
    })
    const input_format = compactObject({
      type: format,
      codec: format === 'pcm' ? 'pcm_s16le' : undefined,
      rate: format === 'pcm' ? 16000 : undefined,
      bits: format === 'pcm' ? 16 : undefined,
      channel: format === 'pcm' ? 1 : undefined,
    })
    return fetchWithProviderTimeout(`${getBaseUrl(context)}/audio/asr/sse`, {
      method: 'POST',
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${api_key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(mergeJsonBody({
        audio: {
          data: request.file.data.toString('base64'),
          input: {
            transcription,
            format: input_format,
          },
        },
      }, request.extra_params)),
    }, context)
  }
}

const STEPFUN_VOICES: TtsVoice[] = [
  { id: 'vibrant-youth', name: 'Vibrant Youth', locale: 'zh-CN', provider: 'stepfun' },
  { id: 'lively-girl', name: 'Lively Girl', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'soft-spoken-gentleman', name: 'Soft-spoken Gentleman', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'magnetic-voiced-male', name: 'Magnetic-voiced Male', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'energeticconfident-female', name: 'Energetic Confident Female', locale: 'en-US', gender: 'Female', provider: 'stepfun' },
  { id: 'yingwennansheng', name: '英文男声', locale: 'en-US', gender: 'Male', provider: 'stepfun' },
  { id: 'yingwennvsheng', name: '英文女声', locale: 'en-US', gender: 'Female', provider: 'stepfun' },
  { id: 'zixinnansheng', name: '自信男声', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'elegantgentle-female', name: '气质温婉', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'livelybreezy-female', name: '活力轻快', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'wenrounansheng', name: '温柔男声', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'wenrougongzi', name: '温柔公子', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'yuanqinansheng', name: '元气男声', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'jingdiannvsheng', name: '经典女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'wenroushunv', name: '温柔熟女', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'tianmeinvsheng', name: '甜美女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'qingchunshaonv', name: '清纯少女', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'cixingnansheng', name: '磁性男声', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'yuanqishaonv', name: '元气少女', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'linjiajiejie', name: '邻家姐姐', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'zhengpaiqingnian', name: '正派青年', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'qingniandaxuesheng', name: '青年大学生', locale: 'zh-CN', provider: 'stepfun' },
  { id: 'boyinnansheng', name: '播音男声', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'ruyananshi', name: '儒雅男士', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'shenchennanyin', name: '深沉男音', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'qinqienvsheng', name: '亲切女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'wenrounvsheng', name: '温柔女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'jilingshaonv', name: '机灵少女', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'ruanmengnvsheng', name: '软萌女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'youyanvsheng', name: '优雅女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'lengyanyujie', name: '冷艳御姐', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'shuangkuaijiejie', name: '爽快姐姐', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'wenjingxuejie', name: '文静学姐', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'linjiameimei', name: '邻家妹妹', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'zhixingjiejie', name: '知性姐姐', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'shuangkuainansheng', name: '爽快男声', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'ganliannvsheng', name: '干练女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'qinhenvsheng', name: '亲和女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'huolinvsheng', name: '活力女声', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
]

function getApiKey(context: ProviderContext): string {
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('stepfun api_key is required in provider settings.')
  return api_key
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
}

async function uploadFile(
  context: ProviderContext,
  api_key: string,
  audio_sample: VoiceCloneRequest['audio_sample'],
): Promise<StepFunFilePayload> {
  const form = new FormData()
  form.set('purpose', 'storage')
  form.set('file', new Blob([audio_sample.data], { type: audio_sample.mime_type }), audio_sample.file_name)
  const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/files`, {
    method: 'POST',
    headers: { authorization: `Bearer ${api_key}` },
    body: form,
  }, context)
  const payload = await readJsonResponse<StepFunFilePayload>(response, 'errorMessageObject')
  if (!response.ok) {
    const detail = getPayloadError(payload)
    logProviderResponseError('stepfun', 'upload_file', response, detail ?? payload)
    throw new Error(detail || `StepFun file upload request failed: ${response.status}`)
  }
  return payload
}

async function listSystemVoices(context: ProviderContext, api_key: string): Promise<TtsVoice[]> {
  const url = new URL(`${getBaseUrl(context)}/audio/system_voices`)
  url.searchParams.set('model', 'step-tts-2')
  const response = await fetchWithProviderTimeout(url, {
    headers: { authorization: `Bearer ${api_key}` },
  }, context)
  const payload = await readJsonResponse<StepFunSystemVoicePayload>(response, 'errorMessageObject')
  if (!response.ok) {
    const detail = getPayloadError(payload)
    logProviderResponseError('stepfun', 'list_system_voices', response, detail ?? payload)
    return STEPFUN_VOICES
  }
  const details = payload['voices-details'] ?? {}
  const voices = (payload.voices ?? [])
    .map(id => normalizeSystemVoice(id, details[id]))
    .filter((voice): voice is TtsVoice => !!voice)
  return voices.length ? voices : STEPFUN_VOICES
}

async function listClonedVoices(context: ProviderContext, api_key: string): Promise<TtsVoice[]> {
  const voices: TtsVoice[] = []
  let after: string | undefined
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${getBaseUrl(context)}/audio/voices`)
    url.searchParams.set('limit', '100')
    url.searchParams.set('order', 'desc')
    if (after) url.searchParams.set('after', after)
    const response = await fetchWithProviderTimeout(url, {
      headers: { authorization: `Bearer ${api_key}` },
    }, context)
    const payload = await readJsonResponse<StepFunVoiceListPayload>(response, 'errorMessageObject')
    if (!response.ok) {
      const detail = getPayloadError(payload)
      logProviderResponseError('stepfun', 'list_cloned_voices', response, detail ?? payload)
      return voices
    }
    voices.push(...(payload.data ?? [])
      .filter(voice => typeof voice.id === 'string' && voice.id.trim())
      .map(voice => ({
        id: voice.id as string,
        name: voice.id as string,
        locale: 'zh-CN',
        provider: 'stepfun',
      })))
    if (!payload.has_more || !payload.last_id) break
    after = payload.last_id
  }
  return voices
}

function normalizeSystemVoice(
  id: string,
  detail: StepFunSystemVoiceDetail | undefined,
): TtsVoice | null {
  if (!id) return null
  const description = detail?.['voice-description'] ?? ''
  return {
    id,
    name: detail?.['voice-name'] || getStaticVoiceName(id),
    locale: isEnglishStepFunVoice(id, description) ? 'en-US' : 'zh-CN',
    gender: inferGender(description),
    provider: 'stepfun',
  }
}

function getStaticVoiceName(id: string): string {
  return STEPFUN_VOICES.find(voice => voice.id === id)?.name ?? id
}

function inferGender(description: string): string | undefined {
  if (description.includes('男')) return 'Male'
  if (description.includes('女')) return 'Female'
  return undefined
}

function isEnglishStepFunVoice(id: string, description: string): boolean {
  return id.includes('yingwen') || description.includes('英文音色')
}

function normalizeResponseFormat(value: string): StepFunResponseFormat {
  const normalized = value.toLowerCase()
  if (STEPFUN_RESPONSE_FORMATS.includes(normalized as StepFunResponseFormat)) return normalized as StepFunResponseFormat
  return DEFAULT_RESPONSE_FORMAT
}

function normalizeSpeed(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0.5, Math.min(2, Number(value.toFixed(2))))
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'auto') return undefined
  return normalized.split(/[-_]/)[0]
}

function normalizeInstruction(value: string | undefined, model: string): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed || !STEPFUN_INSTRUCTION_MODELS.has(model)) return undefined
  if (trimmed.length > 200) throw new Error('StepFun instruction must be 200 characters or fewer for stepaudio-2.5-tts.')
  return trimmed
}

function normalizeStreamFormat(value: 'audio' | 'sse'): 'audio' | 'sse' {
  if (value === 'audio' || value === 'sse') return value
  throw new Error('stream_format must be "audio" or "sse"')
}

function getResponseContentType(response: Response): string | undefined {
  return response.headers.get('content-type')?.split(';')[0]?.trim() || undefined
}

function isAudioContentType(value: string): boolean {
  return value.startsWith('audio/') || value === 'application/octet-stream'
}

function getMimeType(format: StepFunResponseFormat, responseType: string | undefined): string {
  if (responseType) return responseType
  if (format === 'wav') return 'audio/wav'
  if (format === 'pcm') return 'audio/pcm'
  if (format === 'flac') return 'audio/flac'
  if (format === 'opus') return 'audio/ogg'
  return 'audio/mpeg'
}

function inferAudioFormat(file: TranscribeRequest['file']): 'wav' | 'mp3' | 'ogg' | 'pcm' {
  const mime_type = file.mime_type.toLowerCase()
  const file_name = file.file_name.toLowerCase()
  if (mime_type.includes('mpeg') || mime_type.includes('mp3') || file_name.endsWith('.mp3')) return 'mp3'
  if (mime_type.includes('ogg') || file_name.endsWith('.ogg') || file_name.endsWith('.opus')) return 'ogg'
  if (mime_type.includes('pcm') || file_name.endsWith('.pcm')) return 'pcm'
  return 'wav'
}

function parseSseEvents(text: string): StepFunAsrEvent[] {
  const events: StepFunAsrEvent[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') continue
    try {
      events.push(JSON.parse(data) as StepFunAsrEvent)
    } catch {
      // Ignore heartbeat or diagnostic lines that are not JSON payloads.
    }
  }
  return events
}

function normalizeAsrSegments(events: StepFunAsrEvent[]): TranscribeResult['segments'] {
  const segments = events
    .filter(event => event.type === 'transcript.text.delta' && typeof event.delta === 'string')
    .map(event => ({
      from: Number(event.start_time ?? 0) / 1000,
      to: Number(event.end_time ?? event.start_time ?? 0) / 1000,
      content: event.delta ?? '',
    }))
    .filter(segment => segment.content)
  return segments.length ? segments : undefined
}
