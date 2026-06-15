import { Blob } from 'node:buffer'
import WebSocket from 'ws'
import { getProviderTimeoutMs } from '../timeout.js'
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
  fetchWithProviderTimeout,
  getConfigNumber,
  getConfigString,
  getSecretString,
  mergeJsonBody,
  readJsonResponse,
  trimTrailingSlash,
} from './provider-utils.js'

const DEFAULT_BASE_URL = 'https://api.gradium.ai/api'
const DEFAULT_WS_URL = 'wss://api.gradium.ai/api'
const DEFAULT_MODEL = 'default'
const DEFAULT_VOICE_ID = 'YTpq7expH9539ERJ'
const DEFAULT_OUTPUT_FORMAT = 'wav'
const GRADIUM_MODELS = [DEFAULT_MODEL]
const GRADIUM_OUTPUT_FORMATS = ['wav', 'pcm', 'opus', 'ulaw_8000', 'mulaw_8000', 'alaw_8000', 'pcm_8000', 'pcm_16000', 'pcm_22050', 'pcm_24000', 'pcm_44100', 'pcm_48000']

interface GradiumVoicePayload {
  uid?: string
  name?: string
  is_catalog?: boolean
  is_pro_clone?: boolean
  description?: string | null
  language?: string | null
  tags?: unknown[]
}

interface GradiumCreateVoicePayload {
  uid?: string | null
  error?: string | null
  was_updated?: boolean
}

interface GradiumStreamMessage {
  type?: string
  audio?: string
  text?: string
  message?: string
  error?: string
}

export class GradiumProvider implements TtsProvider, AsrProvider, VoiceCloneProvider {
  readonly id = 'gradium'
  readonly name = 'Gradium'
  readonly capabilities = { tts: true, tts_streaming: true, asr: true, voice_clone: true }
  readonly fields = [
    { key: 'api_key', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'base_url', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'ws_url', label: 'WebSocket URL', type: 'url' as const, placeholder: DEFAULT_WS_URL },
    { key: 'tts_model', label: 'TTS Model', type: 'text' as const, placeholder: DEFAULT_MODEL, options: GRADIUM_MODELS },
    { key: 'asr_model', label: 'ASR Model', type: 'text' as const, placeholder: DEFAULT_MODEL, options: GRADIUM_MODELS },
    { key: 'default_voice_id', label: 'Default Voice ID', type: 'text' as const, placeholder: DEFAULT_VOICE_ID },
    { key: 'output_format', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT, options: GRADIUM_OUTPUT_FORMATS },
  ]

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const api_key = getSecretString(context, 'api_key')
    if (!api_key) return [getDefaultVoice(this.id, context)]

