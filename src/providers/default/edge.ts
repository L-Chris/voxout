import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EdgeTTS } from 'node-edge-tts'
import { DEFAULT_PROVIDER_TIMEOUT_MS } from '../../timeout.js'
import type { ProviderContext, SynthesizeRequest, TtsProvider, TtsVoice } from '../../types.js'
import {
  getConfigString,
  getPositiveConfigNumber as getConfigNumber,
  getSecretString,
  logProviderResponseError,
  logProviderUpstreamError,
} from '../provider-utils.js'

const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural'
const DEFAULT_LANG = 'zh-CN'
const DEFAULT_OUTPUT_FORMAT = 'audio-24khz-96kbitrate-mono-mp3'
const EDGE_VOICES_URL = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list'
const EDGE_TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const DEFAULT_VOICE_CACHE_MS = 24 * 60 * 60 * 1000

interface EdgeVoicePayload {
  ShortName?: string
  FriendlyName?: string
  DisplayName?: string
  LocalName?: string
  Locale?: string
  Gender?: string
}

export class EdgeTtsProvider implements TtsProvider {
  readonly id: string
  readonly name: string
  readonly capabilities = { tts: true, tts_streaming: true }
  readonly fields = [
    { key: 'voices_url', label: 'Voice Catalog URL', type: 'url' as const, placeholder: EDGE_VOICES_URL },
    { key: 'trusted_client_token', label: 'Trusted Client Token', type: 'password' as const, secret: true },
    { key: 'proxy', label: 'HTTP Proxy', type: 'url' as const, placeholder: 'http://host.docker.internal:7890' },
  ]
  private voiceCache: { expiresAt: number, voices: TtsVoice[] } | null = null

  constructor(id = 'edge', name = 'Microsoft Edge TTS') {
    this.id = id
    this.name = name
  }

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const now = Date.now()
    if (this.voiceCache && this.voiceCache.expiresAt > now) return this.voiceCache.voices

    const voices = await this.fetchVoices(context).catch(error => {
      logProviderUpstreamError({
        provider: this.id,
        operation: 'edge_voices',
        url: getConfigString(context, 'voices_url') ?? EDGE_VOICES_URL,
        error,
      })
      return fallbackEdgeVoices(this.id)
    })
    const cacheMs = Math.max(0, getConfigNumber(context, 'voices_cache_ms') ?? DEFAULT_VOICE_CACHE_MS)
    if (cacheMs > 0) {
      this.voiceCache = {
        expiresAt: now + cacheMs,
        voices,
      }
    }
    return voices
  }

  private async fetchVoices(context: ProviderContext): Promise<TtsVoice[]> {
    const url = new URL(getConfigString(context, 'voices_url') ?? EDGE_VOICES_URL)
    if (!url.searchParams.has('trustedclienttoken')) {
      url.searchParams.set('trustedclienttoken', getSecretString(context, 'trusted_client_token') ?? EDGE_TRUSTED_CLIENT_TOKEN)
    }
    const timeout = getConfigNumber(context, 'voices_timeout_ms') ?? 10000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) {
        const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
        logProviderResponseError(this.id, 'edge_voices', response, detail)
        throw new Error(detail || `Edge voices request failed: ${response.status}`)
      }
      const payload = await response.json() as EdgeVoicePayload[]
      if (!Array.isArray(payload)) throw new Error('Edge voices response was not an array.')
      const voices = payload
        .map(voice => normalizeEdgeVoice(voice, this.id))
        .filter((voice): voice is TtsVoice => !!voice)
        .sort((a, b) => a.locale === b.locale
          ? a.id.localeCompare(b.id)
          : (a.locale ?? '').localeCompare(b.locale ?? ''))
      return voices.length ? voices : fallbackEdgeVoices(this.id)
    } finally {
      clearTimeout(timer)
    }
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const tempDir = await mkdtemp(join(tmpdir(), 'rebook-edge-tts-'))
    const audioPath = join(tempDir, 'speech.mp3')
    try {
      const voice = request.voice ?? DEFAULT_VOICE
      const output_format = normalizeEdgeOutputFormat(request.output_format)
      const tts = new EdgeTTS({
        voice,
        lang: request.lang ?? inferLangFromVoice(voice),
        outputFormat: output_format,
        saveSubtitles: false,
        pitch: request.pitch ?? 'default',
        rate: normalizeEdgeRate(request.speed),
        volume: request.volume ?? 'default',
        timeout: getConfigNumber(context, 'timeout') ?? DEFAULT_PROVIDER_TIMEOUT_MS,
        proxy: getConfigString(context, 'proxy'),
      })

      await tts.ttsPromise(request.text, audioPath).catch(error => {
        logProviderUpstreamError({
          provider: this.id,
          operation: 'speech',
          error,
        })
        throw error
      })
      const audio = await readFile(audioPath)
      return {
        audio,
        mime_type: getEdgeMimeType(output_format),
        duration_ms: 0,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }

  async streamSynthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const output_format = normalizeEdgeOutputFormat(request.output_format)
    const stream = await createEdgeSpeechStream(request, context)
    if (request.stream_format === 'sse') {
      return {
        stream: wrapAudioStreamAsSse(stream),
        mime_type: 'text/event-stream',
      }
    }
    return {
      stream,
      mime_type: getEdgeMimeType(output_format),
    }
  }
}

