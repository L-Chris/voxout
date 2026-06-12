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
  VoiceDesignProvider,
  VoiceDesignRequest,
  VoiceDesignResult,
} from '../types.js'
import { getProviderTimeoutMs } from '../timeout.js'
import { randomUUID } from 'node:crypto'
import { TextDecoder } from 'node:util'

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const DEFAULT_TTS_MODEL = 'mimo-v2.5-tts'
const DEFAULT_ASR_MODEL = 'mimo-v2.5-asr'
const DEFAULT_VOICE_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const DEFAULT_VOICE_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const DEFAULT_VOICE = 'mimo_default'
const DEFAULT_FORMAT = 'wav'
const DEFAULT_VOICE_SAMPLE_TEXT = '你好，我会用这个声音为角色说话。'
const MIMO_TTS_MODELS = [DEFAULT_TTS_MODEL]
const MIMO_ASR_MODELS = [DEFAULT_ASR_MODEL]

interface MimoCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string
      audio?: {
        data?: string
        transcript?: string
      }
    }
  }>
  error?: {
    message?: string
  }
}

interface MimoCompletionChunk {
  choices?: Array<{
    delta?: {
      audio?: {
        data?: string
      }
    }
  }>
}

export class MimoTtsProvider implements TtsProvider, AsrProvider, VoiceDesignProvider, VoiceCloneProvider {
  readonly id = 'mimo'
  readonly name = 'Xiaomi MiMo'
  readonly capabilities = { tts: true, ttsStreaming: true, asr: true, voiceDesign: true, voiceClone: true }
  readonly fields = [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'baseUrl', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'ttsModel', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: MIMO_TTS_MODELS },
    { key: 'asrModel', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: MIMO_ASR_MODELS },
    { key: 'voiceDesignModel', label: 'Voice Design Model', type: 'text' as const, placeholder: DEFAULT_VOICE_DESIGN_MODEL },
    { key: 'voiceCloneModel', label: 'Voice Clone Model', type: 'text' as const, placeholder: DEFAULT_VOICE_CLONE_MODEL },
    { key: 'format', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_FORMAT },
  ]
  private readonly designedVoiceSamples = new Map<string, Promise<string>>()

  async listVoices(): Promise<TtsVoice[]> {
    return MIMO_PRESET_VOICES.map(voice => ({
      ...voice,
      capabilities: this.capabilities,
    }))
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) throw new Error('mimo apiKey is required in provider settings.')

    const { body, format } = await this.buildSynthesisBody(apiKey, request, context)
    const response = await postMimoCompletion(apiKey, body, context)
    const audioData = response.choices?.[0]?.message?.audio?.data
    if (!audioData) throw new Error('MiMo TTS response did not include audio data.')
    const audio = Buffer.from(stripDataUrlPrefix(audioData), 'base64')
    if (audio.length < 128) throw new Error('MiMo TTS response audio was empty.')
    return {
      audio,
      mimeType: getMimeType(format),
      durationMs: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) throw new Error('mimo apiKey is required in provider settings.')

    const streamFormat = request.streamFormat ?? 'audio'
    const { body, format } = await this.buildSynthesisBody(apiKey, request, context, true)
    const response = await postMimoCompletionStream(apiKey, { ...body, stream: true }, context)
    if (!response.body) throw new Error('MiMo TTS stream response was empty.')
    if (streamFormat === 'sse') {
      return {
        stream: response.body,
        mimeType: response.headers.get('content-type')?.split(';')[0] || 'text/event-stream',
      }
    }
    return {
      stream: decodeMimoAudioSseStream(response.body),
      mimeType: getMimeType(format),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) throw new Error('mimo apiKey is required in provider settings.')

    const audioData = await resolveAudioDataUrl(request, context)
    const response = await postMimoCompletion(apiKey, {
      model: request.model ?? getConfigString(context, 'asrModel') ?? DEFAULT_ASR_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                data: audioData,
              },
            },
          ],
        },
      ],
      asr_options: {
        language: request.language?.trim() || 'auto',
      },
    }, context)
    const text = response.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('MiMo ASR response did not include transcribed text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      raw: request.format === 'raw' ? response : undefined,
    }
  }

  async designVoice(request: VoiceDesignRequest, context: ProviderContext = {}): Promise<VoiceDesignResult> {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) throw new Error('mimo apiKey is required in provider settings.')

    const sampleText = normalizePrompt(request.text) ?? normalizePrompt(getConfigString(context, 'voiceSampleText')) ?? DEFAULT_VOICE_SAMPLE_TEXT
    const voiceDescription = normalizePrompt(request.voiceDescription)
    if (!voiceDescription) throw new Error('voiceDescription is required')
    const sample = await this.createDesignedVoiceSample(apiKey, voiceDescription, sampleText, context)
    const voiceId = `mimo_${randomUUID()}`
    return {
      provider: this.id,
      text: sampleText,
      voices: [{
        voiceId,
        name: request.name ?? voiceDescription.slice(0, 48),
        description: voiceDescription,
        language: 'zh-CN',
        previewAudioData: sample,
        previewMimeType: 'audio/wav',
        metadata: {
          model: getConfigString(context, 'voiceDesignModel') ?? DEFAULT_VOICE_DESIGN_MODEL,
        },
      }],
    }
  }

  async cloneVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    const audio = normalizeAudioDataUrl(request.audioData, request.mimeType)
    const voiceId = `mimo_${randomUUID()}`
    return {
      provider: this.id,
      voice: {
        voiceId,
        name: request.name,
        description: request.description,
        language: request.language,
        previewAudioData: audio,
        previewMimeType: getDataUrlMimeType(audio) ?? request.mimeType ?? 'audio/wav',
        metadata: {
          cloned_from_audio_sample: true,
          provider_voice_id: null,
        },
      },
    }
  }

  private getDesignedVoiceSample(apiKey: string, voiceDescription: string, context: ProviderContext): Promise<string> {
    const sampleText = normalizePrompt(getConfigString(context, 'voiceSampleText')) ?? DEFAULT_VOICE_SAMPLE_TEXT
    const sampleKey = JSON.stringify({
      baseUrl: getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL,
      model: getConfigString(context, 'voiceDesignModel') ?? DEFAULT_VOICE_DESIGN_MODEL,
      optimize: getBooleanConfig(context, 'optimizeTextPreview', true),
      voiceDescription,
      sampleText,
    })
    const cached = this.designedVoiceSamples.get(sampleKey)
    if (cached) return cached
    const promise = this.createDesignedVoiceSample(apiKey, voiceDescription, sampleText, context)
      .catch(error => {
        this.designedVoiceSamples.delete(sampleKey)
        throw error
      })
    this.designedVoiceSamples.set(sampleKey, promise)
    return promise
  }

  private async createDesignedVoiceSample(apiKey: string, voiceDescription: string, sampleText: string, context: ProviderContext): Promise<string> {
    const response = await postMimoCompletion(apiKey, {
      model: getConfigString(context, 'voiceDesignModel') ?? DEFAULT_VOICE_DESIGN_MODEL,
      messages: buildMessages(sampleText, voiceDescription),
      audio: {
        format: 'wav',
        optimize_text_preview: getBooleanConfig(context, 'optimizeTextPreview', true),
      },
    }, context)
    const audioData = response.choices?.[0]?.message?.audio?.data
    if (!audioData) throw new Error('MiMo voice design response did not include audio data.')
    const base64 = stripDataUrlPrefix(audioData)
    const audio = Buffer.from(base64, 'base64')
    if (audio.length < 128) throw new Error('MiMo voice design response audio was empty.')
    return `data:audio/wav;base64,${base64}`
  }

  private async buildSynthesisBody(apiKey: string, request: SynthesizeRequest, context: ProviderContext, streaming = false) {
    const text = request.text.trim()
    const instructions = normalizePrompt(request.instructions)
    const format = normalizeAudioFormat(request.outputFormat ?? getConfigString(context, 'format') ?? (streaming ? 'pcm16' : DEFAULT_FORMAT))
    const designedVoice = request.voice?.startsWith('data:')
      ? request.voice
      : undefined
    const voice = designedVoice ?? request.voice ?? DEFAULT_VOICE
    return {
      format,
      body: {
        model: designedVoice
          ? getConfigString(context, 'voiceCloneModel') ?? DEFAULT_VOICE_CLONE_MODEL
          : request.model ?? getConfigString(context, 'ttsModel') ?? DEFAULT_TTS_MODEL,
        messages: buildMessages(text, undefined, instructions),
        audio: {
          format,
          voice,
        },
      },
    }
  }
}