    const payload = await listGradiumVoices(context, api_key)
    const voices = payload
      .map(voice => normalizeVoice(voice, this.id))
      .filter((voice): voice is TtsVoice => !!voice)
    return voices.length ? voices : [getDefaultVoice(this.id, context)]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const api_key = getApiKey(context)
    const output_format = normalizeOutputFormat(request.output_format ?? getConfigString(context, 'output_format') ?? DEFAULT_OUTPUT_FORMAT)
    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/post/speech/tts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': api_key,
      },
      body: JSON.stringify(mergeJsonBody({
        text: request.text.trim(),
        voice_id: getVoiceId(request, context),
        model_name: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_MODEL,
        output_format: output_format,
        only_audio: true,
      }, request.extra_params)),
    }, context)
    const audio = Buffer.from(await response.arrayBuffer())
    if (!response.ok) {
      const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `Gradium text-to-speech request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('Gradium text-to-speech response audio was empty.')
    return {
      audio,
      mime_type: response.headers.get('content-type')?.split(';')[0] || getMimeType(output_format),
      duration_ms: 0,
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    if ((request.stream_format ?? 'audio') === 'sse') throw new Error('Gradium TTS streaming supports stream_format "audio" only.')
    const output_format = normalizeOutputFormat(request.output_format ?? getConfigString(context, 'output_format') ?? 'pcm')
    return {
      stream: createGradiumAudioStream(request, context, output_format),
      mime_type: getMimeType(output_format),
    }
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const api_key = getApiKey(context)
    const inputFormat = getGradiumInputFormat(request.file.mime_type)
    const url = new URL(`${getBaseUrl(context)}/post/speech/asr`)
    url.searchParams.set('model', request.model ?? getConfigString(context, 'asr_model') ?? DEFAULT_MODEL)
    url.searchParams.set('input_format', inputFormat)
    const language = normalizeLanguage(request.language)
    if (language) url.searchParams.set('json_config', JSON.stringify({ language }))

    const response = await fetchWithProviderTimeout(url, {
      method: 'POST',
      headers: {
        'content-type': request.file.mime_type,
        'x-api-key': api_key,
      },
      body: new Blob([request.file.data], { type: request.file.mime_type }),
    }, context)
    const text = await response.text()
    if (!response.ok) throw new Error(text.slice(0, 500) || `Gradium speech-to-text request failed: ${response.status}`)
    const parsed = parseGradiumTranscription(text)
    if (!parsed.text) throw new Error('Gradium speech-to-text response did not include text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text: parsed.text,
      raw: request.format === 'raw' ? parsed.raw : undefined,
    }
  }

  async cloneVoice(request: VoiceCloneRequest, context: ProviderContext = {}): Promise<VoiceCloneResult> {
    const api_key = getApiKey(context)
    const audio = request.audio_sample
    const form = new FormData()
    form.set('audio_file', new Blob([audio.data], { type: audio.mime_type }), audio.file_name)
    form.set('name', request.name)
    form.set('input_format', getGradiumInputFormat(audio.mime_type))
    if (request.description) form.set('description', request.description)
    if (request.language) form.set('language', normalizeLanguage(request.language) ?? request.language)
    form.set('start_s', '0')
    form.set('timeout_s', String(getConfigNumber(context, 'clone_timeout_seconds') ?? 10))
    appendJsonParamsToForm(form, request.extra_params)

    const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/voices/`, {
      method: 'POST',
      headers: { 'x-api-key': api_key },
      body: form,
    }, context)
    const payload = await readJsonResponse<GradiumCreateVoicePayload>(response)
    if (!response.ok) {
      throw new Error(payload.error || `Gradium voice clone request failed: ${response.status}`)
    }
    if (payload.error) throw new Error(payload.error)
    if (!payload.uid) throw new Error('Gradium voice clone response did not include uid.')
    return {
      provider: this.id,
      voice: {
        voice_id: payload.uid,
        provider_voice_id: payload.uid,
        name: request.name,
        description: request.description,
        language: request.language,
        metadata: {
          was_updated: payload.was_updated ?? false,
        },
      },
      raw: payload,
    }
  }
}

