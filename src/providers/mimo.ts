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
  VoiceCreateRequest,
  VoiceDesignProvider,
  VoiceDesignRequest,
  VoiceDesignResult,
} from '../types.js'
import { getProviderTimeoutMs } from '../timeout.js'
import { randomUUID } from 'node:crypto'
import { TextDecoder, TextEncoder } from 'node:util'
import {
  getConfigBooleanWithFallback as getBooleanConfig,
  getConfigString,
  getJsonStringParam,
  getSecretString,
  mergeJsonBody,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const DEFAULT_TTS_MODEL = 'mimo-v2.5-tts'
const DEFAULT_ASR_MODEL = 'mimo-v2.5-asr'
const DEFAULT_VOICE_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const DEFAULT_VOICE_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const DEFAULT_VOICE = 'mimo_default'
const DEFAULT_FORMAT = 'mp3'
const DEFAULT_VOICE_SAMPLE_TEXT = '你好，我会用这个声音为角色说话。'
const MIMO_TTS_MODELS = [DEFAULT_TTS_MODEL]
const MIMO_ASR_MODELS = [DEFAULT_ASR_MODEL]
const MIMO_VOICE_DESIGN_MODELS = [DEFAULT_VOICE_DESIGN_MODEL]

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
      content?: string
      audio?: {
        data?: string
      }
    }
  }>
}

