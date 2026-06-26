import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { CambAiProvider } from '../dist/providers/cambai.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Camb.ai provider lists voices and falls back without an API key', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), headers: init.headers }
    return new Response(JSON.stringify([
      {
        id: 147320,
        voice_name: 'Gary',
        gender: 1,
        age: 35,
        language: 'en-us',
        description: 'Warm narrator',
        is_published: false,
      },
    ]), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new CambAiProvider()
  const fallback = await provider.listVoices()
  assert.equal(fallback[0].id, '147320')
  assert.equal(fallback[0].provider, 'cambai')

  const voices = await provider.listVoices({ secrets: { api_key: 'test-camb-key' } })
  assert.equal(captured.url, 'https://client.camb.ai/apis/list-voices')
  assert.equal(captured.headers['x-api-key'], 'test-camb-key')
  assert.equal(voices[0].id, '147320')
  assert.equal(voices[0].name, 'Gary')
  assert.equal(voices[0].gender, 'Male')
  assert.equal(voices[0].locale, 'en-us')
})

test('Camb.ai provider sends streaming TTS requests and buffers audio', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    }
    return new Response(Buffer.alloc(256, 1), {
      status: 200,
      headers: { 'content-type': 'audio/aac' },
    })
  }

  const provider = new CambAiProvider()
  const result = await provider.synthesize({
    id: 'tts',
    text: 'Hello from Camb.ai.',
    voice: '147320',
    lang: 'EN-US',
    output_format: 'aac',
    speed: 1.25,
    instructions: 'Warm and clear.',
    extra_params: {
      output_configuration: {
        sample_rate: 48000,
      },
      inference_options: {
        inference_steps: 40,
      },
    },
  }, {
    config: {
      tts_model: 'mars-instruct',
    },
    secrets: {
      api_key: 'test-camb-key',
    },
  })

  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/aac')
  assert.equal(captured.url, 'https://client.camb.ai/apis/tts-stream')
  assert.equal(captured.headers['x-api-key'], 'test-camb-key')
  assert.deepEqual(captured.body, {
    text: 'Hello from Camb.ai.',
    language: 'en-us',
    voice_id: 147320,
    speech_model: 'mars-instruct',
    user_instructions: 'Warm and clear.',
    output_configuration: {
      sample_rate: 48000,
      format: 'adts',
    },
    voice_settings: {
      speaking_rate: 1.25,
    },
    inference_options: {
      inference_steps: 40,
    },
  })
})

test('Camb.ai provider exposes raw audio streaming only', async () => {
  globalThis.fetch = async () => new Response(Buffer.alloc(256, 2), {
    status: 200,
    headers: { 'content-type': 'audio/wav' },
  })

  const provider = new CambAiProvider()
  const result = await provider.streamSynthesize({
    id: 'tts',
    text: 'stream this',
    voice: '147320',
    stream_format: 'audio',
  }, {
    secrets: { api_key: 'test-camb-key' },
  })

  assert.equal(result.mime_type, 'audio/wav')
  assert.equal((await readStreamBuffer(result.stream)).length, 256)
  await assert.rejects(
    () => provider.streamSynthesize({ id: 'tts', text: 'stream this', stream_format: 'sse' }, { secrets: { api_key: 'test-camb-key' } }),
    /stream_format "audio" only/,
  )
})