async function listGradiumVoices(context: ProviderContext, api_key: string): Promise<GradiumVoicePayload[]> {
  const voices: GradiumVoicePayload[] = []
  const limit = 100
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${getBaseUrl(context)}/voices/`)
    url.searchParams.set('skip', String(page * limit))
    url.searchParams.set('limit', String(limit))
    url.searchParams.set('include_catalog', 'true')
    const response = await fetchWithProviderTimeout(url, {
      headers: { 'x-api-key': api_key },
    }, context)
    if (!response.ok) return voices
    const payload = await readJsonResponse<GradiumVoicePayload[]>(response)
    const pageVoices = Array.isArray(payload) ? payload : []
    voices.push(...pageVoices)
    if (pageVoices.length < limit) break
  }
  return voices
}

function createGradiumAudioStream(request: SynthesizeRequest, context: ProviderContext, output_format: string): ReadableStream<Uint8Array> {
  const api_key = getApiKey(context)
  const ws = new WebSocket(`${getWsUrl(context)}/speech/tts`, {
    headers: { 'x-api-key': api_key },
  })
  let settled = false
  const timeout_ms = getProviderTimeoutMs(context)
  let timer: ReturnType<typeof setTimeout> | undefined

  return new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setTimeout(() => {
        settled = true
        ws.close()
        controller.error(new Error('Gradium text-to-speech stream timed out.'))
      }, timeout_ms)

      ws.on('open', () => {
        ws.send(JSON.stringify(mergeJsonBody({
          type: 'setup',
          voice_id: getVoiceId(request, context),
          model_name: request.model ?? getConfigString(context, 'tts_model') ?? DEFAULT_MODEL,
          output_format: output_format,
          close_ws_on_eos: true,
        }, request.extra_params)))
        ws.send(JSON.stringify({ type: 'text', text: request.text.trim() }))
        ws.send(JSON.stringify({ type: 'end_of_stream' }))
      })

      ws.on('message', data => {
        const message = parseWebSocketMessage(data)
        if (message.type === 'audio' && message.audio) {
          controller.enqueue(Buffer.from(message.audio, 'base64'))
        } else if (message.type === 'error') {
          settled = true
          clearStreamTimer(timer)
          ws.close()
          controller.error(new Error(message.message || message.error || 'Gradium text-to-speech stream failed.'))
        } else if (message.type === 'end_of_stream') {
          settled = true
          clearStreamTimer(timer)
          ws.close()
          controller.close()
        }
      })

      ws.on('error', error => {
        if (settled) return
        settled = true
        clearStreamTimer(timer)
        controller.error(error)
      })

      ws.on('close', () => {
        if (settled) return
        settled = true
        clearStreamTimer(timer)
        controller.close()
      })
    },
    cancel() {
      settled = true
      clearStreamTimer(timer)
      ws.close()
    },
  })
}

function parseWebSocketMessage(data: WebSocket.RawData): GradiumStreamMessage {
  const text = Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : Buffer.isBuffer(data)
      ? data.toString('utf8')
      : String(data)
  try {
    return JSON.parse(text) as GradiumStreamMessage
  } catch {
    return { type: 'error', message: text }
  }
}

function parseGradiumTranscription(value: string): { text: string, raw: unknown[] | string } {
  const lines = value.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const messages: unknown[] = []
  const text: string[] = []
  for (const line of lines) {
    try {
      const message = JSON.parse(line) as GradiumStreamMessage
      messages.push(message)
      if ((message.type === 'text' || message.type === 'end_text') && message.text) text.push(message.text)
      if (message.type === 'error') throw new Error(message.message || message.error || 'Gradium speech-to-text failed.')
    } catch (error) {
      if (error instanceof Error && line.startsWith('{')) throw error
      text.push(line)
    }
  }
  return {
    text: text.join('').trim(),
    raw: messages.length ? messages : value,
  }
}

function getVoiceId(request: SynthesizeRequest, context: ProviderContext): string {
  return request.voice ?? getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
}

function normalizeVoice(voice: GradiumVoicePayload, provider: string): TtsVoice | null {
  if (!voice.uid) return null
  return {
    id: voice.uid,
    name: voice.name ?? voice.uid,
    locale: voice.language ?? undefined,
    provider,
    capabilities: { tts: true, tts_streaming: true, voice_clone: !voice.is_catalog },
  }
}

function getDefaultVoice(provider: string, context: ProviderContext): TtsVoice {
  const id = getConfigString(context, 'default_voice_id') ?? DEFAULT_VOICE_ID
  return { id, name: 'Gradium Default', provider }
}

function getApiKey(context: ProviderContext): string {
  const api_key = getSecretString(context, 'api_key')
  if (!api_key) throw new Error('gradium api_key is required in provider settings.')
  return api_key
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'base_url') ?? DEFAULT_BASE_URL)
}

function getWsUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'ws_url') ?? getBaseUrl(context).replace(/^http/i, 'ws') ?? DEFAULT_WS_URL)
}

function normalizeOutputFormat(value: string): string {
  const normalized = value.toLowerCase()
  if (GRADIUM_OUTPUT_FORMATS.includes(normalized)) return normalized
  if (normalized === 'mp3') return 'wav'
  return DEFAULT_OUTPUT_FORMAT
}

function getMimeType(format: string): string {
  if (format === 'opus') return 'audio/ogg'
  if (format.includes('ulaw') || format.includes('mulaw') || format.includes('alaw')) return 'audio/basic'
  if (format === 'pcm' || format.startsWith('pcm_')) return 'audio/pcm'
  return 'audio/wav'
}

function getGradiumInputFormat(mime_type: string): string {
  if (mime_type.includes('opus') || mime_type.includes('ogg')) return 'opus'
  if (mime_type.includes('pcm')) return 'pcm'
  return 'wav'
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  if (!normalized || normalized === 'auto') return undefined
  return normalized.split(/[-_]/)[0]
}

function clearStreamTimer(timer: ReturnType<typeof setTimeout> | undefined): void {
  if (timer) clearTimeout(timer)
}
