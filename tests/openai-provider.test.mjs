import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { OpenAiProvider } from '../dist/providers/openai.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('OpenAI provider sends text-to-speech requests', async () => {
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

  const provider = new OpenAiProvider()
  const result = await provider.synthesize({
    voiceId: 'voice_custom_1',
    outputFormat: 'mp3',
    segment: {
      id: 'tts',
      text: 'Hello from OpenAI.',
    },
  }, {
    config: { ttsModel: 'gpt-4o-mini-tts' },
    secrets: { apiKey: 'test-openai-key' },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mimeType, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.deepEqual(captured.body, {
    model: 'gpt-4o-mini-tts',
    input: 'Hello from OpenAI.',
    voice: 'voice_custom_1',
    response_format: 'mp3',
  })
})

test('OpenAI provider streams text-to-speech requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response('data: {"type":"audio.delta"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new OpenAiProvider()
  const result = await provider.streamSynthesize({
    outputFormat: 'mp3',
    streamFormat: 'sse',
    segment: {
      id: 'tts',
      text: 'Hello from OpenAI.',
    },
  }, {
    config: { ttsModel: 'gpt-4o-mini-tts' },
    secrets: { apiKey: 'test-openai-key' },
  })

  assert.equal(result.mimeType, 'text/event-stream')
  assert.equal(await readStreamText(result.stream), 'data: {"type":"audio.delta"}\n\n')
  assert.equal(captured.url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.deepEqual(captured.body, {
    model: 'gpt-4o-mini-tts',
    input: 'Hello from OpenAI.',
    voice: 'alloy',
    response_format: 'mp3',
    stream_format: 'sse',
  })
})

test('OpenAI provider sends voice clone requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      name: init.body.get('name'),
      consent: init.body.get('consent'),
      audioSample: init.body.get('audio_sample'),
    }
    return new Response(JSON.stringify({
      id: 'voice_openai_1',
      object: 'audio.voice',
      created_at: 1781220000,
      name: 'Narrator',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new OpenAiProvider()
  const result = await provider.cloneVoice({
    name: 'Narrator',
    consent: 'cons_1234',
    audioData: `data:audio/wav;base64,${Buffer.alloc(256, 1).toString('base64')}`,
    mimeType: 'audio/wav',
  }, {
    config: {},
    secrets: { apiKey: 'test-openai-key' },
  })

  assert.equal(captured.url, 'https://api.openai.com/v1/audio/voices')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.equal(captured.name, 'Narrator')
  assert.equal(captured.consent, 'cons_1234')
  assert.equal(captured.audioSample.type, 'audio/wav')
  assert.equal(result.voice.voiceId, 'voice_openai_1')
  assert.equal(result.voice.providerVoiceId, 'voice_openai_1')
})

test('OpenAI provider sends speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      model: init.body.get('model'),
      responseFormat: init.body.get('response_format'),
      language: init.body.get('language'),
      file: init.body.get('file'),
    }
    return new Response(JSON.stringify({
      text: 'Recognized by OpenAI',
      segments: [{ start: 0, end: 0.8, text: 'Recognized by OpenAI' }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new OpenAiProvider()
  const result = await provider.transcribe({
    model: 'whisper-1',
    audioData: `data:audio/wav;base64,${Buffer.alloc(256, 1).toString('base64')}`,
    mimeType: 'audio/wav',
    language: 'en',
    format: 'raw',
  }, {
    config: { asrModel: 'gpt-4o-transcribe' },
    secrets: { apiKey: 'test-openai-key' },
  })

  assert.equal(captured.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.equal(captured.model, 'whisper-1')
  assert.equal(captured.responseFormat, 'json')
  assert.equal(captured.language, 'en')
  assert.equal(captured.file.type, 'audio/wav')
  assert.equal(result.text, 'Recognized by OpenAI')
  assert.equal(result.raw.text, 'Recognized by OpenAI')
  assert.deepEqual(result.segments, [{ from: 0, to: 0.8, content: 'Recognized by OpenAI' }])
})

test('OpenAI provider exposes TTS, ASR, and voice clone metadata', async () => {
  const provider = new OpenAiProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.voiceClone, true)
  assert.ok(voices.some(voice => voice.id === 'alloy'))
  assert.equal(voices.find(voice => voice.id === 'marin').gender, 'Female')
  assert.equal(voices.find(voice => voice.id === 'cedar').gender, 'Male')

  const providers = listProviderDefinitions()
  const openai = providers.find(item => item.id === 'openai')
  assert.equal(openai.name, 'OpenAI')
  assert.equal(openai.capabilities.tts, true)
  assert.equal(openai.capabilities.asr, true)
  assert.equal(openai.capabilities.voiceClone, true)
  assert.ok(openai.fields.find(field => field.key === 'ttsModel').options.includes('gpt-4o-mini-tts'))
  assert.ok(openai.fields.find(field => field.key === 'asrModel').options.includes('gpt-4o-transcribe'))
})

async function readStreamText(stream) {
  const reader = stream.getReader()
  const chunks = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(Buffer.from(value))
  }
  return Buffer.concat(chunks).toString('utf8')
}
