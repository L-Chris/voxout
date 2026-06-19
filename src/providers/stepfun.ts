import type {
  ProviderContext,
  SynthesizeRequest,
  TtsProvider,
  TtsVoice,
} from '../types.js'
import {
  fetchWithProviderTimeout,
  getConfigString,
  getSecretString,
  logProviderResponseError,
  mergeJsonBody,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://api.stepfun.com/v1'
const DEFAULT_TTS_MODEL = 'step-tts-mini'
const DEFAULT_VOICE = 'cixingnansheng'
const DEFAULT_RESPONSE_FORMAT = 'mp3'
const STEPFUN_TTS_MODELS = ['step-tts-2', 'step-tts-mini', 'stepaudio-2.5-tts']
const STEPFUN_RESPONSE_FORMATS = ['mp3', 'opus', 'flac', 'wav', 'pcm'] as const
const STEPFUN_INSTRUCTION_MODELS = new Set(['stepaudio-2.5-tts'])

type StepFunResponseFormat = typeof STEPFUN_RESPONSE_FORMATS[number]

export class StepFunProvider implements TtsProvider {
  readonly id = 'stepfun'
  readonly name = 'StepFun'
  readonly capabilities = { tts: true, tts_streaming: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: STEPFUN_TTS_MODELS },
    { key: 'default_voice', label: 'Default Voice', type: 'text' as const, placeholder: DEFAULT_VOICE, options: STEPFUN_VOICES.map(voice => voice.id) },
    { key: 'response_format', label: 'Response Format', type: 'text' as const, placeholder: DEFAULT_RESPONSE_FORMAT, options: [...STEPFUN_RESPONSE_FORMATS] },
  ]

  async listVoices(): Promise<TtsVoice[]> {
    return STEPFUN_VOICES.map(voice => ({
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
}

const STEPFUN_VOICES: TtsVoice[] = [
  { id: 'vibrant-youth', name: 'Vibrant Youth', locale: 'zh-CN', provider: 'stepfun' },
  { id: 'lively-girl', name: 'Lively Girl', locale: 'zh-CN', gender: 'Female', provider: 'stepfun' },
  { id: 'soft-spoken-gentleman', name: 'Soft-spoken Gentleman', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
  { id: 'magnetic-voiced-male', name: 'Magnetic-voiced Male', locale: 'zh-CN', gender: 'Male', provider: 'stepfun' },
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

function normalizeResponseFormat(value: string): StepFunResponseFormat {
  const normalized = value.toLowerCase()
  if (STEPFUN_RESPONSE_FORMATS.includes(normalized as StepFunResponseFormat)) return normalized as StepFunResponseFormat
  return DEFAULT_RESPONSE_FORMAT
}

function normalizeSpeed(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0.5, Math.min(2, Number(value.toFixed(2))))
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
