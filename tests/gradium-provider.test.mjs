import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { WebSocketServer } from 'ws'
import { GradiumProvider } from '../dist/providers/gradium.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Gradium provider sends text-to-speech requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(Buffer.alloc(256, 1), {
      status: 200,
      headers: { 'content-type': 'audio/wav' },
    })
  }

  const provider = new GradiumProvider()
  const result = await provider.synthesize({
    voice: 'gradium-voice-1',
    output_format: 'pcm_16000',
    extra_params: {
      model_name: 'extra-model-should-not-win',
      output_format: 'ulaw_8000',
      only_audio: false,
      continuation: 'preserve',
    },
    id: 'tts',
    text: 'Hello from Gradium.',
  }, {
    config: {},
    secrets: { api_key: 'test-gradium-key' },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/wav')
  assert.equal(captured.url, 'https://api.gradium.ai/api/post/speech/tts')
  assert.equal(captured.headers['x-api-key'], 'test-gradium-key')
  assert.deepEqual(captured.body, {
    text: 'Hello from Gradium.',
    voice_id: 'gradium-voice-1',
    model_name: 'default',
    output_format: 'pcm_16000',
    only_audio: true,
    continuation: 'preserve',
  })
})

test('Gradium provider streams text-to-speech audio over WebSocket', async () => {
  const server = new WebSocketServer({ port: 0 })
  const address = await new Promise(resolve => server.once('listening', () => resolve(server.address())))
  const received = []
  server.on('connection', socket => {
    socket.on('message', data => {
      const message = JSON.parse(Buffer.from(data).toString('utf8'))
      received.push(message)
      if (message.type === 'end_of_stream') {
        socket.send(JSON.stringify({
          type: 'audio',
          audio: Buffer.alloc(256, 3).toString('base64'),
        }))
        socket.send(JSON.stringify({ type: 'end_of_stream' }))
      }
    })
  })

  try {
    const provider = new GradiumProvider()
    const result = await provider.streamSynthesize({
      voice: 'gradium-voice-1',
      output_format: 'pcm',
      id: 'tts-stream',
      text: 'Stream from Gradium.',
    }, {
      config: {
        ws_url: `ws://127.0.0.1:${address.port}/api`,
      },
      secrets: { api_key: 'test-gradium-key' },
    })

    const streamedAudio = await readStreamBuffer(result.stream)
    assert.equal(result.mime_type, 'audio/pcm')
    assert.equal(streamedAudio.length, 256)
    assert.equal(streamedAudio[0], 3)
    assert.deepEqual(received[0], {
      type: 'setup',
      voice_id: 'gradium-voice-1',
      model_name: 'default',
      output_format: 'pcm',
      close_ws_on_eos: true,
    })
    assert.deepEqual(received[1], { type: 'text', text: 'Stream from Gradium.' })
    assert.deepEqual(received[2], { type: 'end_of_stream' })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('Gradium provider sends speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: init.body,
    }
    return new Response([
      JSON.stringify({ type: 'text', text: 'Recognized ' }),
      JSON.stringify({ type: 'end_text', text: 'by Gradium' }),
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    })
  }

  const provider = new GradiumProvider()
  const result = await provider.transcribe({
    model: 'fast-asr',
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'en-US',
    format: 'raw',
    extra_params: {
      language: 'fr',
      diarization: true,
    },
  }, {
    config: {},
    secrets: { api_key: 'test-gradium-key' },
  })

  const url = new URL(captured.url)
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.gradium.ai/api/post/speech/asr')
  assert.equal(url.searchParams.get('model'), 'fast-asr')
  assert.equal(url.searchParams.get('input_format'), 'wav')
  assert.equal(url.searchParams.get('json_config'), JSON.stringify({ language: 'en', diarization: true }))
  assert.equal(captured.headers['x-api-key'], 'test-gradium-key')
  assert.equal(captured.headers['content-type'], 'audio/wav')
  assert.equal(captured.body.type, 'audio/wav')
  assert.equal(result.text, 'Recognized by Gradium')
  assert.equal(result.raw.length, 2)
})

