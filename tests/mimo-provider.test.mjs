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
      segment: {
        id: 'preset',
        text: '你好，rebook。',
      },
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
    format: 'wav',
    voice: '冰糖',
  })
})

test('Mimo provider creates a designed voice sample then voice-clones target speech', async () => {
  const captures = await synthesizeWithMockedFetch({
    providerRequest: {
      outputFormat: 'mp3',
      segment: {
        id: 'design',
        text: '别动。',
        voicePrompt: '年轻男性，冷静克制，嗓音清亮。',
        stylePrompt: '低声，紧张。',
      },
    },
    returnAllCaptures: true,
  })

  assert.equal(captures.length, 2)
  assert.equal(captures[0].body.model, 'mimo-v2.5-tts-voicedesign')
  assert.deepEqual(captures[0].body.messages, [
    {
      role: 'user',
      content: '年轻男性，冷静克制，嗓音清亮。',
    },
    { role: 'assistant', content: '你好，我会用这个声音为角色说话。' },
  ])
  assert.deepEqual(captures[0].body.audio, {
    format: 'wav',
    optimize_text_preview: true,
  })

  assert.equal(captures[1].body.model, 'mimo-v2.5-tts-voiceclone')
  assert.deepEqual(captures[1].body.messages, [
    { role: 'user', content: '低声，紧张。' },
    { role: 'assistant', content: '别动。' },
  ])
  assert.equal(captures[1].body.audio.format, 'mp3')
  assert.match(captures[1].body.audio.voice, /^data:audio\/wav;base64,/)
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
    voiceDescription: '年轻男性，冷静克制，嗓音清亮。',
    name: '冷静男声',
  }, {
    config: {},
    secrets: { apiKey: 'test-key' },
  })

  assert.equal(captured.url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured.body.model, 'mimo-v2.5-tts-voicedesign')
  assert.equal(result.voices[0].name, '冷静男声')
  assert.match(result.voices[0].voiceId, /^mimo_/)
  assert.match(result.voices[0].previewAudioData, /^data:audio\/wav;base64,/)
})

test('Mimo provider uses voice_id data URLs with the voice clone model', async () => {
  const captured = await synthesizeWithMockedFetch({
    providerRequest: {
      voiceId: `data:audio/wav;base64,${Buffer.alloc(256, 1).toString('base64')}`,
      segment: {
        id: 'voice-id',
        text: '用保存的声音说话。',
      },
    },
  })

  assert.equal(captured.body.model, 'mimo-v2.5-tts-voiceclone')
  assert.match(captured.body.audio.voice, /^data:audio\/wav;base64,/)
})

test('Mimo provider exposes voice design capability metadata', async () => {
  const provider = new MimoTtsProvider()
  const voices = await provider.listVoices()
  assert.equal(provider.capabilities.voiceDesign, true)
  assert.equal(provider.capabilities.asr, true)
  assert.ok(voices.length > 0)
  assert.equal(voices[0].capabilities.voiceDesign, true)

  const providers = listProviderDefinitions()
  const mimoProviders = providers.filter(item => item.id === 'mimo')
  assert.equal(mimoProviders.length, 1)
  const [mimo] = mimoProviders
  assert.equal(mimo.capabilities.voiceDesign, true)
  assert.equal(mimo.capabilities.asr, true)
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
    audioData: Buffer.from('audio').toString('base64'),
    mimeType: 'audio/wav',
    language: 'zh',
    format: 'raw',
  }, {
    config: {},
    secrets: { apiKey: 'test-key' },
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].url, 'https://api.xiaomimimo.com/v1/chat/completions')
  assert.equal(captured[0].headers['api-key'], 'test-key')
  assert.equal(captured[0].body.model, 'mimo-v2.5-asr')
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
            transcript: providerRequest.segment.text,
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
    secrets: { apiKey: 'test-key' },
  })
  assert.equal(result.audio.length, 256)
  assert.equal(result.mimeType, providerRequest.outputFormat === 'mp3' ? 'audio/mpeg' : 'audio/wav')
  return returnAllCaptures ? captures : captures[0]
}
