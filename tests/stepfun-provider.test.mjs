import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { StepFunProvider } from '../dist/providers/stepfun.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('StepFun provider sends text-to-speech requests', async () => {
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

  const provider = new StepFunProvider()
  const result = await provider.synthesize({
    model: 'stepaudio-2.5-tts',
    voice: 'cixingnansheng',
    output_format: 'mp3',
    speed: 3,
    instructions: '语气坚定，节奏自然。',
    extra_params: {
      volume: 1.5,
      sample_rate: 24000,
      pronunciation_map: {
        tone: ['阿胶/e1胶'],
      },
      model: 'extra-model-should-not-win',
      response_format: 'wav',
    },
    id: 'tts',
    text: '智能阶跃，十倍每一个人的可能。',
  }, {
    config: { tts_model: 'step-tts-mini' },
    secrets: { api_key: 'test-stepfun-key' },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.stepfun.com/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-stepfun-key')
  assert.deepEqual(captured.body, {
    model: 'stepaudio-2.5-tts',
    input: '智能阶跃，十倍每一个人的可能。',
    voice: 'cixingnansheng',
    response_format: 'mp3',
    speed: 2,
    instruction: '语气坚定，节奏自然。',
    volume: 1.5,
    sample_rate: 24000,
    pronunciation_map: {
      tone: ['阿胶/e1胶'],
    },
  })
})

test('StepFun provider streams text-to-speech requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response('data: {"type":"speech.audio.delta","audio":"AAAA"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new StepFunProvider()
  const result = await provider.streamSynthesize({
    model: 'step-tts-mini',
    output_format: 'mp3',
    stream_format: 'sse',
    id: 'tts-stream',
    text: 'Stream from StepFun.',
    instructions: 'This should not be sent to step-tts-mini.',
  }, {
    config: {},
    secrets: { api_key: 'test-stepfun-key' },
  })

  assert.equal(result.mime_type, 'text/event-stream')
  assert.equal(await readStreamText(result.stream), 'data: {"type":"speech.audio.delta","audio":"AAAA"}\n\ndata: [DONE]\n\n')
  assert.equal(captured.url, 'https://api.stepfun.com/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-stepfun-key')
  assert.deepEqual(captured.body, {
    model: 'step-tts-mini',
    input: 'Stream from StepFun.',
    voice: 'cixingnansheng',
    response_format: 'mp3',
    stream_format: 'sse',
  })
})

test('StepFun provider exposes TTS metadata and official voices', async () => {
  const provider = new StepFunProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.tts_streaming, true)
  assert.equal(voices.find(voice => voice.id === 'cixingnansheng').gender, 'Male')
  assert.equal(voices.find(voice => voice.id === 'elegantgentle-female').gender, 'Female')
  assert.equal(voices.find(voice => voice.id === 'cixingnansheng').locale, 'zh-CN')

  const providers = listProviderDefinitions()
  const stepfun = providers.find(item => item.id === 'stepfun')
  assert.equal(stepfun.name, 'StepFun')
  assert.equal(stepfun.capabilities.tts, true)
  assert.equal(stepfun.capabilities.tts_streaming, true)
  assert.ok(!stepfun.fields.some(field => field.key === 'api_key'))
  assert.ok(stepfun.fields.find(field => field.key === 'tts_model').options.includes('step-tts-mini'))
  assert.ok(stepfun.fields.find(field => field.key === 'default_voice').options.includes('cixingnansheng'))
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
