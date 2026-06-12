import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { ElevenLabsSoundEffectProvider } from '../dist/providers/elevenlabs.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
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

  const provider = new ElevenLabsSoundEffectProvider()
  const result = await provider.synthesize({
    segment: {
      id: 'sfx',
      text: '汪！',
      soundEffectPrompt: 'a short dog bark in a quiet street',
      soundEffectDurationSeconds: 0.8,
    },
  }, {
    config: {
      durationSeconds: 1.5,
      promptInfluence: 0.75,
      loop: false,
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

test('ElevenLabs provider exposes sound effect capability metadata', async () => {
  const provider = new ElevenLabsSoundEffectProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.soundEffects, true)
  assert.equal(voices[0].capabilities.soundEffects, true)

  const providers = listProviderDefinitions()
  const elevenlabs = providers.find(item => item.id === 'elevenlabs')
  assert.equal(elevenlabs.capabilities.soundEffects, true)
})
