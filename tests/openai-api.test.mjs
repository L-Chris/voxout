import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'

let serverProcess
let base_url
let audioDir
let serverStdout = ''
let serverStderr = ''

before(async () => {
  const port = await getFreePort()
  audioDir = await mkdtemp(join(tmpdir(), 'voxout-openai-'))
  base_url = `http://127.0.0.1:${port}`
  serverProcess = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: '',
      NODE_ENV: 'test',
      PORT: String(port),
      TTS_AUDIO_DIR: audioDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  serverProcess.stdout.setEncoding('utf8')
  serverProcess.stdout.on('data', chunk => { serverStdout += chunk })
  serverProcess.stderr.setEncoding('utf8')
  serverProcess.stderr.on('data', chunk => { serverStderr += chunk })

  await waitForServer(serverProcess)
})

after(async () => {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill()
    await once(serverProcess, 'exit').catch(() => {})
  }
  if (audioDir) await rm(audioDir, { recursive: true, force: true })
})

test('GET /v1/models returns OpenAI-style model objects', async () => {
  const response = await fetch(`${base_url}/v1/models`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, 'list')
  const mimo = payload.data.find(model => model.id === 'mimo')
  assert.equal(mimo.object, 'model')
  assert.equal(mimo.owned_by, 'voxout')
  assert.equal(mimo.capabilities.tts, true)
  assert.equal(mimo.capabilities.asr, true)
  assert.equal(mimo.capabilities.asr_streaming, true)
  const openai = payload.data.find(model => model.id === 'openai')
  assert.equal(openai.capabilities.tts, true)
  assert.equal(openai.capabilities.asr, true)
  assert.equal(openai.capabilities.asr_streaming, true)
  assert.equal(openai.capabilities.voice_clone, true)
  const defaultProvider = payload.data.find(model => model.id === 'default')
  assert.equal(defaultProvider.capabilities.tts, true)
  assert.equal(defaultProvider.capabilities.tts_streaming, true)
  assert.equal(defaultProvider.capabilities.asr, undefined)
  const modelIds = payload.data.map(model => model.id)
  assert.ok(!modelIds.includes('edge'))
  assert.ok(!modelIds.includes('bilibili-asr'))
  assert.ok(!modelIds.includes('mock'))
  assert.ok(!modelIds.includes('mock-asr'))
})

test('GET /api/providers does not expose internal test providers', async () => {
  const response = await fetch(`${base_url}/api/providers`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  const providerIds = payload.providers.map(provider => provider.id)
  assert.ok(!providerIds.includes('mock'))
  assert.ok(!providerIds.includes('mock-asr'))
})

test('GET /api/providers/:id/voices returns provider voices', async () => {
  const response = await fetch(`${base_url}/api/providers/default/voices`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.ok(payload.voices.length > 0)
  assert.ok(payload.voices.some(voice => voice.id === 'zh-CN-XiaoyiNeural'))
})

test('POST /v1/audio/speech returns generated audio bytes', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello from openai compatible speech',
      voice: 'mock-narrator',
      response_format: 'wav',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE')
})

test('POST /v1/audio/speech accepts OpenAI custom voice objects', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello from a custom voice object',
      voice: { id: 'mock-dialogue' },
      speed: 1.25,
      response_format: 'wav',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
})

test('POST /v1/audio/speech validates OpenAI speech parameters', async () => {
  const invalidSpeedResponse = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello',
      speed: 8,
    }),
  })
  const invalidSpeedPayload = await invalidSpeedResponse.json()
  assert.equal(invalidSpeedResponse.status, 400)
  assert.match(invalidSpeedPayload.error, /speed must be between 0\.25 and 4/)

  const invalidVoiceResponse = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello',
      voice: { name: 'not an id' },
    }),
  })
  const invalidVoicePayload = await invalidVoiceResponse.json()
  assert.equal(invalidVoiceResponse.status, 400)
  assert.match(invalidVoicePayload.error, /voice must be a string or object with id/)

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello',
      extra_params: {
        response_format: 'wav',
      },
    }),
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(conflictingExtraParamsPayload.error, /extra_params\.response_format conflicts/)
})

test('POST /v1/audio/speech accepts provider extension with OpenAI-style model', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: 'test-tts-model',
      input: 'hello with provider extension',
      voice: 'mock-narrator',
      response_format: 'wav',
      instructions: 'Speak clearly.',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE')
})

