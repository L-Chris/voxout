import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ElevenLabsProvider } from '../dist/providers/elevenlabs.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('ElevenLabs provider sends text-to-speech requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(Buffer.alloc(256, 1), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.synthesize({
    voice: 'voice-123',
    output_format: 'mp3_44100_192',
    speed: 1.15,
    extra_params: {
      model_id: 'extra-model-should-not-win',
      voice_settings: {
        speed: 0.7,
        stability: 0.4,
      },
      seed: 123,
    },
    id: 'tts',
    text: 'Hello from ElevenLabs.',
  }, {
    config: {
      tts_model: 'eleven_multilingual_v2',
    },
    secrets: {
      api_key: 'test-eleven-key',
    },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-123?output_format=mp3_44100_192')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.deepEqual(captured.body, {
    text: 'Hello from ElevenLabs.',
    model_id: 'eleven_multilingual_v2',
    voice_settings: { speed: 1.15, stability: 0.4 },
    seed: 123,
  })
})

test('ElevenLabs provider streams text-to-speech requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(Buffer.alloc(256, 1), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.streamSynthesize({
    voice: 'voice-123',
    output_format: 'mp3_44100_192',
    stream_format: 'audio',
    speed: 2,
    id: 'tts',
    text: 'Hello from ElevenLabs.',
  }, {
    config: {
      tts_model: 'eleven_multilingual_v2',
    },
    secrets: {
      api_key: 'test-eleven-key',
    },
  })

  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal((await readStreamBuffer(result.stream)).length, 256)
  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-123/stream?output_format=mp3_44100_192')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.deepEqual(captured.body, {
    text: 'Hello from ElevenLabs.',
    model_id: 'eleven_multilingual_v2',
    voice_settings: { speed: 1.2 },
  })
})

test('ElevenLabs provider sends speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      model_id: init.body.get('model_id'),
      file: init.body.get('file'),
      language_code: init.body.get('language_code'),
    }
    return new Response(JSON.stringify({
      text: 'Recognized text',
      words: [{ text: 'Recognized', start: 0, end: 0.5 }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.transcribe({
    model: 'scribe_v1',
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'en',
    format: 'raw',
  }, {
    config: {
      asr_model: 'scribe_v2',
    },
    secrets: {
      api_key: 'test-eleven-key',
    },
  })

  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/speech-to-text')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.equal(captured.model_id, 'scribe_v1')
  assert.equal(captured.file.type, 'audio/wav')
  assert.equal(captured.language_code, 'en')
  assert.equal(result.text, 'Recognized text')
  assert.equal(result.raw.text, 'Recognized text')
})

test('ElevenLabs provider sends sound effect generation requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(Buffer.alloc(256, 1), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.createSoundEffect({
    prompt: 'a short dog bark in a quiet street',
    duration_seconds: 0.8,
    prompt_influence: 0.75,
    loop: false,
  }, {
    config: {
      duration_seconds: 1.5,
      prompt_influence: 0.3,
    },
    secrets: {
      api_key: 'test-eleven-key',
    },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.deepEqual(captured.body, {
    text: 'a short dog bark in a quiet street',
    model_id: 'eleven_text_to_sound_v2',
    duration_seconds: 0.8,
    prompt_influence: 0.75,
    loop: false,
  })
})

test('ElevenLabs provider sends audio isolation requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      file_format: init.body.get('file_format'),
      file: init.body.get('audio'),
    }
    return new Response(Buffer.alloc(256, 1), {
      status: 200,
      headers: { 'content-type': 'audio/mpeg' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.isolateAudio({
    file: {
      data: Buffer.from('audio'),
      mime_type: 'audio/wav',
      file_name: 'input.wav',
    },
  }, {
    config: {},
    secrets: { api_key: 'test-eleven-key' },
  })

  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/audio-isolation')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.equal(captured.file_format, 'other')
  assert.equal(captured.file.type, 'audio/wav')
  assert.equal(result.mime_type, 'audio/mpeg')
})

test('ElevenLabs provider sends voice design requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(JSON.stringify({
      text: 'Preview text',
      previews: [{
        audio_base_64: Buffer.alloc(256, 1).toString('base64'),
        generated_voice_id: 'generated-voice-1',
        media_type: 'audio/mpeg',
        duration_secs: 1.2,
        language: 'en',
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.designVoice({
    input: 'A warm expressive narrator voice.',
    name: 'Warm Narrator',
    text: 'This is a preview text for the generated voice.',
    output_format: 'mp3_44100_128',
    extra_params: {
      auto_generate_text: true,
      guidance_scale: 5,
    },
  }, {
    config: {},
    secrets: { api_key: 'test-eleven-key' },
  })

  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/text-to-voice/design?output_format=mp3_44100_128')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.deepEqual(captured.body, {
    voice_description: 'A warm expressive narrator voice.',
    model_id: 'eleven_multilingual_ttv_v2',
    text: 'This is a preview text for the generated voice.',
    auto_generate_text: true,
    guidance_scale: 5,
  })
  assert.equal(result.voices[0].voice_id, 'generated-voice-1')
  assert.equal(result.voices[0].provider_voice_id, 'generated-voice-1')
  assert.match(result.voices[0].preview_audio_data, /^data:audio\/mpeg;base64,/)
})

test('ElevenLabs provider sends voice clone requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      name: init.body.get('name'),
      description: init.body.get('description'),
      file: init.body.get('files[]'),
    }
    return new Response(JSON.stringify({
      voice_id: 'eleven-clone-1',
      requires_verification: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new ElevenLabsProvider()
  const result = await provider.cloneVoice({
    name: 'Narrator Clone',
    description: 'A clean narrator sample.',
    audio_sample: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'voice.wav',
    },
  }, {
    config: {},
    secrets: { api_key: 'test-eleven-key' },
  })

  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/voices/add')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.equal(captured.name, 'Narrator Clone')
  assert.equal(captured.description, 'A clean narrator sample.')
  assert.equal(captured.file.type, 'audio/wav')
  assert.equal(result.voice.voice_id, 'eleven-clone-1')
  assert.equal(result.voice.provider_voice_id, 'eleven-clone-1')
})

test('ElevenLabs provider exposes TTS, ASR, and sound effect metadata', async () => {
  const provider = new ElevenLabsProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.sound_effects, true)
  assert.equal(provider.capabilities.isolation, true)
  assert.equal(provider.capabilities.voice_design, true)
  assert.equal(provider.capabilities.voice_clone, true)
  assert.equal(voices[0].provider, 'elevenlabs')

  const providers = listProviderDefinitions()
  const elevenlabs = providers.find(item => item.id === 'elevenlabs')
  assert.equal(elevenlabs.name, 'ElevenLabs')
  assert.equal(elevenlabs.capabilities.tts, true)
  assert.equal(elevenlabs.capabilities.asr, true)
  assert.equal(elevenlabs.capabilities.sound_effects, true)
  assert.equal(elevenlabs.capabilities.voice_clone, true)
})

async function readStreamBuffer(stream) {
  const reader = stream.getReader()
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks)
}