async function createEdgeSpeechStream(request: SynthesizeRequest, context: ProviderContext): Promise<ReadableStream<Uint8Array>> {
  const voice = request.voice ?? DEFAULT_VOICE
  const output_format = normalizeEdgeOutputFormat(request.output_format)
  const tts = new EdgeTTS({
    voice,
    lang: request.lang ?? inferLangFromVoice(voice),
    outputFormat: output_format,
    saveSubtitles: false,
    pitch: request.pitch ?? 'default',
    rate: normalizeEdgeRate(request.speed),
    volume: request.volume ?? 'default',
    timeout: getConfigNumber(context, 'timeout') ?? DEFAULT_PROVIDER_TIMEOUT_MS,
    proxy: getConfigString(context, 'proxy'),
  })
  const ws = await tts._connectWebSocket()
  const timeoutMs = getConfigNumber(context, 'timeout') ?? DEFAULT_PROVIDER_TIMEOUT_MS

  let cancelStream: (() => void) | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false
      const timer = setTimeout(() => {
        fail(new Error(`Edge TTS stream timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const close = () => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        controller.close()
        ws.close()
      }
      const fail = (error: Error) => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        controller.error(error)
        ws.close()
      }
      cancelStream = () => {
        if (closed) return
        closed = true
        clearTimeout(timer)
        ws.close()
      }

      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          const audio = readEdgeAudioFrame(data)
          if (audio.length) controller.enqueue(audio)
          return
        }
        const message = data.toString()
        if (message.includes('Path:turn.end')) close()
      })
      ws.on('error', (error: Error) => {
        logProviderUpstreamError({
          provider: 'edge',
          operation: 'speech_stream',
          error,
        })
        fail(error)
      })
      ws.on('close', () => close())

      const requestId = randomBytes(16).toString('hex')
      ws.send(`X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${buildSsml(request.text, voice, request.lang ?? inferLangFromVoice(voice), normalizeEdgeRate(request.speed), request.pitch ?? 'default', request.volume ?? 'default')}`)
    },
    cancel() {
      cancelStream?.()
    },
  })
}

function readEdgeAudioFrame(data: Buffer): Buffer {
  const separator = 'Path:audio\r\n'
  const index = data.indexOf(separator)
  return index >= 0 ? data.subarray(index + separator.length) : Buffer.alloc(0)
}

function buildSsml(text: string, voice: string, lang: string, rate: string, pitch: string, volume: string): string {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${escapeXml(lang)}">
        <voice name="${escapeXml(voice)}">
          <prosody rate="${escapeXml(rate)}" pitch="${escapeXml(pitch)}" volume="${escapeXml(volume)}">
            ${escapeXml(text)}
          </prosody>
        </voice>
      </speak>`
}

function wrapAudioStreamAsSse(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (value?.length) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({
              type: 'audio.delta',
              audio: Buffer.from(value).toString('base64'),
            })}\n\n`))
          }
        }
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

function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, char => {
    if (char === '<') return '&lt;'
    if (char === '>') return '&gt;'
    if (char === '&') return '&amp;'
    if (char === '"') return '&quot;'
    return '&apos;'
  })
}

const FALLBACK_EDGE_VOICES = [
  { id: 'zh-CN-XiaoyiNeural', name: 'Xiaoyi', locale: 'zh-CN', gender: 'Female' },
  { id: 'zh-CN-YunxiNeural', name: 'Yunxi', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-YunjianNeural', name: 'Yunjian', locale: 'zh-CN', gender: 'Male' },
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', locale: 'zh-CN', gender: 'Female' },
  { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female' },
  { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male' },
]

function fallbackEdgeVoices(provider: string): TtsVoice[] {
  return FALLBACK_EDGE_VOICES.map(voice => ({ ...voice, provider }))
}

function normalizeEdgeVoice(voice: EdgeVoicePayload, provider: string): TtsVoice | null {
  if (!voice.ShortName) return null
  return {
    id: voice.ShortName,
    name: voice.DisplayName ?? voice.LocalName ?? voice.FriendlyName ?? voice.ShortName,
    locale: voice.Locale,
    gender: voice.Gender,
    provider,
  }
}

function inferLangFromVoice(voice: string): string {
  const match = /^([a-z]{2}-[A-Z]{2})-/.exec(voice)
  return match?.[1] ?? DEFAULT_LANG
}

function normalizeEdgeRate(speed: number | undefined): string {
  if (speed == null || !Number.isFinite(speed) || speed <= 0 || speed === 1) return 'default'
  return `${Math.round((speed - 1) * 100)}%`
}

function normalizeEdgeOutputFormat(value: string | undefined): string {
  const normalized = value?.toLowerCase().trim()
  if (!normalized || normalized === 'mp3') return DEFAULT_OUTPUT_FORMAT
  if (normalized === 'wav') return 'riff-24khz-16bit-mono-pcm'
  if (normalized === 'pcm') return 'raw-24khz-16bit-mono-pcm'
  if (/^(audio|webm|riff|raw)-/.test(normalized)) return value ?? DEFAULT_OUTPUT_FORMAT
  return DEFAULT_OUTPUT_FORMAT
}

function getEdgeMimeType(output_format: string): string {
  if (output_format.startsWith('riff-')) return 'audio/wav'
  if (output_format.startsWith('raw-')) return 'audio/pcm'
  if (output_format.includes('webm')) return 'audio/webm'
  return 'audio/mpeg'
}