test('POST /v1/audio/speech treats OpenAI speech models as models, not providers', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts',
      input: 'hello from openai model routing',
      voice: 'alloy',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(payload.error, /openai api_key is required/)
})

test('POST /v1/audio/speech streams generated audio bytes', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello from openai compatible speech',
      voice: 'mock-narrator',
      response_format: 'wav',
      stream_format: 'audio',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE')
})

test('POST /v1/audio/speech streams SSE events', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello from openai compatible speech',
      voice: 'mock-narrator',
      response_format: 'wav',
      stream_format: 'sse',
    }),
  })
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/event-stream/)
  assert.match(text, /audio\.delta/)
  assert.match(text, /\[DONE\]/)
})

test('POST /v1/audio/speech converts WAV provider output to PCM', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'hello from openai compatible speech',
      voice: 'mock-narrator',
      response_format: 'pcm',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/pcm/)
  assert.notEqual(audio.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.ok(audio.length > 0)
})

test('POST /v1/audio/speech rejects unsupported provider response formats', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'hello from openai compatible speech',
      voice: 'mock-narrator',
      response_format: 'flac',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(payload.error, /cannot synthesize response_format "flac"/)
})

test('POST /v1/audio/effect returns generated audio bytes', async () => {
  const response = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: 'mock-effect-model',
      input: 'a short test chime',
      duration_seconds: 0.5,
      response_format: 'wav',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.equal(audio.subarray(8, 12).toString('ascii'), 'WAVE')
})

test('POST /v1/audio/effect requires provider and OpenAI-style field names', async () => {
  const legacyProviderResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'a short test chime',
      response_format: 'wav',
    }),
  })
  assert.equal(legacyProviderResponse.status, 400)

  const legacyInputResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      prompt: 'a short test chime',
      response_format: 'wav',
    }),
  })
  assert.equal(legacyInputResponse.status, 400)

  const invalidDurationResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'a short test chime',
      duration_seconds: 90,
    }),
  })
  const invalidDurationPayload = await invalidDurationResponse.json()
  assert.equal(invalidDurationResponse.status, 400)
  assert.match(invalidDurationPayload.error, /duration_seconds must be between 0\.5 and 30/)

  const invalidInfluenceResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'a short test chime',
      prompt_influence: 2,
    }),
  })
  const invalidInfluencePayload = await invalidInfluenceResponse.json()
  assert.equal(invalidInfluenceResponse.status, 400)
  assert.match(invalidInfluencePayload.error, /prompt_influence must be between 0 and 1/)

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'a short test chime',
      extra_params: {
        duration_seconds: 0.5,
      },
    }),
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(conflictingExtraParamsPayload.error, /extra_params\.duration_seconds conflicts/)
})

