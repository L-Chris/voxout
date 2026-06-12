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
    outputFormat: 'mp3_44100_192',
    segment: {
      id: 'tts',
      text: 'Hello from ElevenLabs.',
    },
  }, {
    config: {
      ttsModel: 'eleven_multilingual_v2',
    },
    secrets: {
      apiKey: 'test-eleven-key',
    },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/text-to-speech/voice-123?output_format=mp3_44100_192')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.deepEqual(captured.body, {
    text: 'Hello from ElevenLabs.',
    model_id: 'eleven_multilingual_v2',
  })
})

test('ElevenLabs provider sends speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      modelId: init.body.get('model_id'),
      sourceUrl: init.body.get('source_url'),
      languageCode: init.body.get('language_code'),
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
    url: 'https://example.com/audio.mp3',
    language: 'en',
    format: 'raw',
  }, {
    config: {
      asrModel: 'scribe_v2',
    },
    secrets: {
      apiKey: 'test-eleven-key',
    },
  })

  assert.equal(captured.url, 'https://api.elevenlabs.io/v1/speech-to-text')
  assert.equal(captured.headers['xi-api-key'], 'test-eleven-key')
  assert.equal(captured.modelId, 'scribe_v2')
  assert.equal(captured.sourceUrl, 'https://example.com/audio.mp3')
  assert.equal(captured.languageCode, 'en')
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
    durationSeconds: 0.8,
    promptInfluence: 0.75,
    loop: false,
  }, {
    config: {
      durationSeconds: 1.5,
      promptInfluence: 0.3,
    },
    secrets: {
      apiKey: 'test-eleven-key',
    },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mimeType, 'audio/mpeg')
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

test('ElevenLabs provider exposes TTS, ASR, and sound effect metadata', async () => {
  const provider = new ElevenLabsProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.soundEffects, true)
  assert.equal(voices[0].provider, 'elevenlabs')

  const providers = listProviderDefinitions()
  const elevenlabs = providers.find(item => item.id === 'elevenlabs')
  assert.equal(elevenlabs.name, 'ElevenLabs')
  assert.equal(elevenlabs.capabilities.tts, true)
  assert.equal(elevenlabs.capabilities.asr, true)
  assert.equal(elevenlabs.capabilities.soundEffects, true)
})
