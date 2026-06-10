import type { SynthesizeRequest, TtsProvider, TtsVoice } from '../types.js'

const DEFAULT_BASE_URL = 'https://api.xiaomimimo.com/v1'
const DEFAULT_TTS_MODEL = 'mimo-v2.5-tts'
const DEFAULT_VOICE_DESIGN_MODEL = 'mimo-v2.5-tts-voicedesign'
const DEFAULT_VOICE_CLONE_MODEL = 'mimo-v2.5-tts-voiceclone'
const DEFAULT_VOICE = 'mimo_default'
const DEFAULT_FORMAT = 'wav'
const DEFAULT_VOICE_SAMPLE_TEXT = '你好，我会用这个声音为角色说话。'

interface MimoCompletionResponse {
  choices?: Array<{
    message?: {
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

export class MimoTtsProvider implements TtsProvider {
  readonly id = 'mimo'
  readonly name = 'Xiaomi MiMo TTS'
  readonly capabilities = { voiceDesign: true }
  private readonly designedVoiceSamples = new Map<string, Promise<string>>()

  async listVoices(): Promise<TtsVoice[]> {
    return MIMO_PRESET_VOICES.map(voice => ({
      ...voice,
      capabilities: this.capabilities,
    }))
  }

  async synthesize(request: SynthesizeRequest) {
    const apiKey = process.env.MIMO_API_KEY
    if (!apiKey) throw new Error('MIMO_API_KEY is required for the mimo TTS provider.')

    const text = request.segment.text.trim()
    const voicePrompt = normalizePrompt(request.segment.voicePrompt ?? request.voicePrompt)
    const stylePrompt = normalizePrompt(request.segment.stylePrompt ?? request.stylePrompt ?? request.segment.emotion)
    const format = normalizeAudioFormat(request.outputFormat ?? process.env.MIMO_TTS_FORMAT ?? DEFAULT_FORMAT)
    const voice = voicePrompt
      ? await this.getDesignedVoiceSample(apiKey, voicePrompt)
      : request.segment.voice ?? request.voice ?? DEFAULT_VOICE
    const body = {
      model: voicePrompt
        ? process.env.MIMO_VOICE_CLONE_MODEL ?? DEFAULT_VOICE_CLONE_MODEL
        : process.env.MIMO_TTS_MODEL ?? DEFAULT_TTS_MODEL,
      messages: buildMessages(text, undefined, stylePrompt),
      audio: {
        format,
        voice,
      },
    }
    const response = await postMimoCompletion(apiKey, body)
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

  private getDesignedVoiceSample(apiKey: string, voicePrompt: string): Promise<string> {
    const sampleText = normalizePrompt(process.env.MIMO_VOICE_SAMPLE_TEXT) ?? DEFAULT_VOICE_SAMPLE_TEXT
    const sampleKey = JSON.stringify({
      baseUrl: process.env.MIMO_BASE_URL ?? DEFAULT_BASE_URL,
      model: process.env.MIMO_VOICE_DESIGN_MODEL ?? DEFAULT_VOICE_DESIGN_MODEL,
      optimize: getBooleanEnv('MIMO_OPTIMIZE_TEXT_PREVIEW', true),
      voicePrompt,
      sampleText,
    })
    const cached = this.designedVoiceSamples.get(sampleKey)
    if (cached) return cached
    const promise = this.createDesignedVoiceSample(apiKey, voicePrompt, sampleText)
      .catch(error => {
        this.designedVoiceSamples.delete(sampleKey)
        throw error
      })
    this.designedVoiceSamples.set(sampleKey, promise)
    return promise
  }

  private async createDesignedVoiceSample(apiKey: string, voicePrompt: string, sampleText: string): Promise<string> {
    const response = await postMimoCompletion(apiKey, {
      model: process.env.MIMO_VOICE_DESIGN_MODEL ?? DEFAULT_VOICE_DESIGN_MODEL,
      messages: buildMessages(sampleText, voicePrompt),
      audio: {
        format: 'wav',
        optimize_text_preview: getBooleanEnv('MIMO_OPTIMIZE_TEXT_PREVIEW', true),
      },
    })
    const audioData = response.choices?.[0]?.message?.audio?.data
    if (!audioData) throw new Error('MiMo voice design response did not include audio data.')
    const base64 = stripDataUrlPrefix(audioData)
    const audio = Buffer.from(base64, 'base64')
    if (audio.length < 128) throw new Error('MiMo voice design response audio was empty.')
    return `data:audio/wav;base64,${base64}`
  }
}

const MIMO_PRESET_VOICES: TtsVoice[] = [
  { id: 'mimo_default', name: 'MiMo Default', locale: 'zh-CN', gender: 'Unknown', provider: 'mimo' },
  { id: '冰糖', name: '冰糖', locale: 'zh-CN', gender: 'Female', provider: 'mimo' },
  { id: '茉莉', name: '茉莉', locale: 'zh-CN', gender: 'Female', provider: 'mimo' },
  { id: '苏打', name: '苏打', locale: 'zh-CN', gender: 'Male', provider: 'mimo' },
  { id: '白桦', name: '白桦', locale: 'zh-CN', gender: 'Male', provider: 'mimo' },
  { id: 'Mia', name: 'Mia', locale: 'en-US', gender: 'Female', provider: 'mimo' },
  { id: 'Chloe', name: 'Chloe', locale: 'en-US', gender: 'Female', provider: 'mimo' },
  { id: 'Milo', name: 'Milo', locale: 'en-US', gender: 'Male', provider: 'mimo' },
  { id: 'Dean', name: 'Dean', locale: 'en-US', gender: 'Male', provider: 'mimo' },
]

function buildMessages(text: string, voicePrompt?: string, stylePrompt?: string) {
  const messages: Array<{ role: 'user' | 'assistant', content: string }> = []
  const userPrompt = [
    voicePrompt,
    stylePrompt && voicePrompt ? `Performance style: ${stylePrompt}` : stylePrompt,
  ].filter(Boolean).join('\n')
  if (userPrompt) messages.push({ role: 'user', content: userPrompt })
  messages.push({ role: 'assistant', content: text })
  return messages
}

async function postMimoCompletion(apiKey: string, body: unknown): Promise<MimoCompletionResponse> {
  const baseUrl = trimTrailingSlash(process.env.MIMO_BASE_URL ?? DEFAULT_BASE_URL)
  const url = `${baseUrl}/chat/completions`
  const timeoutMs = getTimeoutMs()
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
      const message = (payload.error?.message ?? text.slice(0, 500)) || `MiMo TTS request failed: ${response.status}`
      throw new Error(message)
    }
    return payload
  } finally {
    clearTimeout(timer)
  }
}

function normalizePrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function normalizeAudioFormat(value: string): 'mp3' | 'wav' {
  const normalized = value.toLowerCase()
  if (normalized.includes('mp3')) return 'mp3'
  return 'wav'
}

function getMimeType(format: 'mp3' | 'wav'): string {
  return format === 'mp3' ? 'audio/mpeg' : 'audio/wav'
}

function stripDataUrlPrefix(value: string): string {
  const comma = value.indexOf(',')
  return value.startsWith('data:') && comma >= 0 ? value.slice(comma + 1) : value
}

function getBooleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name]
  if (value == null) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}

function getTimeoutMs(): number {
  const value = Number(process.env.MIMO_TTS_TIMEOUT_MS ?? process.env.TTS_SYNTHESIS_TIMEOUT_MS ?? 45000)
  return Number.isFinite(value) && value > 0 ? value : 45000
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