test('POST /v1/audio/isolation returns processed audio bytes', async () => {
  const form = new FormData()
  form.set('model', 'mock')
  form.set('file', new Blob([createTinyWav()], { type: 'audio/wav' }), 'input.wav')

  const response = await fetch(`${base_url}/v1/audio/isolation`, {
    method: 'POST',
    body: form,
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
})

test('POST /v1/audio/isolation only accepts multipart file input', async () => {
  const legacyForms = [
    (() => {
      const form = new FormData()
      form.set('model', 'mock')
      form.set('audio', new Blob([createTinyWav()], { type: 'audio/wav' }), 'input.wav')
      return form
    })(),
    (() => {
      const form = new FormData()
      form.set('model', 'mock')
      form.set('url', 'https://example.com/audio.wav')
      return form
    })(),
    (() => {
      const form = new FormData()
      form.set('model', 'mock')
      form.set('audioData', `data:audio/wav;base64,${createTinyWav().toString('base64')}`)
      form.set('mime_type', 'audio/wav')
      return form
    })(),
  ]

  for (const form of legacyForms) {
    const response = await fetch(`${base_url}/v1/audio/isolation`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()

    assert.equal(response.status, 400)
    assert.match(payload.error, /file is required/)
  }

  const invalidFormat = new FormData()
  invalidFormat.set('model', 'mock')
  invalidFormat.set('file', new Blob([createTinyWav()], { type: 'audio/wav' }), 'input.wav')
  invalidFormat.set('file_format', 'wav')
  const invalidFormatResponse = await fetch(`${base_url}/v1/audio/isolation`, {
    method: 'POST',
    body: invalidFormat,
  })
  const invalidFormatPayload = await invalidFormatResponse.json()
  assert.equal(invalidFormatResponse.status, 400)
  assert.match(invalidFormatPayload.error, /file_format must be "pcm_s16le_16" or "other"/)

  const conflictingExtraParams = new FormData()
  conflictingExtraParams.set('model', 'mock')
  conflictingExtraParams.set('file', new Blob([createTinyWav()], { type: 'audio/wav' }), 'input.wav')
  conflictingExtraParams.set('extra_params', JSON.stringify({ file_format: 'other' }))
  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/isolation`, {
    method: 'POST',
    body: conflictingExtraParams,
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(conflictingExtraParamsPayload.error, /extra_params\.file_format conflicts/)
})

test('POST /v1/audio/design persists generated voices', async () => {
  const response = await fetch(`${base_url}/v1/audio/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      model: 'mock-design-model',
      input: 'A calm narrator voice with a clean tone.',
      name: 'Calm Mock',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, 'list')
  assert.equal(payload.provider, undefined)
  assert.equal(payload.voices, undefined)
  assert.equal(payload.data.length, 1)
  assert.equal(payload.data[0].object, 'audio.voice')
  assert.equal(payload.data[0].name, 'Calm Mock')
  assert.equal(typeof payload.data[0].created_at, 'number')
  assert.match(payload.data[0].preview_audio, /^data:audio\/wav;base64,/)
  assert.equal(payload.data[0].provider_links, undefined)

  const voicesResponse = await fetch(`${base_url}/api/voices?provider=mock`)
  const voicesPayload = await voicesResponse.json()
  assert.equal(voicesResponse.status, 200)
  const storedVoice = voicesPayload.voices.find(voice => voice.voice_id === payload.data[0].id)
  assert.ok(storedVoice)
  assert.equal(storedVoice.provider_links[0].provider, 'mock')
  assert.equal(storedVoice.provider_links[0].provider_voice_key, payload.data[0].id)
})

test('POST /v1/audio/design requires provider and input fields', async () => {
  const legacyProviderResponse = await fetch(`${base_url}/v1/audio/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'A calm narrator voice.',
      name: 'Legacy Provider',
    }),
  })
  assert.equal(legacyProviderResponse.status, 400)

  const legacyInputResponse = await fetch(`${base_url}/v1/audio/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      voice_description: 'A calm narrator voice.',
      name: 'Legacy Input',
    }),
  })
  assert.equal(legacyInputResponse.status, 400)

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'A calm narrator voice.',
      extra_params: {
        input: 'Override prompt.',
      },
    }),
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(conflictingExtraParamsPayload.error, /extra_params\.input conflicts/)
})

test('POST /v1/audio/voices clones and persists provider-linked voices', async () => {
  const form = new FormData()
  form.set('provider', 'mock')
  form.set('name', 'Uploaded Mock')
  form.set('description', 'Uploaded sample voice')
  form.set('language', 'zh-CN')
  form.set('preview_text', 'Preview text sample')
  form.set('metadata', JSON.stringify({ owner: 'test-suite' }))
  form.set('audio_sample', new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')

  const response = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, 'audio.voice')
  assert.equal(payload.name, 'Uploaded Mock')
  assert.match(payload.id, /^mock-clone-/)
  assert.equal(typeof payload.created_at, 'number')
  assert.equal(payload.provider, undefined)
  assert.equal(payload.voice, undefined)

  const voicesResponse = await fetch(`${base_url}/api/voices?provider=mock`)
  const voicesPayload = await voicesResponse.json()
  assert.equal(voicesResponse.status, 200)
  const storedVoice = voicesPayload.voices.find(voice => voice.voice_id === payload.id)
  assert.ok(storedVoice)
  assert.equal(storedVoice.description, 'Uploaded sample voice')
  assert.equal(storedVoice.language, 'zh-CN')
  assert.equal(storedVoice.metadata.owner, 'test-suite')
  assert.equal(storedVoice.metadata.preview_text, 'Preview text sample')
})

