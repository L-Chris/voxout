import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { DefaultProvider } from '../dist/providers/default/index.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Default provider sends Bilibili Bcut ASR upload and task requests', async () => {
  const captures = []
  let uploadIndex = 0
  globalThis.fetch = async (url, init = {}) => {
    const requestUrl = String(url)
    captures.push({ url: requestUrl, init })

    if (requestUrl.endsWith('/resource/create')) {
      return jsonResponse({
        code: 0,
        data: {
          resource_id: 'resource-1',
          in_boss_key: 'boss-key',
          upload_id: 'upload-1',
          upload_urls: ['https://upload.example/part-1', 'https://upload.example/part-2'],
          per_size: 128,
        },
      })
    }
    if (requestUrl.startsWith('https://upload.example/')) {
      uploadIndex += 1
      return new Response('', {
        status: 200,
        headers: { etag: `etag-${uploadIndex}` },
      })
    }
    if (requestUrl.endsWith('/resource/create/complete')) {
      return jsonResponse({
        code: 0,
        data: {
          download_url: 'https://download.example/audio.wav',
        },
      })
    }
    if (requestUrl.endsWith('/task')) {
      return jsonResponse({
        code: 0,
        data: {
          task_id: 'task-1',
        },
      })
    }
    if (requestUrl.startsWith('https://member.bilibili.com/x/bcut/rubick-interface/task/result')) {
      return jsonResponse({
        code: 0,
        data: {
          state: 4,
          result: JSON.stringify({
            utterances: [
              { start_time: 0, end_time: 800, transcript: '你好' },
              { start_time: 800, end_time: 1250, transcript: '世界' },
            ],
            version: 'test',
          }),
        },
      })
    }
    throw new Error(`Unexpected request: ${requestUrl}`)
  }

  const provider = new DefaultProvider()
  const result = await provider.transcribe({
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    format: 'raw',
    extra_params: {
      model_id: 'extra-model-should-not-win',
      custom_flag: 'ok',
    },
  }, {
    config: {
      timeout_ms: 1000,
      bcut_poll_interval_ms: 250,
    },
  })

  assert.equal(result.provider, 'default')
  assert.equal(result.text, '你好世界')
  assert.deepEqual(result.segments, [
    { from: 0, to: 0.8, content: '你好' },
    { from: 0.8, to: 1.25, content: '世界' },
  ])
  assert.equal(result.raw.version, 'test')

  const createBody = Object.fromEntries(captures[0].init.body)
  assert.deepEqual(createBody, {
    type: '2',
    name: 'sample.wav',
    size: '256',
    resource_file_type: 'wav',
    model_id: '8',
    custom_flag: 'ok',
  })
  assert.equal(captures[1].init.method, 'PUT')
  assert.equal(captures[2].init.method, 'PUT')
  const completeBody = Object.fromEntries(captures[3].init.body)
  assert.equal(completeBody.etags, 'etag-1,etag-2')
  assert.equal(completeBody.model_id, '8')
  assert.deepEqual(JSON.parse(captures[4].init.body), {
    resource: 'https://download.example/audio.wav',
    model_id: '8',
    custom_flag: 'ok',
  })
  const resultUrl = new URL(captures[5].url)
  assert.equal(resultUrl.searchParams.get('model_id'), '8')
  assert.equal(resultUrl.searchParams.get('task_id'), 'task-1')
})

test('Default provider exposes combined TTS and ASR metadata', () => {
  const definitions = listProviderDefinitions()
  const defaultProvider = definitions.find(provider => provider.id === 'default')

  assert.equal(defaultProvider.capabilities.tts, true)
  assert.equal(defaultProvider.capabilities.tts_streaming, true)
  assert.equal(defaultProvider.capabilities.asr, true)
  assert.ok(defaultProvider.fields.some(field => field.key === 'voices_url'))
  assert.ok(defaultProvider.fields.some(field => field.key === 'asr_model'))
  assert.ok(!definitions.some(provider => provider.id === 'bilibili-asr'))
})

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
