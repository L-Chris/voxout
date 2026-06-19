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
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.asr_streaming, true)
  assert.equal(provider.capabilities.voice_clone, true)
  assert.equal(voices.find(voice => voice.id === 'cixingnansheng').gender, 'Male')
  assert.equal(voices.find(voice => voice.id === 'elegantgentle-female').gender, 'Female')
  assert.equal(voices.find(voice => voice.id === 'cixingnansheng').locale, 'zh-CN')

  const providers = listProviderDefinitions()
  const stepfun = providers.find(item => item.id === 'stepfun')
  assert.equal(stepfun.name, 'StepFun')
  assert.equal(stepfun.capabilities.tts, true)
  assert.equal(stepfun.capabilities.tts_streaming, true)
  assert.equal(stepfun.capabilities.asr, true)
  assert.equal(stepfun.capabilities.asr_streaming, true)
  assert.equal(stepfun.capabilities.voice_clone, true)
  assert.ok(!stepfun.fields.some(field => field.key === 'api_key'))
  assert.ok(stepfun.fields.find(field => field.key === 'tts_model').options.includes('step-tts-mini'))
  assert.ok(stepfun.fields.find(field => field.key === 'asr_model').options.includes('stepaudio-2.5-asr'))
  assert.ok(stepfun.fields.find(field => field.key === 'default_voice').options.includes('cixingnansheng'))
})

test('StepFun provider sends speech recognition requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response([
      'data: {"type":"transcript.text.delta","delta":"你好","start_time":0,"end_time":500}',
      '',
      'data: {"type":"transcript.text.done","text":"你好世界"}',
      '',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new StepFunProvider()
  const result = await provider.transcribe({
    model: 'stepaudio-2.5-asr',
    file: {
      data: Buffer.from('audio-bytes'),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'zh-CN',
    timestamp_granularities: ['word'],
    format: 'raw',
    extra_params: {
      audio: {
        input: {
          transcription: {
            hotwords: ['阶跃星辰'],
            enable_itn: true,
          },
        },
      },
    },
  }, {
    config: {},
    secrets: { api_key: 'test-stepfun-key' },
  })

  assert.equal(captured.url, 'https://api.stepfun.com/v1/audio/asr/sse')
  assert.equal(captured.headers.authorization, 'Bearer test-stepfun-key')
  assert.equal(captured.headers.accept, 'text/event-stream')
  assert.equal(captured.body.audio.data, Buffer.from('audio-bytes').toString('base64'))
  assert.deepEqual(captured.body.audio.input.transcription, {
    hotwords: ['阶跃星辰'],
    enable_itn: true,
    language: 'zh',
    model: 'stepaudio-2.5-asr',
    enable_timestamp: true,
  })
  assert.deepEqual(captured.body.audio.input.format, { type: 'wav' })
  assert.equal(result.text, '你好世界')
  assert.deepEqual(result.segments, [{ from: 0, to: 0.5, content: '你好' }])
  assert.equal(result.raw.events.length, 2)
})

test('StepFun provider streams speech recognition requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response('data: {"type":"transcript.text.delta","delta":"stream"}\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new StepFunProvider()
  const result = await provider.streamTranscribe({
    file: {
      data: Buffer.from('mp3-bytes'),
      mime_type: 'audio/mpeg',
      file_name: 'sample.mp3',
    },
    stream: true,
  }, {
    config: {},
    secrets: { api_key: 'test-stepfun-key' },
  })

  assert.equal(result.mime_type, 'text/event-stream')
  assert.equal(await readStreamText(result.stream), 'data: {"type":"transcript.text.delta","delta":"stream"}\n\n')
  assert.equal(captured.url, 'https://api.stepfun.com/v1/audio/asr/sse')
  assert.equal(captured.body.audio.input.transcription.model, 'stepaudio-2.5-asr')
  assert.deepEqual(captured.body.audio.input.format, { type: 'mp3' })
})

test('StepFun provider clones voices and lists custom voices', async () => {
  const captures = []
  globalThis.fetch = async (url, init = {}) => {
    captures.push({ url: String(url), init })
    const requestUrl = new URL(String(url))
    if (requestUrl.pathname.endsWith('/files')) {
      return new Response(JSON.stringify({
        id: 'file-stepfun-1',
        object: 'file',
        status: 'processed',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (requestUrl.pathname.endsWith('/audio/voices') && init.method === 'POST') {
      return new Response(JSON.stringify({
        id: 'voice-tone-stepfun-1',
        object: 'audio.voice',
        duplicated: false,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (requestUrl.pathname.endsWith('/audio/system_voices')) {
      return new Response(JSON.stringify({
        voices: ['cixingnansheng', 'yingwennansheng'],
        'voices-details': {
          cixingnansheng: {
            'voice-name': '磁性男声',
            'voice-description': '男，深情厚重',
          },
          yingwennansheng: {
            'voice-name': '英文男声',
            'voice-description': '男，英文音色',
          },
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (requestUrl.pathname.endsWith('/audio/voices')) {
      return new Response(JSON.stringify({
        object: 'list',
        data: [{ id: 'voice-tone-stepfun-1', file_id: 'file-stepfun-1', created_at: 1781220000 }],
        has_more: false,
        last_id: 'voice-tone-stepfun-1',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected URL ${url}`)
  }

  const provider = new StepFunProvider()
  const result = await provider.cloneVoice({
    name: 'Narrator',
    audio_sample: {
      data: Buffer.from('voice-sample'),
      mime_type: 'audio/wav',
      file_name: 'voice.wav',
    },
    extra_params: {
      model: 'step-tts-mini',
      text: '智能阶跃，十倍每一个人的可能。',
    },
  }, {
    config: {},
    secrets: { api_key: 'test-stepfun-key' },
  })
  const fileCapture = captures.find(capture => capture.url.endsWith('/files'))
  const cloneCapture = captures.find(capture => capture.url.endsWith('/audio/voices') && capture.init.method === 'POST')
  assert.equal(fileCapture.init.headers.authorization, 'Bearer test-stepfun-key')
  assert.equal(fileCapture.init.body.get('purpose'), 'storage')
  assert.equal(fileCapture.init.body.get('file').type, 'audio/wav')
  assert.deepEqual(JSON.parse(cloneCapture.init.body), {
    file_id: 'file-stepfun-1',
    model: 'step-tts-mini',
    text: '智能阶跃，十倍每一个人的可能。',
  })
  assert.equal(result.voice.voice_id, 'voice-tone-stepfun-1')
  assert.equal(result.voice.provider_voice_id, 'voice-tone-stepfun-1')
  assert.equal(result.voice.preview_mime_type, 'audio/wav')
  assert.equal(result.voice.metadata.file_id, 'file-stepfun-1')

  const voices = await provider.listVoices({
    config: {},
    secrets: { api_key: 'test-stepfun-key' },
  })
  assert.equal(voices.find(voice => voice.id === 'cixingnansheng').gender, 'Male')
  assert.equal(voices.find(voice => voice.id === 'yingwennansheng').locale, 'en-US')
  assert.ok(voices.some(voice => voice.id === 'voice-tone-stepfun-1'))
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
