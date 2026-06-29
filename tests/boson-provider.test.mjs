import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { BosonProvider } from '../dist/providers/boson.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Boson provider sends text-to-speech requests', async () => {
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

  const provider = new BosonProvider()
  const result = await provider.synthesize({
    text: 'Hello from voxout.',
    output_format: 'mp3',
  }, {
    config: { tts_model: 'higgs-tts-3', tts_voice: 'nora' },
    secrets: { api_key: 'test-boson-key' },
  })

  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal(result.audio.length, 256)
  assert.equal(captured.url, 'https://api.boson.ai/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-boson-key')
  assert.deepEqual(captured.body, {
    input: 'Hello from voxout.',
    model: 'higgs-tts-3',
    voice: 'nora',
    response_format: 'mp3',
  })
})

test('Boson provider streams speech as raw PCM', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(Buffer.alloc(128, 2), {
      status: 200,
      headers: { 'content-type': 'audio/L16' },
    })
  }

  const provider = new BosonProvider()
  const result = await provider.streamSynthesize({
    text: 'Stream this.',
    stream_format: 'audio',
  }, {
    config: {},
    secrets: { api_key: 'test-boson-key' },
  })

  assert.equal(result.mime_type, 'audio/L16')
  assert.equal((await readStreamBuffer(result.stream)).length, 128)
  assert.equal(captured.url, 'https://api.boson.ai/v1/audio/speech')
  assert.deepEqual(captured.body, {
    input: 'Stream this.',
    model: 'higgs-tts-3',
    voice: 'chloe',
    response_format: 'pcm',
    stream: true,
  })
})

test('Boson provider lists preset and custom voices', async () => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    object: 'list',
    data: [
      {
        voice: 'voice_custom_1',
        description: 'Custom narrator',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })

  const provider = new BosonProvider()
  const voices = await provider.listVoices({
    config: {},
    secrets: { api_key: 'test-boson-key' },
  })

  assert.ok(voices.some(voice => voice.id === 'chloe'))
  assert.ok(voices.some(voice => voice.id === 'oliver'))
  assert.ok(voices.some(voice => voice.id === 'voice_custom_1' && voice.name === 'Custom narrator'))
})

test('Boson provider clones reusable voices', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: init.body,
    }
    return new Response(JSON.stringify({
      voice: 'voice_boson_1',
      description: 'Narrator clone',
      created_at: '2026-01-01T00:00:00Z',
      ref_text: 'Reference transcript.',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new BosonProvider()
  const result = await provider.cloneVoice({
    name: 'Narrator clone',
    audio_sample: {
      data: Buffer.from('voice audio'),
      mime_type: 'audio/mpeg',
      file_name: 'sample.mp3',
    },
    extra_params: {
      ref_text: 'Reference transcript.',
    },
  }, {
    config: {},
    secrets: { api_key: 'test-boson-key' },
  })

  assert.equal(result.voice.voice_id, 'voice_boson_1')
  assert.equal(result.voice.provider_voice_id, 'voice_boson_1')
  assert.equal(captured.url, 'https://api.boson.ai/v1/audio/voices')
  assert.equal(captured.headers.authorization, 'Bearer test-boson-key')
  assert.ok(captured.body instanceof FormData)
  assert.equal(captured.body.get('ref_text'), 'Reference transcript.')
  assert.equal(captured.body.get('ref_audio').name, 'sample.mp3')
})

test('Boson provider creates avatar videos with JSON input_tts requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(JSON.stringify({
      id: 'video_test_1',
      object: 'video',
      model: 'higgs-avatar',
      status: 'queued',
      progress: 0,
      size: '640x480',
      created_at: 123,
      error: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new BosonProvider()
  const result = await provider.createVideo({
    ref_image: 'https://example.com/avatar.png',
    input_tts: {
      input: 'Hello from voxout.',
      response_format: 'mp3',
    },
    size: '640x480',
    extra_params: {
      custom_id: 'job-1',
    },
  }, {
    config: { video_model: 'higgs-avatar', tts_voice: 'eleanor' },
    secrets: { api_key: 'test-boson-key' },
  })

  assert.equal(result.id, 'video_test_1')
  assert.equal(captured.url, 'https://api.boson.ai/v1/videos')
  assert.equal(captured.headers.authorization, 'Bearer test-boson-key')
  assert.equal(captured.headers['content-type'], 'application/json')
  assert.deepEqual(captured.body, {
    model: 'higgs-avatar',
    ref_image: 'https://example.com/avatar.png',
    input_tts: {
      input: 'Hello from voxout.',
      voice: 'eleanor',
      response_format: 'mp3',
    },
    size: '640x480',
    custom_id: 'job-1',
  })
})