test('Gradium provider sends voice clone requests and lists voices', async () => {
  const captures = []
  globalThis.fetch = async (url, init) => {
    captures.push({ url: String(url), headers: init.headers, init })
    if (init?.method === 'POST') {
      return new Response(JSON.stringify({
        uid: 'gradium-clone-1',
        was_updated: false,
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      })
    }
    const requestUrl = new URL(String(url))
    const skip = requestUrl.searchParams.get('skip')
    const voices = skip === '100'
      ? [{
          uid: 'gradium-voice-101',
          name: 'Second Page Voice',
          is_catalog: true,
          is_pro_clone: false,
          language: 'zh',
        }]
      : Array.from({ length: 100 }, (_, index) => ({
          uid: index === 0 ? 'gradium-voice-2' : `gradium-voice-${index + 2}`,
          name: index === 0 ? 'Catalog Voice' : `Catalog Voice ${index + 2}`,
          is_catalog: true,
          is_pro_clone: false,
          language: 'en',
        }))
    return new Response(JSON.stringify(voices), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new GradiumProvider()
  const clone = await provider.cloneVoice({
    name: 'Narrator',
    audio_sample: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'voice.wav',
    },
    extra_params: {
      description: 'Calm narrator',
      language: 'en-US',
      timeout_s: 99,
      tags: ['narration', 'calm'],
    },
  }, {
    config: { clone_timeout_seconds: 12 },
    secrets: { api_key: 'test-gradium-key' },
  })
  const voices = await provider.listVoices({
    config: {},
    secrets: { api_key: 'test-gradium-key' },
  })

  const cloneCapture = captures[0]
  assert.equal(cloneCapture.url, 'https://api.gradium.ai/api/voices/')
  assert.equal(cloneCapture.headers['x-api-key'], 'test-gradium-key')
  assert.equal(cloneCapture.init.body.get('name'), 'Narrator')
  assert.equal(cloneCapture.init.body.get('language'), 'en')
  assert.equal(cloneCapture.init.body.get('input_format'), 'wav')
  assert.equal(cloneCapture.init.body.get('timeout_s'), '12')
  assert.deepEqual(cloneCapture.init.body.getAll('tags[]'), ['narration', 'calm'])
  assert.equal(clone.voice.voice_id, 'gradium-clone-1')
  assert.equal(clone.voice.provider_voice_id, 'gradium-clone-1')
  assert.equal(captures[1].url, 'https://api.gradium.ai/api/voices/?skip=0&limit=100&include_catalog=true')
  assert.equal(captures[2].url, 'https://api.gradium.ai/api/voices/?skip=100&limit=100&include_catalog=true')
  assert.deepEqual(voices[0], {
    id: 'gradium-voice-2',
    name: 'Catalog Voice',
    locale: 'en',
    provider: 'gradium',
    capabilities: { tts: true, tts_streaming: true, voice_clone: false },
  })
  assert.equal(voices.length, 101)
  assert.deepEqual(voices[100], {
    id: 'gradium-voice-101',
    name: 'Second Page Voice',
    locale: 'zh',
    provider: 'gradium',
    capabilities: { tts: true, tts_streaming: true, voice_clone: false },
  })
})

test('Gradium provider exposes metadata', async () => {
  const providers = listProviderDefinitions()
  const gradium = providers.find(item => item.id === 'gradium')
  assert.equal(gradium.name, 'Gradium')
  assert.equal(gradium.capabilities.tts, true)
  assert.equal(gradium.capabilities.tts_streaming, true)
  assert.equal(gradium.capabilities.asr, true)
  assert.equal(gradium.capabilities.voice_clone, true)
  assert.ok(gradium.fields.find(field => field.key === 'tts_model').options.includes('default'))
  assert.ok(gradium.fields.find(field => field.key === 'asr_model').options.includes('default'))
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