test('Camb.ai provider creates transcription tasks and returns segments', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/transcribe')) {
      return new Response(JSON.stringify({ task_id: 'transcribe-task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/transcribe/transcribe-task-1')) {
      return new Response(JSON.stringify({ status: 'SUCCESS', run_id: 123 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/transcription-result/123')) {
      return new Response(JSON.stringify([
        { start: 0, end: 0.5, text: 'Hello', speaker: 'S1' },
        { start: 0.5, end: 1, text: 'world', speaker: 'S1' },
      ]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }

  const provider = new CambAiProvider()
  const result = await provider.transcribe({
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    language: 'ZH-CN',
    format: 'raw',
    extra_params: {
      project_name: 'Transcript Job',
    },
  }, {
    config: {
      poll_interval_ms: 1,
      poll_attempts: 2,
    },
    secrets: { api_key: 'test-camb-key' },
  })

  const createCall = calls[0]
  assert.equal(createCall.url, 'https://client.camb.ai/apis/transcribe')
  assert.equal(createCall.init.headers['x-api-key'], 'test-camb-key')
  assert.equal(createCall.init.body.get('language'), 'zh-cn')
  assert.equal(createCall.init.body.get('project_name'), 'Transcript Job')
  assert.equal(createCall.init.body.get('media_file').type, 'audio/wav')
  assert.equal(result.text, 'Hello world')
  assert.deepEqual(result.segments, [
    { from: 0, to: 0.5, content: 'Hello' },
    { from: 0.5, to: 1, content: 'world' },
  ])
  assert.equal(result.raw.length, 2)
})

test('Camb.ai provider creates text-to-sound tasks and downloads audio', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/text-to-sound')) {
      return new Response(JSON.stringify({ task_id: 'sound-task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/text-to-sound/sound-task-1')) {
      return new Response(JSON.stringify({ status: 'SUCCESS', run_id: 456 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/text-to-sound-result/456')) {
      return new Response(Buffer.alloc(256, 3), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }

  const provider = new CambAiProvider()
  const result = await provider.createSoundEffect({
    prompt: 'single metal door slam',
    duration_seconds: 3.25,
    extra_params: {
      audio_type: 'music',
      project_description: 'test job',
    },
  }, {
    config: {
      poll_interval_ms: 1,
      poll_attempts: 2,
    },
    secrets: { api_key: 'test-camb-key' },
  })

  assert.deepEqual(JSON.parse(calls[0].init.body), {
    project_description: 'test job',
    prompt: 'single metal door slam',
    duration: 3.25,
    audio_type: 'music',
  })
  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/wav')
})

test('Camb.ai provider separates audio and returns the selected stem', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/audio-separation')) {
      return new Response(JSON.stringify({ task_id: 'separation-task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/audio-separation/separation-task-1')) {
      return new Response(JSON.stringify({ status: 'SUCCESS', run_id: 789 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/audio-separation-result/789')) {
      return new Response(JSON.stringify({
        foreground_audio_url: 'https://cdn.example.com/foreground.wav',
        background_audio_url: 'https://cdn.example.com/background.wav',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url) === 'https://cdn.example.com/background.wav') {
      return new Response(Buffer.alloc(256, 4), {
        status: 200,
        headers: { 'content-type': 'audio/wav' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }

  const provider = new CambAiProvider()
  const result = await provider.isolateAudio({
    file: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'mix.wav',
    },
    extra_params: {
      project_name: 'Separate It',
    },
  }, {
    config: {
      separation_stem: 'background',
      poll_interval_ms: 1,
      poll_attempts: 2,
    },
    secrets: { api_key: 'test-camb-key' },
  })

  assert.equal(calls[0].init.body.get('project_name'), 'Separate It')
  assert.equal(calls[0].init.body.get('media_file').type, 'audio/wav')
  assert.equal(result.audio.length, 256)
  assert.equal(result.mime_type, 'audio/wav')
})

test('Camb.ai provider designs voices and creates a custom voice from a preview', async () => {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/text-to-voice')) {
      return new Response(JSON.stringify({ task_id: 'voice-task-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/text-to-voice/voice-task-1')) {
      return new Response(JSON.stringify({ status: 'SUCCESS', run_id: 321 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).endsWith('/text-to-voice-result/321')) {
      return new Response(JSON.stringify({
        previews: ['https://cdn.example.com/preview-a.mp3', 'https://cdn.example.com/preview-b.mp3'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    if (String(url).startsWith('https://cdn.example.com/preview-')) {
      return new Response(Buffer.alloc(256, 5), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    }
    if (String(url).endsWith('/create-custom-voice')) {
      return new Response(JSON.stringify({ voice_id: 654 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    throw new Error(`unexpected url ${url}`)
  }

  const provider = new CambAiProvider()
  const design = await provider.designVoice({
    instructions: 'A warm and friendly middle-aged narrator with a bright tone, precise diction, and calm documentary pacing for explainers.',
    name: 'Warm Guide',
    input: 'Welcome to the product tour.',
  }, {
    config: {
      poll_interval_ms: 1,
      poll_attempts: 2,
    },
    secrets: { api_key: 'test-camb-key' },
  })

  assert.equal(design.voices.length, 2)
  assert.equal(design.voices[0].voice_id, 'cambai-preview-321-1')
  assert.match(design.voices[0].preview_audio_data, /^data:audio\/mpeg;base64,/)
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    text: 'Welcome to the product tour.',
    voice_description: 'A warm and friendly middle-aged narrator with a bright tone, precise diction, and calm documentary pacing for explainers.',
  })

  const created = await provider.createDesignedVoice({
    generated_voice_id: design.voices[0].provider_voice_id,
    name: 'Warm Guide',
    instructions: design.voices[0].description,
    preview_audio_data: design.voices[0].preview_audio_data,
    preview_mime_type: design.voices[0].preview_mime_type,
    language: 'en-us',
    extra_params: {
      gender: 2,
      age: 34,
      enhance_audio: true,
    },
  }, {
    secrets: { api_key: 'test-camb-key' },
  })

  const createVoiceCall = calls.find(call => call.url.endsWith('/create-custom-voice'))
  assert.equal(createVoiceCall.init.body.get('voice_name'), 'Warm Guide')
  assert.equal(createVoiceCall.init.body.get('gender'), '2')
  assert.equal(createVoiceCall.init.body.get('age'), '34')
  assert.equal(createVoiceCall.init.body.get('enhance_audio'), 'true')
  assert.equal(createVoiceCall.init.body.get('language'), 'en-us')
  assert.equal(createVoiceCall.init.body.get('file').type, 'audio/mpeg')
  assert.equal(created.voice.voice_id, '654')
  assert.equal(created.voice.provider_voice_id, '654')
  assert.equal(created.voice.preview_mime_type, 'audio/mpeg')
})

test('Camb.ai provider clones voices with create-custom-voice', async () => {
  let captured
  globalThis.fetch = async (url, init = {}) => {
    captured = { url: String(url), init }
    return new Response(JSON.stringify({ voice_id: 999 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new CambAiProvider()
  const result = await provider.cloneVoice({
    name: 'Narrator Clone',
    audio_sample: {
      data: Buffer.alloc(256, 1),
      mime_type: 'audio/wav',
      file_name: 'sample.wav',
    },
    extra_params: {
      description: 'Clean sample',
      language: 'EN-US',
      gender: 1,
      age: 42,
    },
  }, {
    secrets: { api_key: 'test-camb-key' },
  })

  assert.equal(captured.url, 'https://client.camb.ai/apis/create-custom-voice')
  assert.equal(captured.init.headers['x-api-key'], 'test-camb-key')
  assert.equal(captured.init.body.get('voice_name'), 'Narrator Clone')
  assert.equal(captured.init.body.get('description'), 'Clean sample')
  assert.equal(captured.init.body.get('language'), 'en-us')
  assert.equal(captured.init.body.get('gender'), '1')
  assert.equal(captured.init.body.get('age'), '42')
  assert.equal(captured.init.body.get('file').type, 'audio/wav')
  assert.equal(result.voice.voice_id, '999')
  assert.equal(result.voice.provider_voice_id, '999')
})

test('Camb.ai provider exposes multi-API metadata', () => {
  const provider = new CambAiProvider()
  assert.equal(provider.capabilities.tts, true)
  assert.equal(provider.capabilities.tts_streaming, true)
  assert.equal(provider.capabilities.asr, true)
  assert.equal(provider.capabilities.sound_effects, true)
  assert.equal(provider.capabilities.isolation, true)
  assert.equal(provider.capabilities.voice_design, true)
  assert.equal(provider.capabilities.voice_clone, true)

  const providers = listProviderDefinitions()
  const cambai = providers.find(item => item.id === 'cambai')
  assert.equal(cambai.name, 'Camb.ai')
  assert.equal(cambai.capabilities.tts, true)
  assert.equal(cambai.capabilities.asr, true)
  assert.equal(cambai.capabilities.sound_effects, true)
  assert.equal(cambai.capabilities.voice_design, true)
  assert.equal(cambai.capabilities.voice_clone, true)
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
