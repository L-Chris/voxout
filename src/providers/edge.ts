import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EdgeTTS } from 'node-edge-tts'
import type { ProviderContext, SynthesizeRequest, TtsProvider, TtsVoice } from '../types.js'

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
  readonly id = 'edge'
  readonly name = 'Microsoft Edge TTS'
  readonly capabilities = { tts: true }
  readonly fields = [
    { key: 'voicesUrl', label: 'Voice Catalog URL', type: 'url' as const, placeholder: EDGE_VOICES_URL },
    { key: 'trustedClientToken', label: 'Trusted Client Token', type: 'password' as const, secret: true },
    { key: 'proxy', label: 'HTTP Proxy', type: 'url' as const, placeholder: 'http://host.docker.internal:7890' },
    { key: 'timeoutMs', label: 'Synthesis Timeout', type: 'number' as const, placeholder: '30000' },
  ]
  private voiceCache: { expiresAt: number, voices: TtsVoice[] } | null = null

  async listVoices(context: ProviderContext = {}): Promise<TtsVoice[]> {
    const now = Date.now()
    if (this.voiceCache && this.voiceCache.expiresAt > now) return this.voiceCache.voices

    const voices = await this.fetchVoices(context).catch(() => FALLBACK_EDGE_VOICES)
    const cacheMs = Math.max(0, getConfigNumber(context, 'voicesCacheMs') ?? DEFAULT_VOICE_CACHE_MS)
    if (cacheMs > 0) {
      this.voiceCache = {
        expiresAt: now + cacheMs,
        voices,
      }
    }
    return voices
  }

  private async fetchVoices(context: ProviderContext): Promise<TtsVoice[]> {
    const url = new URL(getConfigString(context, 'voicesUrl') ?? EDGE_VOICES_URL)
    if (!url.searchParams.has('trustedclienttoken')) {
      url.searchParams.set('trustedclienttoken', getSecretString(context, 'trustedClientToken') ?? EDGE_TRUSTED_CLIENT_TOKEN)
    }
    const timeoutMs = getConfigNumber(context, 'voicesTimeoutMs') ?? 10000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok) throw new Error(`Edge voices request failed: ${response.status}`)
      const payload = await response.json() as EdgeVoicePayload[]
      if (!Array.isArray(payload)) throw new Error('Edge voices response was not an array.')
      const voices = payload
        .map(voice => normalizeEdgeVoice(voice, this.id))
        .filter((voice): voice is TtsVoice => !!voice)
        .sort((a, b) => a.locale === b.locale
          ? a.id.localeCompare(b.id)
          : (a.locale ?? '').localeCompare(b.locale ?? ''))
      return voices.length ? voices : FALLBACK_EDGE_VOICES
    } finally {
      clearTimeout(timer)
    }
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const tempDir = await mkdtemp(join(tmpdir(), 'rebook-edge-tts-'))
    const audioPath = join(tempDir, 'segment.mp3')
    try {
      const voice = request.segment.voice ?? request.voice ?? DEFAULT_VOICE
      const tts = new EdgeTTS({
        voice,
        lang: request.lang ?? inferLangFromVoice(voice),
        outputFormat: request.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
        saveSubtitles: false,
        pitch: request.segment.pitch ?? request.pitch ?? 'default',
        rate: request.segment.rate ?? request.rate ?? 'default',
        volume: request.segment.volume ?? request.volume ?? 'default',
        timeout: getConfigNumber(context, 'timeoutMs') ?? 30000,
        proxy: getConfigString(context, 'proxy'),
      })

      await tts.ttsPromise(request.segment.text, audioPath)
      const audio = await readFile(audioPath)
      return {
        audio,
        mimeType: 'audio/mpeg',
        durationMs: 0,
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  }
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
  const value = context.config?.[key]
  const numberValue = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined
}

const FALLBACK_EDGE_VOICES: TtsVoice[] = [
  { id: 'zh-CN-XiaoyiNeural', name: 'Xiaoyi', locale: 'zh-CN', gender: 'Female', provider: 'edge' },
  { id: 'zh-CN-YunxiNeural', name: 'Yunxi', locale: 'zh-CN', gender: 'Male', provider: 'edge' },
  { id: 'zh-CN-YunjianNeural', name: 'Yunjian', locale: 'zh-CN', gender: 'Male', provider: 'edge' },
  { id: 'zh-CN-XiaoxiaoNeural', name: 'Xiaoxiao', locale: 'zh-CN', gender: 'Female', provider: 'edge' },
  { id: 'en-US-AriaNeural', name: 'Aria', locale: 'en-US', gender: 'Female', provider: 'edge' },
  { id: 'en-US-GuyNeural', name: 'Guy', locale: 'en-US', gender: 'Male', provider: 'edge' },
]

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