const MIMO_PRESET_VOICES: TtsVoice[] = [
  { id: 'mimo_default', name: 'MiMo Default', locale: 'zh-CN', gender: 'Female', provider: 'mimo' },
  { id: '冰糖', name: '冰糖', locale: 'zh-CN', gender: 'Female', provider: 'mimo' },
  { id: '茉莉', name: '茉莉', locale: 'zh-CN', gender: 'Female', provider: 'mimo' },
  { id: '苏打', name: '苏打', locale: 'zh-CN', gender: 'Male', provider: 'mimo' },
  { id: '白桦', name: '白桦', locale: 'zh-CN', gender: 'Male', provider: 'mimo' },
  { id: 'Mia', name: 'Mia', locale: 'en-US', gender: 'Female', provider: 'mimo' },
  { id: 'Chloe', name: 'Chloe', locale: 'en-US', gender: 'Female', provider: 'mimo' },
  { id: 'Milo', name: 'Milo', locale: 'en-US', gender: 'Male', provider: 'mimo' },
  { id: 'Dean', name: 'Dean', locale: 'en-US', gender: 'Male', provider: 'mimo' },
]

function buildMessages(text: string, voiceDescription?: string, instructions?: string) {
  const messages: Array<{ role: 'user' | 'assistant', content: string }> = []
  const userPrompt = [
    voiceDescription,
    instructions && voiceDescription ? `Performance style: ${instructions}` : instructions,
  ].filter(Boolean).join('\n')
  if (userPrompt) messages.push({ role: 'user', content: userPrompt })
  messages.push({ role: 'assistant', content: text })
  return messages
}

