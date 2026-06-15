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
    model: 'tts-1-hd',
    voice: 'voice_custom_1',
    output_format: 'mp3',
    instructions: 'Speak with a warm narration style.',
    extra_params: {
      seed: 42,
    },
    id: 'tts',
    text: 'Hello from OpenAI.',
  }, {
    config: { tts_model: 'gpt-4o-mini-tts' },
    secrets: { api_key: 'test-openai-key' },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/mpeg')
  assert.equal(captured.url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.deepEqual(captured.body, {
    model: 'tts-1-hd',
    input: 'Hello from OpenAI.',
    voice: 'voice_custom_1',
    response_format: 'mp3',
    instructions: 'Speak with a warm narration style.',
    seed: 42,
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
    model: 'gpt-4o-mini-tts',
    output_format: 'mp3',
    stream_format: 'sse',
    id: 'tts',
    text: 'Hello from OpenAI.',
    instructions: 'Sound calm.',
  }, {
    config: { tts_model: 'gpt-4o-mini-tts' },
    secrets: { api_key: 'test-openai-key' },
  })

  assert.equal(result.mime_type, 'text/event-stream')
  assert.equal(await readStreamText(result.stream), 'data: {"type":"audio.delta"}\n\n')
  assert.equal(captured.url, 'https://api.openai.com/v1/audio/speech')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.deepEqual(captured.body, {
    model: 'gpt-4o-mini-tts',
    input: 'Hello from OpenAI.',
    voice: 'alloy',
    response_format: 'mp3',
    stream_format: 'sse',
    instructions: 'Sound calm.',
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
      audio_sample: init.body.get('audio_sample'),
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
    audio_sample: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'voice.wav',
    },
  }, {
    config: {},
    secrets: { api_key: 'test-openai-key' },
  })

  assert.equal(captured.url, 'https://api.openai.com/v1/audio/voices')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.equal(captured.name, 'Narrator')
  assert.equal(captured.consent, 'cons_1234')
  assert.equal(captured.audio_sample.type, 'audio/wav')
  assert.equal(result.voice.voice_id, 'voice_openai_1')
  assert.equal(result.voice.provider_voice_id, 'voice_openai_1')
})

test('OpenAI provider sends speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      model: init.body.get('model'),
      response_format: init.body.get('response_format'),
      language: init.body.get('language'),
      prompt: init.body.get('prompt'),
      temperature: init.body.get('temperature'),
      include: init.body.getAll('include[]'),
      timestamp_granularities: init.body.getAll('timestamp_granularities[]'),
      chunking_strategy: init.body.get('chunking_strategy'),
      known_speaker_names: init.body.getAll('known_speaker_names[]'),
      known_speaker_references: init.body.getAll('known_speaker_references[]'),
      custom_scalar: init.body.get('custom_scalar'),
      custom_array: init.body.getAll('custom_array[]'),
      custom_object: init.body.get('custom_object'),
      file: init.body.get('file'),
    }
    return new Response(JSON.stringify({
      text: 'Recognized by OpenAI',
      segments: [{ start: 0, end: 0.8, text: 'Recognized by OpenAI' }],
      logprobs: [{ token: 'Recognized', bytes: [82], logprob: -0.01 }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new OpenAiProvider()
  const result = await provider.transcribe({
    model: 'whisper-1',
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'en',
    prompt: 'Technical vocabulary appears in this recording.',
    temperature: 0.2,
    include: ['logprobs'],
    timestamp_granularities: ['word', 'segment'],
    chunking_strategy: 'auto',
    known_speaker_names: ['agent'],
    known_speaker_references: ['data:audio/wav;base64,AAAA'],
    extra_params: {
      custom_scalar: 'enabled',
      custom_array: ['a', 'b'],
      custom_object: { nested_value: true },
    },
    format: 'raw',
  }, {
    config: { asr_model: 'gpt-4o-transcribe' },
    secrets: { api_key: 'test-openai-key' },
  })

  assert.equal(captured.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.equal(captured.model, 'whisper-1')
  assert.equal(captured.response_format, 'verbose_json')
  assert.equal(captured.language, 'en')
  assert.equal(captured.prompt, 'Technical vocabulary appears in this recording.')
  assert.equal(captured.temperature, '0.2')
  assert.deepEqual(captured.include, ['logprobs'])
  assert.deepEqual(captured.timestamp_granularities, ['word', 'segment'])
  assert.equal(captured.chunking_strategy, 'auto')
  assert.deepEqual(captured.known_speaker_names, ['agent'])
  assert.deepEqual(captured.known_speaker_references, ['data:audio/wav;base64,AAAA'])
  assert.equal(captured.custom_scalar, 'enabled')
  assert.deepEqual(captured.custom_array, ['a', 'b'])
  assert.equal(captured.custom_object, JSON.stringify({ nested_value: true }))
  assert.equal(captured.file.type, 'audio/wav')
  assert.equal(result.text, 'Recognized by OpenAI')
  assert.equal(result.raw.text, 'Recognized by OpenAI')
  assert.deepEqual(result.raw.logprobs, [{ token: 'Recognized', bytes: [82], logprob: -0.01 }])
  assert.deepEqual(result.segments, [{ from: 0, to: 0.8, content: 'Recognized by OpenAI' }])
})

test('OpenAI provider streams speech-to-text requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      model: init.body.get('model'),
      response_format: init.body.get('response_format'),
      stream: init.body.get('stream'),
      file: init.body.get('file'),
    }
    return new Response('data: {"type":"transcript.text.delta","delta":"Hello"}\n\ndata: [DONE]\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new OpenAiProvider()
  const result = await provider.streamTranscribe({
    model: 'gpt-4o-mini-transcribe',
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    response_format: 'text',
    stream: true,
  }, {
    config: {},
    secrets: { api_key: 'test-openai-key' },
  })

  assert.equal(result.mime_type, 'text/event-stream')
  assert.equal(await readStreamText(result.stream), 'data: {"type":"transcript.text.delta","delta":"Hello"}\n\ndata: [DONE]\n\n')
  assert.equal(captured.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(captured.headers.authorization, 'Bearer test-openai-key')
  assert.equal(captured.model, 'gpt-4o-mini-transcribe')
  assert.equal(captured.response_format, 'text')
  assert.equal(captured.stream, 'true')
  assert.equal(captured.file.type, 'audio/wav')
})

test('OpenAI provider exposes TTS, ASR, and voice clone metadata', async () => {
  const provider = new OpenAiProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.voice_clone, true)
  assert.ok(voices.some(voice => voice.id === 'alloy'))
  assert.equal(voices.find(voice => voice.id === 'marin').gender, 'Female')
  assert.equal(voices.find(voice => voice.id === 'cedar').gender, 'Male')

  const providers = listProviderDefinitions()
  const openai = providers.find(item => item.id === 'openai')
  assert.equal(openai.name, 'OpenAI')
  assert.equal(openai.capabilities.tts, true)
  assert.equal(openai.capabilities.asr, true)
  assert.equal(openai.capabilities.asr_streaming, true)
  assert.equal(openai.capabilities.voice_clone, true)
  assert.ok(openai.fields.find(field => field.key === 'tts_model').options.includes('gpt-4o-mini-tts'))
  assert.ok(openai.fields.find(field => field.key === 'asr_model').options.includes('gpt-4o-transcribe'))
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