test('POST /v1/audio/voices only accepts OpenAI voice form fields', async () => {
  const legacyProvider = new FormData()
  legacyProvider.set('model', 'mock')
  legacyProvider.set('name', 'Legacy Provider')
  legacyProvider.set('audio_sample', new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')
  const legacyProviderResponse = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: legacyProvider,
  })
  const legacyProviderPayload = await legacyProviderResponse.json()
  assert.equal(legacyProviderResponse.status, 400)
  assert.match(legacyProviderPayload.error, /Provider is disabled: openai|openai api_key is required|Unknown provider/)

  for (const field of ['file', 'audio']) {
    const form = new FormData()
    form.set('provider', 'mock')
    form.set('name', `Legacy ${field}`)
    form.set(field, new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')
    const response = await fetch(`${base_url}/v1/audio/voices`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.match(payload.error, /audio_sample is required/)
  }

  const urlForm = new FormData()
  urlForm.set('provider', 'mock')
  urlForm.set('name', 'Legacy URL')
  urlForm.set('url', 'https://example.com/sample.wav')
  const urlResponse = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: urlForm,
  })
  const urlPayload = await urlResponse.json()
  assert.equal(urlResponse.status, 400)
  assert.match(urlPayload.error, /audio_sample is required/)

  const legacyDataForm = new FormData()
  legacyDataForm.set('provider', 'mock')
  legacyDataForm.set('name', 'Legacy Audio Data')
  legacyDataForm.set('audioData', `data:audio/wav;base64,${createTinyWav().toString('base64')}`)
  const legacyDataResponse = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: legacyDataForm,
  })
  const legacyDataPayload = await legacyDataResponse.json()
  assert.equal(legacyDataResponse.status, 400)
  assert.match(legacyDataPayload.error, /audio_sample is required/)

  const invalidMetadata = new FormData()
  invalidMetadata.set('provider', 'mock')
  invalidMetadata.set('name', 'Invalid Metadata')
  invalidMetadata.set('metadata', '[1,2,3]')
  invalidMetadata.set('audio_sample', new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')
  const invalidMetadataResponse = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: invalidMetadata,
  })
  const invalidMetadataPayload = await invalidMetadataResponse.json()
  assert.equal(invalidMetadataResponse.status, 400)
  assert.match(invalidMetadataPayload.error, /metadata must be a JSON object/)

  const conflictingExtraParams = new FormData()
  conflictingExtraParams.set('provider', 'mock')
  conflictingExtraParams.set('name', 'Conflicting Extra Params')
  conflictingExtraParams.set('extra_params', JSON.stringify({ name: 'Override Name' }))
  conflictingExtraParams.set('audio_sample', new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')
  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: conflictingExtraParams,
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(conflictingExtraParamsPayload.error, /extra_params\.name conflicts/)

  const oversizedSample = new FormData()
  oversizedSample.set('provider', 'mock')
  oversizedSample.set('name', 'Oversized Sample')
  oversizedSample.set('audio_sample', new Blob([Buffer.alloc(10 * 1024 * 1024 + 1)], { type: 'audio/wav' }), 'voice.wav')
  const oversizedSampleResponse = await fetch(`${base_url}/v1/audio/voices`, {
    method: 'POST',
    body: oversizedSample,
  })
  const oversizedSamplePayload = await oversizedSampleResponse.json()
  assert.equal(oversizedSampleResponse.status, 400)
  assert.match(oversizedSamplePayload.error, /audio_sample must be 10 MiB or smaller/)
})

test('POST /v1/audio/transcriptions accepts multipart file uploads', async () => {
  const form = new FormData()
  form.set('provider', 'mock-asr')
  form.set('model', 'mock-asr-model')
  form.set('response_format', 'json')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(payload, { text: 'Mock transcript for inline audio' })
})

