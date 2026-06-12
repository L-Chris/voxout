import type { ProviderContext, SynthesizeRequest, TtsProvider, TtsVoice } from '../types.js'

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1'
const DEFAULT_MODEL = 'eleven_text_to_sound_v2'
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128'

export class ElevenLabsSoundEffectProvider implements TtsProvider {
  readonly id = 'elevenlabs'
  readonly name = 'ElevenLabs Sound Effects'
  readonly capabilities = { tts: true, soundEffects: true }
  readonly fields = [
    { key: 'apiKey', label: 'API Key', type: 'password' as const, secret: true },
    { key: 'baseUrl', label: 'Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
    { key: 'model', label: 'Model', type: 'text' as const, placeholder: DEFAULT_MODEL },
    { key: 'outputFormat', label: 'Output Format', type: 'text' as const, placeholder: DEFAULT_OUTPUT_FORMAT },
    { key: 'promptInfluence', label: 'Prompt Influence', type: 'number' as const, placeholder: '0.3' },
  ]

  async listVoices(): Promise<TtsVoice[]> {
    return [{
      id: 'elevenlabs-sound-effects',
      name: 'ElevenLabs Sound Effects',
      locale: 'und',
      provider: this.id,
      capabilities: this.capabilities,
    }]
  }

  async synthesize(request: SynthesizeRequest, context: ProviderContext = {}) {
    const apiKey = getSecretString(context, 'apiKey')
    if (!apiKey) throw new Error('elevenlabs apiKey is required in provider settings.')

    const text = (request.segment.soundEffectPrompt ?? request.segment.text).trim()
    const outputFormat = getConfigString(context, 'outputFormat') ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)}/sound-generation`)
    if (outputFormat) url.searchParams.set('output_format', outputFormat)

    const body = compactObject({
      text,
      model_id: getConfigString(context, 'model') ?? DEFAULT_MODEL,
      duration_seconds: normalizeDurationSeconds(request.segment.soundEffectDurationSeconds)
        ?? normalizeDurationSeconds(getConfigNumber(context, 'durationSeconds')),
      prompt_influence: getConfigNumber(context, 'promptInfluence'),
      loop: getConfigBoolean(context, 'loop'),
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'xi-api-key': apiKey,
      },
      body: JSON.stringify(body),
    })
    const arrayBuffer = await response.arrayBuffer()
    const audio = Buffer.from(arrayBuffer)
    if (!response.ok) {
      const detail = audio.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 500)
      throw new Error(detail || `ElevenLabs sound effect request failed: ${response.status}`)
    }
    if (audio.length < 128) throw new Error('ElevenLabs sound effect response audio was empty.')
    return {
      audio,
      mimeType: response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg',
      durationMs: 0,
    }
  }
}

function compactObject<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== '')) as Partial<T>
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
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
  const raw = context.config?.[key]
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function normalizeDurationSeconds(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(0.5, Math.min(30, Number(value.toFixed(2))))
}

function getConfigBoolean(context: ProviderContext, key: string): boolean | undefined {
  const value = context.config?.[key]
  if (typeof value === 'boolean') return value
  return undefined
}