export class MimoTtsProvider implements TtsProvider, AsrProvider, VoiceDesignProvider, VoiceCloneProvider {
  readonly id = 'mimo'
  readonly name = 'Xiaomi MiMo'
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, asr_streaming: true, voice_design: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_TTS_MODEL, options: MIMO_TTS_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_ASR_MODEL, options: MIMO_ASR_MODELS },
    { key: 'voice_design_model', label: 'Voice Design Model', type: 'text' as const, placeholder: DEFAULT_VOICE_DESIGN_MODEL, options: MIMO_VOICE_DESIGN_MODELS },
    { key: 'voice_clone_model', label: 'Voice Clone Model', type: 'text' as const, placeholder: DEFAULT_VOICE_CLONE_MODEL },
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
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) throw new Error('mimo api_key is required in provider settings.')

    const { body, format } = await this.buildSynthesisBody(api_key, request, context)
    const response = await postMimoCompletion(api_key, body, context)
    const audio_data = response.choices?.[0]?.message?.audio?.data
    if (!audio_data) throw new Error('MiMo TTS response did not include audio data.')
    const audio = Buffer.from(stripDataUrlPrefix(audio_data), 'base64')
    if (audio.length < 128) throw new Error('MiMo TTS response audio was empty.')
    return {
      audio,
      mime_type: getMimeType(format),
      duration_ms: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) throw new Error('mimo api_key is required in provider settings.')

    const stream_format = request.stream_format ?? 'audio'
    const { body, format } = await this.buildSynthesisBody(api_key, request, context, true)
    const response = await postMimoCompletionStream(api_key, { ...body, stream: true }, context)
    if (!response.body) throw new Error('MiMo TTS stream response was empty.')
    if (stream_format === 'sse') {
      return {
        stream: response.body,
        mime_type: response.headers.get('content-type')?.split(';')[0] || 'text/event-stream',
      }
    }
    return {
      stream: decodeMimoAudioSseStream(response.body),
      mime_type: getMimeType(format),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) throw new Error('mimo api_key is required in provider settings.')

    const response = await postMimoCompletion(api_key, buildAsrBody(request, context), context)
    const text = response.choices?.[0]?.message?.content?.trim()
    if (!text) throw new Error('MiMo ASR response did not include transcribed text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      raw: request.format === 'raw' ? response : undefined,
    }
  }

  async streamTranscribe(request: TranscribeRequest, context: ProviderContext = {}) {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) throw new Error('mimo api_key is required in provider settings.')

    const response = await postMimoCompletionStream(api_key, { ...buildAsrBody(request, context), stream: true }, context)
    if (!response.body) throw new Error('MiMo ASR stream response was empty.')
    return {
      stream: decodeMimoTranscriptionSseStream(response.body),
      mime_type: 'text/event-stream',
    }
  }

  async designVoice(request: VoiceDesignRequest, context: ProviderContext = {}): Promise<VoiceDesignResult> {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) throw new Error('mimo api_key is required in provider settings.')

    const sampleText = normalizePrompt(request.input) ?? normalizePrompt(getConfigString(context, 'voice_sample_text')) ?? DEFAULT_VOICE_SAMPLE_TEXT
    const voiceDescription = normalizePrompt(request.instructions)
    if (!voiceDescription) throw new Error('instructions is required')
    const model = request.model ?? getConfigString(context, 'voice_design_model') ?? DEFAULT_VOICE_DESIGN_MODEL
    const sample = await this.createDesignedVoiceSample(api_key, voiceDescription, sampleText, model, context, request.extra_params)
    const voice_id = `mimo_${randomUUID()}`
    return {
      provider: this.id,
      text: sampleText,
      voices: [{
        voice_id,
        name: request.name ?? voiceDescription.slice(0, 48),
        description: voiceDescription,
        language: 'zh-CN',
        preview_audio_data: sample,
        preview_mime_type: 'audio/wav',
        metadata: {
          model,
        },
      }],
    }
  }

  async createDesignedVoice(request: VoiceCreateRequest): Promise<VoiceCloneResult> {
    if (!request.preview_audio_data) throw new Error('preview_audio is required for MiMo voice creation.')
    return {
      provider: this.id,
      voice: {
        voice_id: request.generated_voice_id,
        name: request.name,
        description: request.instructions,
        language: request.language ?? 'zh-CN',
        preview_audio_data: request.preview_audio_data,
        preview_mime_type: request.preview_mime_type ?? getDataUrlMimeType(request.preview_audio_data) ?? 'audio/wav',
        metadata: {
          generated_voice_id: request.generated_voice_id,
          labels: request.labels ?? null,
          created_from_voice_design_preview: true,
        },
      },
    }
  }

  async cloneVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    const audio = fileToAudioDataUrl(request.audio_sample)
    const voice_id = `mimo_${randomUUID()}`
    const description = getJsonStringParam(request.extra_params, 'description')
    const language = getJsonStringParam(request.extra_params, 'language')
    return {
      provider: this.id,
      voice: {
        voice_id,
        name: request.name,
        description,
        language,
        preview_audio_data: audio,
        preview_mime_type: getDataUrlMimeType(audio) ?? request.audio_sample.mime_type,
        metadata: {
          cloned_from_audio_sample: true,
          provider_voice_id: null,
        },
      },
    }
  }

  private getDesignedVoiceSample(api_key: string, voiceDescription: string, context: ProviderContext): Promise<string> {
    const sampleText = normalizePrompt(getConfigString(context, 'voice_sample_text')) ?? DEFAULT_VOICE_SAMPLE_TEXT
    const model = getConfigString(context, 'voice_design_model') ?? DEFAULT_VOICE_DESIGN_MODEL
    const sampleKey = JSON.stringify({
      base_url: getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL,
      model,
      optimize: getBooleanConfig(context, 'optimize_text_preview', true),
      voiceDescription,
      sampleText,
    })
    const cached = this.designedVoiceSamples.get(sampleKey)
    if (cached) return cached
    const promise = this.createDesignedVoiceSample(api_key, voiceDescription, sampleText, model, context)
      .catch(error => {
        this.designedVoiceSamples.delete(sampleKey)
        throw error
      })
    this.designedVoiceSamples.set(sampleKey, promise)
    return promise
  }

  private async createDesignedVoiceSample(api_key: string, voiceDescription: string, sampleText: string, model: string, context: ProviderContext, extra_params?: SynthesizeRequest['extra_params']): Promise<string> {
    const response = await postMimoCompletion(api_key, mergeJsonBody({
      model,
      messages: buildMessages(sampleText, voiceDescription),
      audio: {
        format: 'wav',
        optimize_text_preview: getBooleanConfig(context, 'optimize_text_preview', true),
      },
    }, extra_params), context)
    const audio_data = response.choices?.[0]?.message?.audio?.data
    if (!audio_data) throw new Error('MiMo voice design response did not include audio data.')
    const base64 = stripDataUrlPrefix(audio_data)
    const audio = Buffer.from(base64, 'base64')
    if (audio.length < 128) throw new Error('MiMo voice design response audio was empty.')
    return `data:audio/wav;base64,${base64}`
  }

  private async buildSynthesisBody(api_key: string, request: SynthesizeRequest, context: ProviderContext, streaming = false) {
    const text = request.text.trim()
    const instructions = normalizePrompt(request.instructions)
    const format = normalizeAudioFormat(request.output_format ?? getConfigString(context, 'format') ?? (streaming ? 'pcm16' : DEFAULT_FORMAT))
    const designedVoice = request.voice?.startsWith('data:')
      ? request.voice
      : undefined
    const voice = designedVoice ?? request.voice ?? DEFAULT_VOICE
    return {
      format,
      body: mergeJsonBody({
        model: designedVoice
          ? getConfigString(context, 'voice_clone_model') ?? DEFAULT_VOICE_CLONE_MODEL
          : request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_TTS_MODEL,
        messages: buildMessages(text, undefined, instructions),
        audio: {
          format,
          voice,
        },
      }, request.extra_params),
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

function buildAsrBody(request: TranscribeRequest, context: ProviderContext) {
  return mergeJsonBody({
    model: request.model ?? getConfigString(context, 'asr_model') ?? DEFAULT_ASR_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'input_audio',
            input_audio: {
              data: fileToAudioDataUrl(request.file),
            },
          },
        ],
      },
    ],
    asr_options: {
      language: request.language?.trim() || 'auto',
    },
  }, request.extra_params)
}

