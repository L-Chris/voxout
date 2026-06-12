import type {
  AudioIsolationProvider,
  AudioIsolationRequest,
  SoundEffectProvider,
  SoundEffectRequest,
  SynthesizeRequest,
  TtsProvider,
  TtsVoice,
  VoiceDesignProvider,
  VoiceDesignRequest,
  VoiceDesignResult,
} from '../types.js'

const SAMPLE_RATE = 24_000

export class MockTtsProvider implements TtsProvider, SoundEffectProvider, AudioIsolationProvider, VoiceDesignProvider {
  readonly id = 'mock'
  readonly name = 'Mock WAV Provider'
  readonly capabilities = { tts: true, soundEffects: true, isolation: true, voiceDesign: true }

  async listVoices(): Promise<TtsVoice[]> {
    return [
      { id: 'mock-narrator', name: 'Mock Narrator', locale: 'zh-CN', provider: this.id },
      { id: 'mock-dialogue', name: 'Mock Dialogue', locale: 'zh-CN', provider: this.id },
    ]
  }

  async synthesize(request: SynthesizeRequest) {
    const text = request.segment.text.trim()
    const durationMs = Math.min(5000, Math.max(700, text.length * 80))
    const audio = createToneWav(durationMs, getFrequency(request.segment.voice ?? request.voice))
    return { audio, mimeType: 'audio/wav', durationMs }
  }

  async createSoundEffect(request: SoundEffectRequest) {
    const durationMs = Math.min(30_000, Math.max(500, Math.round((request.durationSeconds ?? 1) * 1000)))
    const audio = createToneWav(durationMs, getFrequency(request.prompt))
    return { audio, mimeType: 'audio/wav', durationMs }
  }

  async isolateAudio(request: AudioIsolationRequest) {
    const base64 = request.audioData.includes(',') ? request.audioData.split(',').pop() ?? '' : request.audioData
    return { audio: Buffer.from(base64, 'base64'), mimeType: request.mimeType ?? 'audio/wav', durationMs: 0 }
  }

  async designVoice(request: VoiceDesignRequest): Promise<VoiceDesignResult> {
    const voiceId = `mock-${getFrequency(request.voiceDescription)}`
    const audio = createToneWav(700, getFrequency(request.voiceDescription)).toString('base64')
    return {
      provider: this.id,
      text: request.text ?? 'mock voice preview',
      voices: [{
        voiceId,
        name: request.name ?? 'Mock Designed Voice',
        description: request.voiceDescription,
        previewAudioData: `data:audio/wav;base64,${audio}`,
        previewMimeType: 'audio/wav',
        metadata: {},
      }],
    }
  }
}

function getFrequency(seed = 'mock-narrator'): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return 320 + (hash % 220)
}

function createToneWav(durationMs: number, frequency: number): Buffer {
  const sampleCount = Math.floor(SAMPLE_RATE * durationMs / 1000)
  const dataSize = sampleCount * 2
  const buffer = Buffer.alloc(44 + dataSize)

  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(SAMPLE_RATE, 24)
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < sampleCount; i++) {
    const fade = Math.min(1, i / 600, (sampleCount - i) / 600)
    const value = Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE) * 0.25 * fade
    buffer.writeInt16LE(Math.floor(value * 32767), 44 + i * 2)
  }

  return buffer
}