test('POST /v1/audio/transcriptions validates OpenAI transcription parameters', async () => {
  const temperatureForm = new FormData()
  temperatureForm.set('provider', 'mock-asr')
  temperatureForm.set('model', 'mock-asr-model')
  temperatureForm.set('temperature', '2')
  temperatureForm.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const temperatureResponse = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: temperatureForm,
  })
  const temperaturePayload = await temperatureResponse.json()
  assert.equal(temperatureResponse.status, 400)
  assert.match(temperaturePayload.error, /temperature must be between 0 and 1/)

  const timestampsForm = new FormData()
  timestampsForm.set('provider', 'mock-asr')
  timestampsForm.set('model', 'mock-asr-model')
  timestampsForm.set('timestamp_granularities[]', 'word')
  timestampsForm.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const timestampsResponse = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: timestampsForm,
  })
  const timestampsPayload = await timestampsResponse.json()
  assert.equal(timestampsResponse.status, 400)
  assert.match(timestampsPayload.error, /timestamp_granularities requires response_format "verbose_json"/)

  const formatForm = new FormData()
  formatForm.set('provider', 'mock-asr')
  formatForm.set('model', 'mock-asr-model')
  formatForm.set('response_format', 'mp3')
  formatForm.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const formatResponse = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: formatForm,
  })
  const formatPayload = await formatResponse.json()
  assert.equal(formatResponse.status, 400)
  assert.match(formatPayload.error, /response_format must be one of/)

  const streamForm = new FormData()
  streamForm.set('provider', 'mock-asr')
  streamForm.set('model', 'mock-asr-model')
  streamForm.set('stream', 'maybe')
  streamForm.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const streamResponse = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: streamForm,
  })
  const streamPayload = await streamResponse.json()
  assert.equal(streamResponse.status, 400)
  assert.match(streamPayload.error, /stream must be a boolean/)

  const conflictingExtraParamsForm = new FormData()
  conflictingExtraParamsForm.set('provider', 'mock-asr')
  conflictingExtraParamsForm.set('model', 'mock-asr-model')
  conflictingExtraParamsForm.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')
  conflictingExtraParamsForm.set('extra_params', JSON.stringify({ response_format: 'text' }))

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: conflictingExtraParamsForm,
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(conflictingExtraParamsPayload.error, /extra_params\.response_format conflicts/)
})

test('POST /v1/audio/transcriptions only accepts multipart file input', async () => {
  for (const field of ['url', 'audioData']) {
    const form = new FormData()
    form.set('provider', 'mock-asr')
    form.set('model', 'mock-asr-model')
    form.set(field, field === 'url'
      ? 'https://example.com/audio.wav'
      : `data:audio/wav;base64,${createTinyWav().toString('base64')}`)

    const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()

    assert.equal(response.status, 400)
    assert.match(payload.error, /file is required/)
  }
})

test('POST /v1/audio/transcriptions ignores legacy model aliases', async () => {
  for (const field of ['model_id', 'asr_model']) {
    const form = new FormData()
    form.set(field, 'gpt-4o-transcribe')
    form.set('response_format', 'json')
    form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

    const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()

    assert.equal(response.status, 400)
    assert.match(payload.error, /model is required/)
  }
})

test('POST /v1/audio/transcriptions supports text response format', async () => {
  const form = new FormData()
  form.set('provider', 'mock-asr')
  form.set('model', 'mock-asr-model')
  form.set('response_format', 'text')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/plain/)
  assert.equal(text, 'Mock transcript for inline audio')
})

test('POST /v1/audio/transcriptions returns OpenAI-style verbose JSON segments', async () => {
  const form = new FormData()
  form.set('provider', 'mock-asr')
  form.set('model', 'mock-asr-model')
  form.set('response_format', 'verbose_json')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.text, 'Mock transcript for inline audio')
  assert.deepEqual(payload.segments, [{
    id: 0,
    start: 0,
    end: 1.25,
    text: 'Mock transcript for inline audio',
  }])
  assert.equal(payload.raw, undefined)
  assert.equal(payload.segments[0].from, undefined)
  assert.equal(payload.segments[0].content, undefined)
})

test('POST /v1/audio/transcriptions rejects unsupported streaming providers', async () => {
  const form = new FormData()
  form.set('provider', 'mock-asr')
  form.set('model', 'mock-asr-model')
  form.set('stream', 'true')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(payload.error, /Provider does not support streaming transcription/)
})

test('POST /v1/audio/transcriptions converts provider segments to VTT', async () => {
  const form = new FormData()
  form.set('provider', 'mock-asr')
  form.set('model', 'mock-asr-model')
  form.set('response_format', 'vtt')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/vtt/)
  assert.match(text, /^WEBVTT/)
  assert.match(text, /00:00:00\.000 --> 00:00:01\.250/)
  assert.match(text, /Mock transcript for inline audio/)
})

test('POST /v1/audio/transcriptions treats OpenAI ASR models as models, not providers', async () => {
  const form = new FormData()
  form.set('model', 'gpt-4o-transcribe')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(payload.error, /openai api_key is required/)
})

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => reject(new Error('server did not start in time')), 5000)

    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`server exited before ready with code ${code}\nstdout:\n${serverStdout}\nstderr:\n${serverStderr}`))
    })

    child.stdout.on('data', chunk => {
      if (chunk.includes('voxout listening')) {
        settled = true
        clearTimeout(timer)
        resolve()
      }
    })
  })
}

async function getFreePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  server.close()
  await once(server, 'close')
  return address.port
}

function createTinyWav() {
  return Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64')
}
