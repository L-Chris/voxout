import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { CartesiaProvider } from '../dist/providers/cartesia.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Cartesia provider sends text-to-speech requests', async () => {
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

  const provider = new CartesiaProvider()
  const result = await provider.synthesize({
    voice: 'cartesia-voice-1',
    output_format: 'mp3',
    lang: 'en-US',
    speed: 1.1,
    extra_params: {
      model_id: 'extra-model-should-not-win',
      output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 16000 },
      generation_config: {
        speed: 0.5,
        emotion: 'positivity',
      },
      experimental_control: true,
    },
    id: 'tts',
    text: 'Hello from Cartesia.',
  }, {
    config: { tts_model: 'sonic-3.5' },
    secrets: { api_key: 'test-cartesia-key' },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.cartesia.ai/tts/bytes')
  assert.equal(captured.headers.authorization, 'Bearer test-cartesia-key')
  assert.equal(captured.headers['Cartesia-Version'], '2026-03-01')
  assert.deepEqual(captured.body, {
    model_id: 'sonic-3.5',
    transcript: 'Hello from Cartesia.',
    voice: { mode: 'id', id: 'cartesia-voice-1' },
    output_format: { container: 'mp3', encoding: 'pcm_s16le', bit_rate: 128000, sample_rate: 44100 },
    language: 'en',
    generation_config: { speed: 1.1, emotion: 'positivity' },
    experimental_control: true,
  })
})

test('Cartesia provider decodes SSE text-to-speech audio streams', async () => {
  const audioChunk = Buffer.alloc(256, 2)
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(`data: ${JSON.stringify({ type: 'chunk', data: audioChunk.toString('base64') })}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new CartesiaProvider()
  const result = await provider.streamSynthesize({
    output_format: 'wav',
    stream_format: 'audio',
    id: 'tts-stream',
    text: 'Stream from Cartesia.',
  }, {
    config: {},
    secrets: { api_key: 'test-cartesia-key' },
  })

  const streamedAudio = await readStreamBuffer(result.stream)
  assert.equal(result.mime_type, 'audio/wav')
  assert.equal(streamedAudio.length, 256)
  assert.equal(streamedAudio[0], 2)
  assert.equal(captured.url, 'https://api.cartesia.ai/tts/sse')
  assert.deepEqual(captured.body.output_format, { container: 'wav', encoding: 'pcm_s16le', sample_rate: 44100 })
})

test('Cartesia provider sends speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      model: init.body.get('model'),
      language: init.body.get('language'),
      granularity: init.body.get('timestamp_granularities[]'),
      file: init.body.get('file'),
    }
    return new Response(JSON.stringify({
      text: 'Recognized by Cartesia',
      words: [{ word: 'Recognized', start: 0, end: 0.5 }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new CartesiaProvider()
  const result = await provider.transcribe({
    model: 'ink-whisper',
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'en-US',
    format: 'raw',
  }, {
    config: {},
    secrets: { api_key: 'test-cartesia-key' },
  })

  assert.equal(captured.url, 'https://api.cartesia.ai/stt')
  assert.equal(captured.headers.authorization, 'Bearer test-cartesia-key')
  assert.equal(captured.model, 'ink-whisper')
  assert.equal(captured.language, 'en')
  assert.equal(captured.granularity, 'word')
  assert.equal(captured.file.type, 'audio/wav')
  assert.equal(result.text, 'Recognized by Cartesia')
  assert.deepEqual(result.segments, [{ from: 0, to: 0.5, content: 'Recognized' }])
  assert.equal(result.raw.text, 'Recognized by Cartesia')
})

test('Cartesia provider sends voice clone requests and lists voices', async () => {
  const captures = []
  globalThis.fetch = async (url, init) => {
    captures.push({ url: String(url), headers: init.headers, init })
    if (String(url).includes('/voices/clone')) {
      return new Response(JSON.stringify({
        id: 'cartesia-clone-1',
        name: 'Narrator',
        description: 'Calm narrator',
        language: 'en',
        created_at: '2026-06-12T00:00:00Z',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const requestUrl = new URL(String(url))
    const isSecondPage = requestUrl.searchParams.get('starting_after') === 'cartesia-page-2'
    return new Response(JSON.stringify(isSecondPage ? {
      data: [{
        id: 'cartesia-voice-zh',
        name: 'Chinese Narrator',
        language: 'zh',
        country: 'CN',
        gender: 'feminine',
      }],
      has_more: false,
      next_page: null,
    } : {
      data: [{
        id: 'cartesia-voice-2',
        name: 'Skylar',
        language: 'en',
        country: 'US',
        gender: 'feminine',
      }],
      has_more: true,
      next_page: 'cartesia-page-2',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new CartesiaProvider()
  const clone = await provider.cloneVoice({
    name: 'Narrator',
    description: 'Calm narrator',
    language: 'en-US',
    audio_sample: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'voice.wav',
    },
    extra_params: {
      base_voice_id: 'extra-base-should-not-win',
      tags: ['narration', 'calm'],
    },
  }, {
    config: { base_voice_id: 'config-base' },
    secrets: { api_key: 'test-cartesia-key' },
  })
  const voices = await provider.listVoices({
    config: {},
    secrets: { api_key: 'test-cartesia-key' },
  })

  const cloneCapture = captures[0]
  assert.equal(cloneCapture.url, 'https://api.cartesia.ai/voices/clone')
  assert.equal(cloneCapture.init.body.get('name'), 'Narrator')
  assert.equal(cloneCapture.init.body.get('language'), 'en')
  assert.equal(cloneCapture.init.body.get('clip').type, 'audio/wav')
  assert.equal(cloneCapture.init.body.get('base_voice_id'), 'config-base')
  assert.deepEqual(cloneCapture.init.body.getAll('tags[]'), ['narration', 'calm'])
  assert.equal(clone.voice.voice_id, 'cartesia-clone-1')
  assert.equal(clone.voice.provider_voice_id, 'cartesia-clone-1')
  assert.equal(captures[1].url, 'https://api.cartesia.ai/voices?limit=100')
  assert.equal(captures[2].url, 'https://api.cartesia.ai/voices?limit=100&starting_after=cartesia-page-2')
  assert.deepEqual(voices[0], {
    id: 'cartesia-voice-2',
    name: 'Skylar',
    locale: 'en-US',
    gender: 'feminine',
    provider: 'cartesia',
  })
  assert.deepEqual(voices[1], {
    id: 'cartesia-voice-zh',
    name: 'Chinese Narrator',
    locale: 'zh-CN',
    gender: 'feminine',
    provider: 'cartesia',
  })
})

test('Cartesia provider exposes metadata', async () => {
  const providers = listProviderDefinitions()
  const cartesia = providers.find(item => item.id === 'cartesia')
  assert.equal(cartesia.name, 'Cartesia')
  assert.equal(cartesia.capabilities.tts, true)
  assert.equal(cartesia.capabilities.tts_streaming, true)
  assert.equal(cartesia.capabilities.asr, true)
  assert.equal(cartesia.capabilities.voice_clone, true)
  assert.ok(cartesia.fields.find(field => field.key === 'tts_model').options.includes('sonic-3.5'))
  assert.ok(cartesia.fields.find(field => field.key === 'asr_model').options.includes('ink-whisper'))
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