test('Boson provider creates avatar videos with multipart image and audio files', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: init.body,
    }
    return new Response(JSON.stringify({
      id: 'video_file_1',
      object: 'video',
      model: 'higgs-avatar',
      status: 'queued',
      progress: 0,
      size: '480x640',
      created_at: 123,
      error: null,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new BosonProvider()
  const result = await provider.createVideo({
    ref_image: {
      data: Buffer.from('image'),
      mime_type: 'image/png',
      file_name: 'avatar.png',
    },
    input: {
      data: Buffer.from('audio'),
      mime_type: 'audio/mpeg',
      file_name: 'speech.mp3',
    },
    size: '480x640',
  }, {
    config: {},
    secrets: { api_key: 'test-boson-key' },
  })

  assert.equal(result.id, 'video_file_1')
  assert.equal(captured.url, 'https://api.boson.ai/v1/videos')
  assert.equal(captured.headers.authorization, 'Bearer test-boson-key')
  assert.ok(captured.body instanceof FormData)
  assert.equal(captured.body.get('model'), 'higgs-avatar')
  assert.equal(captured.body.get('size'), '480x640')
  assert.equal(captured.body.get('ref_image').name, 'avatar.png')
  assert.equal(captured.body.get('ref_image').type, 'image/png')
  assert.equal(captured.body.get('input').name, 'speech.mp3')
  assert.equal(captured.body.get('input').type, 'audio/mpeg')
})

test('Boson provider retrieves, downloads, and streams videos', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const requestUrl = new URL(String(url))
    if (requestUrl.pathname === '/v1/videos/video_test_1' && !requestUrl.pathname.endsWith('/content')) {
      return new Response(JSON.stringify({
        id: 'video_test_1',
        object: 'video',
        model: 'higgs-avatar',
        status: 'completed',
        progress: 100,
        size: '640x640',
        created_at: 123,
        error: null,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (requestUrl.pathname === '/v1/videos/video_test_1/content') {
      return new Response(Buffer.alloc(256, 7), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      })
    }
    if (requestUrl.pathname === '/v1/videos/stream') {
      return new Response(Buffer.alloc(128, 8), {
        status: 200,
        headers: {
          'content-type': 'video/mp4',
          'x-video-id': 'video_stream_1',
        },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }

  const provider = new BosonProvider()
  const context = {
    config: { base_url: 'https://boson.test' },
    secrets: { api_key: 'test-boson-key' },
  }
  const retrieved = await provider.retrieveVideo('video_test_1', context)
  const content = await provider.downloadVideoContent('video_test_1', 'video', context)
  const stream = await provider.streamVideo({
    ref_image: 'https://example.com/avatar.png',
    input_tts: { input: 'Stream this.' },
  }, context)

  assert.equal(retrieved.status, 'completed')
  assert.equal(content.mime_type, 'video/mp4')
  assert.equal(content.video.length, 256)
  assert.equal(stream.video_id, 'video_stream_1')
  assert.equal(stream.mime_type, 'video/mp4')
  assert.equal((await readStreamBuffer(stream.stream)).length, 128)
  assert.equal(calls[0].init.headers.authorization, 'Bearer test-boson-key')
  assert.equal(calls[1].url, 'https://boson.test/v1/videos/video_test_1/content?variant=video')
  assert.equal(JSON.parse(calls[2].init.body).model, 'higgs-avatar')
})

test('Boson provider exposes video capability metadata', async () => {
  const provider = new BosonProvider()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.tts_streaming, true)
  assert.equal(provider.capabilities.video, true)
  assert.equal(provider.capabilities.video_streaming, true)
  assert.equal(provider.capabilities.voice_clone, true)

  const providers = listProviderDefinitions()
  const boson = providers.find(item => item.id === 'boson')
  assert.equal(boson.name, 'Boson')
  assert.equal(boson.capabilities.tts, true)
  assert.equal(boson.capabilities.tts_streaming, true)
  assert.equal(boson.capabilities.video, true)
  assert.equal(boson.capabilities.video_streaming, true)
  assert.equal(boson.capabilities.voice_clone, true)
  assert.ok(!boson.fields.some(field => field.key === 'api_key'))
  assert.ok(boson.fields.find(field => field.key === 'tts_model').options.includes('higgs-tts-3'))
  assert.ok(boson.fields.find(field => field.key === 'video_model').options.includes('higgs-avatar'))
  assert.ok(boson.fields.find(field => field.key === 'tts_voice').options.includes('chloe'))
  assert.ok(boson.fields.find(field => field.key === 'tts_voice').options.includes('oliver'))
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