async function postMimoCompletion(apiKey: string, body: unknown, context: ProviderContext): Promise<MimoCompletionResponse> {
  const baseUrl = trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
  const url = `${baseUrl}/chat/completions`
  const timeoutMs = getProviderTimeoutMs(context)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': apiKey,
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload: MimoCompletionResponse
    try {
      payload = JSON.parse(text) as MimoCompletionResponse
    } catch {
      payload = {}
    }
    if (!response.ok) {
      const message = (payload.error?.message ?? text.slice(0, 500)) || `MiMo request failed: ${response.status}`
      throw new Error(message)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

async function postMimoCompletionStream(apiKey: string, body: unknown, context: ProviderContext): Promise<Response> {
  const baseUrl = trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
  const timeoutMs = getProviderTimeoutMs(context)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': apiKey,
        'authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text.slice(0, 500) || `MiMo stream request failed: ${response.status}`)
  }
  return response
}

function normalizePrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function normalizeAudioFormat(value: string): 'mp3' | 'wav' | 'pcm16' {
  const normalized = value.toLowerCase()
  if (normalized.includes('mp3')) return 'mp3'
  if (normalized === 'pcm' || normalized === 'pcm16' || normalized.includes('pcm16')) return 'pcm16'
  return 'wav'
}

function getMimeType(format: 'mp3' | 'wav' | 'pcm16'): string {
  if (format === 'pcm16') return 'audio/pcm'
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',')
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
}

function normalizeAudioDataUrl(value: string, mimeType = 'audio/wav'): string {
  if (value.startsWith('data:')) return value
  return `data:${mimeType};base64,${value}`
}

function getDataUrlMimeType(value: string): string | undefined {
  return /^data:([^;,]+)/.exec(value)?.[1]
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

function getBooleanConfig(context: ProviderContext, key: string, fallback: boolean): boolean {
  const value = context.config?.[key]
  if (typeof value === 'boolean') return value
  return fallback
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

async function resolveAudioDataUrl(request: TranscribeRequest, context: ProviderContext): Promise<string> {
  if (request.audioData?.trim()) {
    const value = request.audioData.trim()
    if (value.startsWith('data:')) return value
    return `data:${normalizeMimeType(request.mimeType)};base64,${value}`
  }
  if (!request.url) throw new Error('MiMo ASR requires input.audioData or input.url.')
  const response = await fetch(request.url, { signal: AbortSignal.timeout(getProviderTimeoutMs(context)) })
  if (!response.ok) throw new Error(`Failed to download audio for MiMo ASR: ${response.status}`)
  const audio = Buffer.from(await response.arrayBuffer())
  if (audio.length === 0) throw new Error('Downloaded audio for MiMo ASR was empty.')
  const mimeType = normalizeMimeType(request.mimeType ?? response.headers.get('content-type') ?? undefined)
  return `data:${mimeType};base64,${audio.toString('base64')}`
}

function normalizeMimeType(value?: string): string {
  const mimeType = value?.split(';')[0]?.trim()
  return mimeType || 'audio/mpeg'
}

function decodeMimoAudioSseStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  let buffer = ''
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          buffer = emitMimoAudioEvents(buffer, controller)
        }
        buffer += decoder.decode()
        emitMimoAudioEvents(`${buffer}\n\n`, controller)
        controller.close()
      } catch (error) {
        controller.error(error)
      } finally {
        reader.releaseLock()
      }
    },
  })
}

function emitMimoAudioEvents(buffer: string, controller: ReadableStreamDefaultController<Uint8Array>): string {
  const parts = buffer.split(/\r?\n\r?\n/)
  const remainder = parts.pop() ?? ''
  for (const part of parts) {
    const data = part
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') continue
    const chunk = parseMimoAudioChunk(data)
    if (chunk.length) controller.enqueue(chunk)
  }
  return remainder
}

function parseMimoAudioChunk(data: string): Buffer {
  try {
    const payload = JSON.parse(data) as MimoCompletionChunk
    const audioData = payload.choices?.[0]?.delta?.audio?.data
    return audioData ? Buffer.from(stripDataUrlPrefix(audioData), 'base64') : Buffer.alloc(0)
  } catch {
    return Buffer.alloc(0)
  }
}
