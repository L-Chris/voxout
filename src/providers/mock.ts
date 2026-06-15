import type {
  AsrProvider,
  AudioIsolationProvider,
  AudioIsolationRequest,
  SoundEffectProvider,
  SoundEffectRequest,
  SynthesizeRequest,
  TranscribeRequest,
  TtsProvider,
  TtsVoice,
  VoiceCloneProvider,
  VoiceCloneRequest,
  VoiceCloneResult,
  VoiceDesignProvider,
  VoiceDesignRequest,
  VoiceDesignResult,
} from '../types.js'

const SAMPLE_RATE = 24_000

export class MockTtsProvider implements TtsProvider, SoundEffectProvider, AudioIsolationProvider, VoiceDesignProvider, VoiceCloneProvider {
  readonly id = 'mock'
  readonly name = 'Mock WAV Provider'
  readonly capabilities = { tts: true, tts_streaming: true, sound_effects: true, isolation: true, voice_design: true, voice_clone: true }

  async listVoices(): Promise<TtsVoice[]> {
    return [
      { id: 'mock-narrator', name: 'Mock Narrator', locale: 'zh-CN', provider: this.id },
      { id: 'mock-dialogue', name: 'Mock Dialogue', locale: 'zh-CN', provider: this.id },
    ]
  }

  async synthesize(request: SynthesizeRequest) {
    const text = request.text.trim()
    const duration_ms = Math.min(5000, Math.max(700, text.length * 80))
    const audio = createToneWav(duration_ms, getFrequency(request.voice))
    return { audio, mime_type: 'audio/wav', duration_ms }
  }

  async streamSynthesize(request: SynthesizeRequest) {
    const result = await this.synthesize(request)
    if (request.stream_format === 'sse') {
      const payload = {
        type: 'audio.delta',
        audio: result.audio.toString('base64'),
      }
      return {
        stream: createStreamFromBuffer(Buffer.from(`data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`)),
        mime_type: 'text/event-stream',
      }
    }
    return {
      stream: createStreamFromBuffer(result.audio),
      mime_type: result.mime_type,
    }
  }

  async createSoundEffect(request: SoundEffectRequest) {
    const duration_ms = Math.min(30_000, Math.max(500, Math.round((request.duration_seconds ?? 1) * 1000)))
    const audio = createToneWav(duration_ms, getFrequency(request.prompt))
    return { audio, mime_type: 'audio/wav', duration_ms }
  }

  async isolateAudio(request: AudioIsolationRequest) {
    return { audio: request.file.data, mime_type: request.file.mime_type, duration_ms: 0 }
  }

  async designVoice(request: VoiceDesignRequest): Promise<VoiceDesignResult> {
    const voice_id = `mock-${getFrequency(request.input)}`
    const audio = createToneWav(700, getFrequency(request.input)).toString('base64')
    return {
      provider: this.id,
      text: request.text ?? 'mock voice preview',
      voices: [{
        voice_id,
        name: request.name ?? 'Mock Designed Voice',
        description: request.input,
        preview_audio_data: `data:audio/wav;base64,${audio}`,
        preview_mime_type: 'audio/wav',
        metadata: {},
      }],
    }
  }

  async cloneVoice(request: VoiceCloneRequest): Promise<VoiceCloneResult> {
    const voice_id = `mock-clone-${getFrequency(request.name)}`
    const audio_data = request.audio_sample.data.toString('base64')
    return {
      provider: this.id,
      voice: {
        voice_id,
        provider_voice_id: voice_id,
        name: request.name,
        preview_audio_data: `data:${request.audio_sample.mime_type};base64,${audio_data}`,
        preview_mime_type: request.audio_sample.mime_type,
        metadata: {},
      },
    }
  }
}

export class MockAsrProvider implements AsrProvider {
  readonly id = 'mock-asr'
  readonly name = 'Mock ASR Provider'
  readonly capabilities = { asr: true }

  async transcribe(request: TranscribeRequest) {
    const target = request.file ? 'inline audio' : 'unknown audio'
    const text = `Mock transcript for ${target}`
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      segments: request.format === 'raw' || request.format === 'srt' || request.format === 'vtt'
        ? [{ from: 0, to: 1.25, content: text }]
        : undefined,
      raw: request.format === 'raw' ? { text } : undefined,
    }
  }
}

function getFrequency(seed = 'mock-narrator'): number {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return 320 + (hash % 220)
}

function createToneWav(duration_ms: number, frequency: number): Buffer {
  const sampleCount = Math.floor(SAMPLE_RATE * duration_ms / 1000)
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

function createStreamFromBuffer(buffer: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer)
      controller.close()
    },
  })
}