async function postMimoCompletion(api_key: string, body: unknown, context: ProviderContext): Promise<MimoCompletionResponse> {
  const base_url = trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
  const url = `${base_url}/chat/completions`
  const timeout = getProviderTimeoutMs(context)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': api_key,
        'authorization': `Bearer ${api_key}`,
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

async function postMimoCompletionStream(api_key: string, body: unknown, context: ProviderContext): Promise<Response> {
  const base_url = trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
  const timeout = getProviderTimeoutMs(context)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  let response: Response
  try {
    response = await fetch(`${base_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'api-key': api_key,
        'authorization': `Bearer ${api_key}`,
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

function getDataUrlMimeType(value: string): string | undefined {
  return /^data:([^;,]+)/.exec(value)?.[1]
}

function fileToAudioDataUrl(file: TranscribeRequest['file']): string {
  return `data:${normalizeMimeType(file.mime_type)};base64,${file.data.toString('base64')}`
}

function normalizeMimeType(value?: string): string {
  const mime_type = value?.split(';')[0]?.trim()
  return mime_type || 'audio/mpeg'
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

function decodeMimoTranscriptionSseStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''
  let transcript = ''
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const emitted = emitMimoTranscriptionEvents(buffer, controller, encoder, transcript)
          buffer = emitted.remainder
          transcript = emitted.transcript
        }
        buffer += decoder.decode()
        const emitted = emitMimoTranscriptionEvents(`${buffer}\n\n`, controller, encoder, transcript)
        transcript = emitted.transcript
        enqueueSse(controller, encoder, { type: 'transcript.text.done', text: transcript })
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
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

function emitMimoTranscriptionEvents(
  buffer: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  transcript: string,
): { remainder: string, transcript: string } {
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
    const delta = parseMimoTextChunk(data)
    if (!delta) continue
    transcript += delta
    enqueueSse(controller, encoder, { type: 'transcript.text.delta', delta })
  }
  return { remainder, transcript }
}

function enqueueSse(controller: ReadableStreamDefaultController<Uint8Array>, encoder: TextEncoder, payload: unknown): void {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
}

function parseMimoTextChunk(data: string): string {
  try {
    const payload = JSON.parse(data) as MimoCompletionChunk
    return payload.choices?.[0]?.delta?.content ?? ''
  } catch {
    return ''
  }
}

function parseMimoAudioChunk(data: string): Buffer {
  try {
    const payload = JSON.parse(data) as MimoCompletionChunk
    const audio_data = payload.choices?.[0]?.delta?.audio?.data
    return audio_data ? Buffer.from(stripDataUrlPrefix(audio_data), 'base64') : Buffer.alloc(0)
  } catch {
    return Buffer.alloc(0)
  }
}
