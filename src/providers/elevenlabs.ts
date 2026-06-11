import type { SynthesizeRequest, TtsProvider, TtsVoice } from '../types.js'

const DEFAULT_BASE_URL = 'https://api.elevenlabs.io/v1'
const DEFAULT_MODEL = 'eleven_text_to_sound_v2'
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128'

export class ElevenLabsSoundEffectProvider implements TtsProvider {
  readonly id = 'elevenlabs'
  readonly name = 'ElevenLabs Sound Effects'
  readonly capabilities = { soundEffects: true }

  async listVoices(): Promise<TtsVoice[]> {
    return [{
      id: 'elevenlabs-sound-effects',
      name: 'ElevenLabs Sound Effects',
      locale: 'und',
      provider: this.id,
      capabilities: this.capabilities,
    }]
  }

  async synthesize(request: SynthesizeRequest) {
    const apiKey = process.env.ELEVENLABS_API_KEY
    if (!apiKey) throw new Error('ELEVENLABS_API_KEY is required for the elevenlabs sound effect provider.')

    const text = (request.segment.soundEffectPrompt ?? request.segment.text).trim()
    const outputFormat = process.env.ELEVENLABS_SOUND_EFFECT_OUTPUT_FORMAT ?? DEFAULT_OUTPUT_FORMAT
    const url = new URL(`${trimTrailingSlash(process.env.ELEVENLABS_BASE_URL ?? DEFAULT_BASE_URL)}/sound-generation`)
    if (outputFormat) url.searchParams.set('output_format', outputFormat)

    const body = compactObject({
      text,
      model_id: process.env.ELEVENLABS_SOUND_EFFECT_MODEL ?? DEFAULT_MODEL,
      duration_seconds: normalizeDurationSeconds(request.segment.soundEffectDurationSeconds)
        ?? normalizeDurationSeconds(getNumberEnv('ELEVENLABS_SOUND_EFFECT_DURATION_SECONDS')),
      prompt_influence: getNumberEnv('ELEVENLABS_SOUND_EFFECT_PROMPT_INFLUENCE'),
      loop: getBooleanEnv('ELEVENLABS_SOUND_EFFECT_LOOP'),
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

function getNumberEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

function normalizeDurationSeconds(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(0.5, Math.min(30, Number(value.toFixed(2))))
}

function getBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase()
  if (!raw) return undefined
  if (raw === '1' || raw === 'true' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return undefined
}
