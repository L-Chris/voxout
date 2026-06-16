import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { MimoTtsProvider } from '../dist/providers/mimo.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Mimo provider sends preset voice synthesis requests', async () => {
  const captured = await synthesizeWithMockedFetch({
    providerRequest: {
      voice: '冰糖',
      id: 'preset',
      text: '你好，rebook。',
    },
  })

  assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured.headers['api-key'], 'test-key')
  assert.equal(captured.headers.authorization, 'Bearer test-key')
  assert.equal(captured.body.model, 'mimo-v2.5-tts')
  assert.deepEqual(captured.body.messages, [
    { role: 'assistant', content: '你好，rebook。' },
  ])
  assert.deepEqual(captured.body.audio, {
    format: 'mp3',
    voice: '冰糖',
  })
})

test('Mimo provider streams preset voice synthesis audio chunks', async () => {
  let captured
  const audioChunk = Buffer.alloc(256, 2)
  globalThis.fetch = async (url, init) => {
    captured = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(`data: ${JSON.stringify({
      choices: [{
        delta: {
          audio: {
            data: audioChunk.toString('base64'),
          },
        },
      }],
    })}\n\ndata: [DONE]\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new MimoTtsProvider()
  const result = await provider.streamSynthesize({
    voice: 'Chloe',
    output_format: 'pcm',
    stream_format: 'audio',
    id: 'preset-stream',
    text: '你好，voxout。',
  }, {
    config: {},
    secrets: { api_key: 'test-key' },
  })

  const streamedAudio = await readStreamBuffer(result.stream)
  assert.equal(result.mime_type, 'audio/pcm')
  assert.equal(streamedAudio.length, 256)
  assert.equal(streamedAudio[0], 2)
  assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured.headers['api-key'], 'test-key')
  assert.equal(captured.body.stream, true)
  assert.equal(captured.body.model, 'mimo-v2.5-tts')
  assert.deepEqual(captured.body.audio, {
    format: 'pcm16',
    voice: 'Chloe',
  })
})

test('Mimo provider designs a reusable voice preview', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(JSON.stringify({
      choices: [{
        message: {
          audio: {
            data: Buffer.alloc(256, 1).toString('base64'),
            transcript: '你好，我会用这个声音为角色说话。',
          },
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new MimoTtsProvider()
  const result = await provider.designVoice({
    instructions: '年轻男性，冷静克制，嗓音清亮。',
    name: '冷静男声',
    model: 'mimo-custom-design-model',
  }, {
    config: {},
    secrets: { api_key: 'test-key' },
  })

  assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured.body.model, 'mimo-custom-design-model')
  assert.equal(captured.body.audio.format, 'mp3')
  assert.equal(result.voices[0].name, '冷静男声')
  assert.match(result.voices[0].voice_id, /^mimo_/)
  assert.equal(result.voices[0].preview_mime_type, 'audio/mpeg')
  assert.match(result.voices[0].preview_audio_data, /^data:audio\/mpeg;base64,/)
})

test('Mimo provider creates a voice from preview data locally', async () => {
  const provider = new MimoTtsProvider()
  const result = await provider.createDesignedVoice({
    generated_voice_id: 'mimo_preview_1',
    name: '冷静男声',
    instructions: '年轻男性，冷静克制，嗓音清亮。',
    language: 'zh-CN',
    preview_audio_data: `data:audio/wav;base64,${Buffer.alloc(256, 1).toString('base64')}`,
    preview_mime_type: 'audio/wav',
    labels: { style: 'calm' },
  })

  assert.equal(result.voice.voice_id, 'mimo_preview_1')
  assert.equal(result.voice.provider_voice_id, undefined)
  assert.equal(result.voice.name, '冷静男声')
  assert.equal(result.voice.language, 'zh-CN')
  assert.match(result.voice.preview_audio_data, /^data:audio\/wav;base64,/)
  assert.equal(result.voice.metadata.created_from_voice_design_preview, true)
})

test('Mimo provider uses voice data URLs with the voice clone model', async () => {
  const captured = await synthesizeWithMockedFetch({
    providerRequest: {
      voice: `data:audio/wav;base64,${Buffer.alloc(256, 1).toString('base64')}`,
      id: 'voice-id',
      text: '用保存的声音说话。',
    },
  })

  assert.equal(captured.body.model, 'mimo-v2.5-tts-voiceclone')
  assert.match(captured.body.audio.voice, /^data:audio\/wav;base64,/)
})

test('Mimo provider clones a local audio sample without provider voice id', async () => {
  const provider = new MimoTtsProvider()
  const result = await provider.cloneVoice({
    name: 'Local sample',
    audio_sample: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'voice.wav',
    },
  })

  assert.equal(result.provider, 'mimo')
  assert.match(result.voice.voice_id, /^mimo_/)
  assert.equal(result.voice.provider_voice_id, undefined)
  assert.match(result.voice.preview_audio_data, /^data:audio\/wav;base64,/)
  assert.equal(result.voice.metadata.provider_voice_id, null)
})

test('Mimo provider exposes voice design capability metadata', async () => {
  const provider = new MimoTtsProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.voice_design, true)
  assert.equal(provider.capabilities.voice_clone, true)
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.asr_streaming, true)
  assert.ok(voices.length > 0)
  assert.equal(voices.find(voice => voice.id === 'mimo_default').gender, 'Female')
  assert.equal(voices[0].capabilities.voice_design, true)

  const providers = listProviderDefinitions()
  const mimoProviders = providers.filter(item => item.id === 'mimo')
  assert.equal(mimoProviders.length, 1)
  const [mimo] = mimoProviders
  assert.equal(mimo.capabilities.voice_design, true)
  assert.equal(mimo.capabilities.voice_clone, true)
  assert.equal(mimo.capabilities.asr, true)
  assert.equal(mimo.capabilities.asr_streaming, true)
})

test('Mimo provider sends speech recognition requests', async () => {
  const captured = []
  globalThis.fetch = async (url, init) => {
    captured.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    })
    return new Response(JSON.stringify({
      choices: [{
        message: {
          content: '识别结果',
          role: 'assistant',
          audio: null,
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new MimoTtsProvider()
  const result = await provider.transcribe({
    model: 'mimo-custom-asr',
    file: {
      data: Buffer.from('audio'),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'zh',
    format: 'raw',
  }, {
    config: {},
    secrets: { api_key: 'test-key' },
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured[0].headers['api-key'], 'test-key')
  assert.equal(captured[0].body.model, 'mimo-custom-asr')
  assert.deepEqual(captured[0].body.messages, [
    {
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: {
            data: `data:audio/wav;base64,${Buffer.from('audio').toString('base64')}`,
          },
        },
      ],
    },
  ])
  assert.deepEqual(captured[0].body.asr_options, { language: 'zh' })
  assert.equal(result.provider, 'mimo')
  assert.equal(result.text, '识别结果')
  assert.equal(result.raw.choices[0].message.content, '识别结果')
})

test('Mimo provider streams speech recognition as OpenAI transcription events', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response([
      `data: ${JSON.stringify({ choices: [{ delta: { content: '识别' } }] })}`,
      '',
      `data: ${JSON.stringify({ choices: [{ delta: { content: '结果' } }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n'), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }

  const provider = new MimoTtsProvider()
  const result = await provider.streamTranscribe({
    model: 'mimo-v2.5-asr',
    file: {
      data: Buffer.from('audio'),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'auto',
    stream: true,
    extra_params: {
      model: 'extra-model-should-not-win',
      stream: false,
      asr_options: {
        language: 'ja',
        punctuation: true,
      },
      trace_id: 'trace-1',
    },
  }, {
    config: {},
    secrets: { api_key: 'test-key' },
  })

  const streamText = await readStreamText(result.stream)
  assert.equal(result.mime_type, 'text/event-stream')
  assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured.headers['api-key'], 'test-key')
  assert.equal(captured.body.stream, true)
  assert.equal(captured.body.model, 'mimo-v2.5-asr')
  assert.equal(captured.body.trace_id, 'trace-1')
  assert.deepEqual(captured.body.asr_options, { language: 'auto', punctuation: true })
  assert.match(streamText, /"type":"transcript\.text\.delta","delta":"识别"/)
  assert.match(streamText, /"type":"transcript\.text\.delta","delta":"结果"/)
  assert.match(streamText, /"type":"transcript\.text\.done","text":"识别结果"/)
  assert.match(streamText, /data: \[DONE\]/)
})

async function synthesizeWithMockedFetch({ providerRequest, returnAllCaptures = false }) {
  const captures = []
  globalThis.fetch = async (url, init) => {
    captures.push({
      url,
      headers: init.headers,
      body: JSON.parse(init.body),
    })
    return new Response(JSON.stringify({
      choices: [{
        message: {
          audio: {
            data: Buffer.alloc(256, 1).toString('base64'),
            transcript: providerRequest.text,
          },
        },
      }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new MimoTtsProvider()
  const result = await provider.synthesize(providerRequest, {
    config: {},
    secrets: { api_key: 'test-key' },
  })
  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, providerRequest.output_format === 'wav' ? 'audio/wav' : 'audio/mpeg')
  return returnAllCaptures ? captures : captures[0]
}

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

async function readStreamText(stream) {
  return (await readStreamBuffer(stream)).toString('utf8')
}
