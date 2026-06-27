import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { after, before, test } from 'node:test'

let serverProcess
let freesoundServer
let freesoundBaseUrl
let freesoundLastRequest
let base_url
let audioDir
let serverStdout = ''
let serverStderr = ''

before(async () => {
  const port = await getFreePort()
  const freesoundPort = await getFreePort()
  audioDir = await mkdtemp(join(tmpdir(), 'voxout-openai-'))
  base_url = `http://127.0.0.1:${port}`
  freesoundBaseUrl = `http://127.0.0.1:${freesoundPort}`
  freesoundServer = createFreesoundServer()
  freesoundServer.listen(freesoundPort, '127.0.0.1')
  await once(freesoundServer, 'listening')
  serverProcess = spawn(process.execPath, ['dist/server.js'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      DATABASE_URL: '',
      FREESOUND_API_BASE_URL: freesoundBaseUrl,
      FREESOUND_API_KEY: 'test-freesound-key',
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
  if (freesoundServer) {
    freesoundServer.close()
    await once(freesoundServer, 'close').catch(() => {})
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
  const openaiTtsModel = payload.data.find(model => model.id === 'gpt-4o-mini-tts')
  assert.equal(openaiTtsModel.object, 'model')
  assert.equal(openaiTtsModel.owned_by, 'openai')
  assert.equal(openaiTtsModel.capabilities.tts, true)
  assert.deepEqual(openaiTtsModel.providers, ['openai'])
  const stepfun = payload.data.find(model => model.id === 'stepfun')
  assert.equal(stepfun.object, 'model')
  assert.equal(stepfun.owned_by, 'voxout')
  assert.equal(stepfun.capabilities.tts, true)
  assert.equal(stepfun.capabilities.tts_streaming, true)
  assert.equal(stepfun.capabilities.asr, true)
  assert.equal(stepfun.capabilities.asr_streaming, true)
  assert.equal(stepfun.capabilities.voice_clone, true)
  const stepfunTtsModel = payload.data.find(model => model.id === 'step-tts-mini')
  assert.equal(stepfunTtsModel.owned_by, 'stepfun')
  assert.equal(stepfunTtsModel.capabilities.tts, true)
  assert.deepEqual(stepfunTtsModel.providers, ['stepfun'])
  const stepfunAsrModel = payload.data.find(model => model.id === 'stepaudio-2.5-asr')
  assert.equal(stepfunAsrModel.owned_by, 'stepfun')
  assert.equal(stepfunAsrModel.capabilities.asr, true)
  assert.deepEqual(stepfunAsrModel.providers, ['stepfun'])
  const openaiAsrModel = payload.data.find(model => model.id === 'gpt-4o-transcribe')
  assert.equal(openaiAsrModel.owned_by, 'openai')
  assert.equal(openaiAsrModel.capabilities.asr, true)
  assert.deepEqual(openaiAsrModel.providers, ['openai'])
  const elevenLabsTtsModel = payload.data.find(model => model.id === 'eleven_multilingual_v2')
  assert.equal(elevenLabsTtsModel.owned_by, 'elevenlabs')
  assert.equal(elevenLabsTtsModel.capabilities.tts, true)
  assert.deepEqual(elevenLabsTtsModel.providers, ['elevenlabs'])
  const elevenLabsEffectModel = payload.data.find(model => model.id === 'eleven_text_to_sound_v2')
  assert.equal(elevenLabsEffectModel.owned_by, 'elevenlabs')
  assert.equal(elevenLabsEffectModel.capabilities.sound_effects, true)
  assert.deepEqual(elevenLabsEffectModel.providers, ['elevenlabs'])
  const elevenLabsDesignModel = payload.data.find(model => model.id === 'eleven_multilingual_ttv_v2')
  assert.equal(elevenLabsDesignModel.owned_by, 'elevenlabs')
  assert.equal(elevenLabsDesignModel.capabilities.voice_design, true)
  assert.deepEqual(elevenLabsDesignModel.providers, ['elevenlabs'])
  const mimoDesignModel = payload.data.find(model => model.id === 'mimo-v2.5-tts-voicedesign')
  assert.equal(mimoDesignModel.owned_by, 'mimo')
  assert.equal(mimoDesignModel.capabilities.voice_design, true)
  assert.deepEqual(mimoDesignModel.providers, ['mimo'])
  const defaultProvider = payload.data.find(model => model.id === 'default')
  assert.equal(defaultProvider.capabilities.tts, true)
  assert.equal(defaultProvider.capabilities.tts_streaming, true)
  assert.equal(defaultProvider.capabilities.asr, true)
  const defaultAsrModel = payload.data.find(model => model.id === 'default-asr')
  assert.equal(defaultAsrModel.owned_by, 'default')
  assert.equal(defaultAsrModel.capabilities.asr, true)
  assert.deepEqual(defaultAsrModel.providers, ['default'])
  const modelIds = payload.data.map(model => model.id)
  assert.ok(!modelIds.includes('edge'))
  assert.ok(!modelIds.includes('bilibili-asr'))
  assert.ok(!modelIds.includes('8'))
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
  const mimo = payload.providers.find(provider => provider.id === 'mimo')
  assert.equal(mimo.capabilities.voice_design, true)
  assert.equal(mimo.capabilities.voice_clone, true)
  assert.ok(mimo.fields.some(field => field.key === 'auto_retry'))
  assert.ok(mimo.fields.some(field => field.key === 'retry_count'))
  const elevenlabs = payload.providers.find(provider => provider.id === 'elevenlabs')
  assert.equal(elevenlabs.capabilities.sound_effects, true)
  assert.equal(elevenlabs.capabilities.isolation, true)
  assert.equal(elevenlabs.capabilities.voice_design, true)
  assert.equal(elevenlabs.capabilities.voice_clone, true)
  assert.ok(!elevenlabs.fields.some(field => field.key === 'api_key'))
  const stepfun = payload.providers.find(provider => provider.id === 'stepfun')
  assert.equal(stepfun.capabilities.tts, true)
  assert.equal(stepfun.capabilities.tts_streaming, true)
  assert.equal(stepfun.capabilities.asr, true)
  assert.equal(stepfun.capabilities.asr_streaming, true)
  assert.equal(stepfun.capabilities.voice_clone, true)
  assert.ok(stepfun.fields.some(field => field.key === 'tts_model'))
  assert.ok(stepfun.fields.some(field => field.key === 'asr_model'))
  assert.ok(!stepfun.fields.some(field => field.key === 'api_key'))
  const defaultProvider = payload.providers.find(provider => provider.id === 'default')
  assert.ok(defaultProvider.fields.find(field => field.key === 'asr_model').options.includes('default-asr'))
  assert.ok(defaultProvider.fields.some(field => field.key === 'bcut_model_id'))
})

test('provider API keys can be created, updated, listed, and deleted', async () => {
  const createResponse = await fetch(`${base_url}/api/providers/openai/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'primary',
      api_key: 'sk-test-primary',
      weight: 3,
      enabled: true,
    }),
  })
  const createPayload = await createResponse.json()

  assert.equal(createResponse.status, 200)
  assert.equal(createPayload.api_key.name, 'primary')
  assert.equal(createPayload.api_key.weight, 3)
  assert.equal(createPayload.api_key.enabled, true)
  assert.equal(createPayload.api_key.key_hint, 'sk-t...mary')
  assert.equal(createPayload.api_key.api_key, undefined)

  const updateResponse = await fetch(`${base_url}/api/providers/openai/api-keys/${createPayload.api_key.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'backup',
      weight: 0,
      enabled: false,
    }),
  })
  const updatePayload = await updateResponse.json()
  assert.equal(updateResponse.status, 200)
  assert.equal(updatePayload.api_key.name, 'backup')
  assert.equal(updatePayload.api_key.weight, 0)
  assert.equal(updatePayload.api_key.enabled, false)
  assert.equal(updatePayload.api_key.key_hint, 'sk-t...mary')

  const listResponse = await fetch(`${base_url}/api/providers/openai/api-keys`)
  const listPayload = await listResponse.json()
  assert.equal(listResponse.status, 200)
  assert.ok(listPayload.api_keys.some(apiKey => apiKey.id === createPayload.api_key.id && apiKey.weight === 0))
  assert.ok(listPayload.api_keys.every(apiKey => apiKey.api_key === undefined))

  const deleteResponse = await fetch(`${base_url}/api/providers/openai/api-keys/${createPayload.api_key.id}`, {
    method: 'DELETE',
  })
  const deletePayload = await deleteResponse.json()
  assert.equal(deleteResponse.status, 200)
  assert.equal(deletePayload.deleted, true)

  const finalListResponse = await fetch(`${base_url}/api/providers/openai/api-keys`)
  const finalListPayload = await finalListResponse.json()
  assert.ok(!finalListPayload.api_keys.some(apiKey => apiKey.id === createPayload.api_key.id))
})

test('GET /api/search proxies Freesound search with public search parameters', async () => {
  const response = await fetch(`${base_url}/api/search?q=rain&page=2&page_size=999&sort=duration_desc&min_duration=1.5&max_duration=3&unknown=ignored`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.count, 1)
  assert.equal(payload.results[0].id, 123)
  assert.equal(payload.results[0].preview_url, 'https://example.com/rain.mp3')
  assert.equal(freesoundLastRequest.pathname, '/apiv2/search/')
  assert.equal(freesoundLastRequest.searchParams.get('query'), 'rain')
  assert.equal(freesoundLastRequest.searchParams.get('page'), '2')
  assert.equal(freesoundLastRequest.searchParams.get('page_size'), '150')
  assert.equal(freesoundLastRequest.searchParams.get('sort'), 'duration_desc')
  assert.equal(freesoundLastRequest.searchParams.get('filter'), 'duration:[1.5 TO 3]')
  assert.equal(freesoundLastRequest.searchParams.get('fields'), 'id,name,tags,username,license,url,previews,duration,type')
  assert.equal(freesoundLastRequest.searchParams.has('unknown'), false)
  assert.equal(freesoundLastRequest.authorization, 'Token test-freesound-key')
})

test('server errors use OpenAI-style error objects', async () => {
  const notFoundResponse = await fetch(`${base_url}/v1/not-found`)
  const notFoundPayload = await notFoundResponse.json()

  assert.equal(notFoundResponse.status, 404)
  assert.equal(errorMessage(notFoundPayload), 'Not found')
  assert.equal(notFoundPayload.error.type, 'not_found_error')
  assert.equal(notFoundPayload.error.param, null)
  assert.equal(notFoundPayload.error.code, null)

  const missingAudioResponse = await fetch(`${base_url}/audio/${'0'.repeat(64)}.wav`)
  const missingAudioPayload = await missingAudioResponse.json()

  assert.equal(missingAudioResponse.status, 404)
  assert.equal(errorMessage(missingAudioPayload), 'Audio not found')
  assert.equal(missingAudioPayload.error.type, 'not_found_error')
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
  assert.deepEqual(Object.keys(invalidSpeedPayload.error), ['message', 'type', 'param', 'code'])
  assert.equal(invalidSpeedPayload.error.type, 'invalid_request_error')
  assert.equal(invalidSpeedPayload.error.param, null)
  assert.equal(invalidSpeedPayload.error.code, null)
  assert.match(errorMessage(invalidSpeedPayload), /speed must be between 0\.25 and 4/)

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
  assert.match(errorMessage(invalidVoicePayload), /voice must be a string or object with id/)

  const unsupportedFieldResponse = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'hello',
      rate: '+10%',
    }),
  })
  const unsupportedFieldPayload = await unsupportedFieldResponse.json()
  assert.equal(unsupportedFieldResponse.status, 400)
  assert.match(errorMessage(unsupportedFieldPayload), /rate is not supported/)

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
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.response_format conflicts/)
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
  assert.match(errorMessage(payload), /openai api_key is required/)
})

test('POST /v1/audio/speech routes provider model ids to their provider', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'eleven_multilingual_v2',
      input: 'hello from an ElevenLabs model id',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(errorMessage(payload), /elevenlabs api_key is required/)
})

test('POST /v1/audio/speech routes StepFun model ids to StepFun', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'step-tts-mini',
      input: 'hello from a StepFun model id',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(errorMessage(payload), /stepfun api_key is required/)
})

test('POST /v1/audio/speech defaults MiMo response_format to mp3', async () => {
  const response = await fetch(`${base_url}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mimo',
      input: 'hello from mimo',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(errorMessage(payload), /mimo api_key is required/)
  assert.doesNotMatch(errorMessage(payload), /response_format/)
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
  assert.match(errorMessage(payload), /cannot synthesize response_format "flac"/)
})

test('POST /v1/audio/effect returns generated audio bytes', async () => {
  const response = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      instructions: 'a short test chime',
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

test('POST /v1/audio/effect converts WAV provider output to PCM', async () => {
  const response = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      instructions: 'a short test chime',
      duration_seconds: 0.5,
      response_format: 'pcm',
    }),
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/pcm/)
  assert.notEqual(audio.subarray(0, 4).toString('ascii'), 'RIFF')
  assert.ok(audio.length > 0)
})

test('POST /v1/audio/effect requires model or provider and OpenAI-style field names', async () => {
  const missingModelResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instructions: 'a short test chime',
      response_format: 'wav',
    }),
  })
  const missingModelPayload = await missingModelResponse.json()
  assert.equal(missingModelResponse.status, 400)
  assert.match(errorMessage(missingModelPayload), /model is required/)

  const unknownModelResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'not-a-sound-effect-model',
      instructions: 'a short test chime',
    }),
  })
  const unknownModelPayload = await unknownModelResponse.json()
  assert.equal(unknownModelResponse.status, 400)
  assert.match(errorMessage(unknownModelPayload), /Unknown sound effect model: not-a-sound-effect-model/)

  const legacyInputResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      input: 'a short test chime',
      response_format: 'wav',
    }),
  })
  const legacyInputPayload = await legacyInputResponse.json()
  assert.equal(legacyInputResponse.status, 400)
  assert.match(errorMessage(legacyInputPayload), /input is not supported/)

  const unsupportedFieldResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      instructions: 'a short test chime',
      voice_settings: { stability: 0.5 },
    }),
  })
  const unsupportedFieldPayload = await unsupportedFieldResponse.json()
  assert.equal(unsupportedFieldResponse.status, 400)
  assert.match(errorMessage(unsupportedFieldPayload), /voice_settings is not supported/)

  const unsupportedFormatResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      instructions: 'a short test chime',
      response_format: 'flac',
    }),
  })
  const unsupportedFormatPayload = await unsupportedFormatResponse.json()
  assert.equal(unsupportedFormatResponse.status, 400)
  assert.match(errorMessage(unsupportedFormatPayload), /cannot generate response_format "flac"/)

  const invalidDurationResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      instructions: 'a short test chime',
      duration_seconds: 90,
    }),
  })
  const invalidDurationPayload = await invalidDurationResponse.json()
  assert.equal(invalidDurationResponse.status, 400)
  assert.match(errorMessage(invalidDurationPayload), /duration_seconds must be between 0\.5 and 30/)

  const invalidInfluenceResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      instructions: 'a short test chime',
      prompt_influence: 2,
    }),
  })
  const invalidInfluencePayload = await invalidInfluenceResponse.json()
  assert.equal(invalidInfluenceResponse.status, 400)
  assert.match(errorMessage(invalidInfluencePayload), /prompt_influence must be between 0 and 1/)

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      instructions: 'a short test chime',
      extra_params: {
        duration_seconds: 0.5,
      },
    }),
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.duration_seconds conflicts/)
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
  for (const field of ['audio', 'url', 'audioData', 'mimeType']) {
    const form = new FormData()
    form.set('model', 'mock')
    if (field === 'audio') {
      form.set(field, new Blob([createTinyWav()], { type: 'audio/wav' }), 'input.wav')
    } else {
      form.set(field, field === 'url'
        ? 'https://example.com/audio.wav'
        : `data:audio/wav;base64,${createTinyWav().toString('base64')}`)
    }
    const response = await fetch(`${base_url}/v1/audio/isolation`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()

    assert.equal(response.status, 400)
    assert.match(errorMessage(payload), new RegExp(`${field} is not supported`))
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
  assert.match(errorMessage(invalidFormatPayload), /file_format must be "pcm_s16le_16" or "other"/)

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
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.file_format conflicts/)
})

test('POST /v1/audio/voices/design returns voice previews and create persists them', async () => {
  const response = await fetch(`${base_url}/v1/audio/voices/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      instructions: 'A calm narrator voice with a clean tone.',
      name: 'Calm Mock',
      input: 'This is a preview sentence.',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, 'list')
  assert.equal(payload.provider, undefined)
  assert.equal(payload.voices, undefined)
  assert.equal(payload.data.length, 1)
  assert.equal(payload.data[0].object, 'audio.voice.preview')
  assert.equal(payload.data[0].name, 'Calm Mock')
  assert.equal(payload.data[0].instructions, 'A calm narrator voice with a clean tone.')
  assert.equal(typeof payload.data[0].created_at, 'number')
  assert.equal(payload.data[0].generated_voice_id, payload.data[0].id)
  assert.match(payload.data[0].preview_audio, /^data:audio\/wav;base64,/)
  assert.equal(payload.data[0].provider_links, undefined)

  const voicesBeforeCreateResponse = await fetch(`${base_url}/api/voices?provider=mock`)
  const voicesBeforeCreatePayload = await voicesBeforeCreateResponse.json()
  assert.equal(voicesBeforeCreateResponse.status, 200)
  assert.equal(voicesBeforeCreatePayload.voices.some(voice => voice.voice_id === payload.data[0].id), false)

  const createResponse = await fetch(`${base_url}/v1/audio/voices/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      generated_voice_id: payload.data[0].generated_voice_id,
      name: payload.data[0].name,
      instructions: payload.data[0].instructions,
      labels: { source: 'test' },
    }),
  })
  const createPayload = await createResponse.json()
  assert.equal(createResponse.status, 200)
  assert.equal(createPayload.object, 'audio.voice')
  assert.equal(createPayload.id, payload.data[0].id)
  assert.equal(createPayload.name, 'Calm Mock')
  assert.equal(createPayload.preview_audio, undefined)
  assert.equal(createPayload.preview_mime_type, undefined)

  const voicesAfterCreateResponse = await fetch(`${base_url}/api/voices?provider=mock`)
  const voicesAfterCreatePayload = await voicesAfterCreateResponse.json()
  assert.equal(voicesAfterCreateResponse.status, 200)
  const storedVoice = voicesAfterCreatePayload.voices.find(voice => voice.voice_id === payload.data[0].id)
  assert.ok(storedVoice)
  assert.match(storedVoice.preview_audio, /^data:audio\/wav;base64,/)
  assert.equal(storedVoice.provider_links[0].provider, 'mock')
  assert.equal(storedVoice.provider_links[0].provider_voice_key, payload.data[0].id)
})

test('POST /v1/audio/voices/design requires model or provider and instructions fields', async () => {
  const legacyRouteResponse = await fetch(`${base_url}/v1/audio/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      instructions: 'A calm narrator voice.',
    }),
  })
  assert.equal(legacyRouteResponse.status, 404)

  const missingModelResponse = await fetch(`${base_url}/v1/audio/voices/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instructions: 'A calm narrator voice.',
      name: 'Legacy Provider',
    }),
  })
  const missingModelPayload = await missingModelResponse.json()
  assert.equal(missingModelResponse.status, 400)
  assert.match(errorMessage(missingModelPayload), /model is required/)

  const unknownModelResponse = await fetch(`${base_url}/v1/audio/voices/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'not-a-voice-design-model',
      instructions: 'A calm narrator voice.',
    }),
  })
  const unknownModelPayload = await unknownModelResponse.json()
  assert.equal(unknownModelResponse.status, 400)
  assert.match(errorMessage(unknownModelPayload), /Unknown voice design model: not-a-voice-design-model/)

  const legacyInputResponse = await fetch(`${base_url}/v1/audio/voices/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      text: 'A calm narrator voice.',
      name: 'Legacy Input',
    }),
  })
  const legacyInputPayload = await legacyInputResponse.json()
  assert.equal(legacyInputResponse.status, 400)
  assert.match(errorMessage(legacyInputPayload), /text is not supported/)

  const unsupportedFieldResponse = await fetch(`${base_url}/v1/audio/voices/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      instructions: 'A calm narrator voice.',
      style_prompt: 'warm',
    }),
  })
  const unsupportedFieldPayload = await unsupportedFieldResponse.json()
  assert.equal(unsupportedFieldResponse.status, 400)
  assert.match(errorMessage(unsupportedFieldPayload), /style_prompt is not supported/)

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/voices/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      instructions: 'A calm narrator voice.',
      input: 'Preview sample text.',
      extra_params: {
        instructions: 'Override prompt.',
      },
    }),
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.instructions conflicts/)
})

test('POST /v1/audio/voices/create validates OpenAI-style voice create fields', async () => {
  const missingPreviewResponse = await fetch(`${base_url}/v1/audio/voices/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      name: 'Calm Mock',
      instructions: 'A calm narrator voice.',
    }),
  })
  const missingPreviewPayload = await missingPreviewResponse.json()
  assert.equal(missingPreviewResponse.status, 400)
  assert.match(errorMessage(missingPreviewPayload), /generated_voice_id is required/)

  const legacyFieldResponse = await fetch(`${base_url}/v1/audio/voices/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      generated_voice_id: 'preview-id',
      voice_name: 'Calm Mock',
      instructions: 'A calm narrator voice.',
    }),
  })
  const legacyFieldPayload = await legacyFieldResponse.json()
  assert.equal(legacyFieldResponse.status, 400)
  assert.match(errorMessage(legacyFieldPayload), /voice_name is not supported/)

  const previewAudioResponse = await fetch(`${base_url}/v1/audio/voices/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      generated_voice_id: 'preview-id',
      name: 'Calm Mock',
      instructions: 'A calm narrator voice.',
      preview_audio: 'data:audio/wav;base64,AAAA',
    }),
  })
  const previewAudioPayload = await previewAudioResponse.json()
  assert.equal(previewAudioResponse.status, 400)
  assert.match(errorMessage(previewAudioPayload), /preview_audio is not supported/)

  const conflictingExtraParamsResponse = await fetch(`${base_url}/v1/audio/voices/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      provider: 'mock',
      generated_voice_id: 'preview-id',
      name: 'Calm Mock',
      instructions: 'A calm narrator voice.',
      extra_params: {
        generated_voice_id: 'other-id',
      },
    }),
  })
  const conflictingExtraParamsPayload = await conflictingExtraParamsResponse.json()
  assert.equal(conflictingExtraParamsResponse.status, 400)
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.generated_voice_id conflicts/)
})

test('POST /v1/audio/voices clones and persists provider-linked voices', async () => {
  const form = new FormData()
  form.set('provider', 'mock')
  form.set('name', 'Uploaded Mock')
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
  assert.match(errorMessage(legacyProviderPayload), /model is not supported/)

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
    assert.match(errorMessage(payload), new RegExp(`${field} is not supported`))
  }

  for (const field of ['url', 'audioData', 'mimeType']) {
    const form = new FormData()
    form.set('provider', 'mock')
    form.set('name', `Legacy ${field}`)
    form.set(field, field === 'url'
      ? 'https://example.com/sample.wav'
      : `data:audio/wav;base64,${createTinyWav().toString('base64')}`)
    const response = await fetch(`${base_url}/v1/audio/voices`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.match(errorMessage(payload), new RegExp(`${field} is not supported`))
  }

  for (const field of ['description', 'language', 'metadata', 'preview_text']) {
    const form = new FormData()
    form.set('provider', 'mock')
    form.set('name', `Unsupported ${field}`)
    form.set(field, field === 'metadata' ? '{"owner":"test-suite"}' : 'unsupported')
    form.set('audio_sample', new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')
    const response = await fetch(`${base_url}/v1/audio/voices`, {
      method: 'POST',
      body: form,
    })
    const payload = await response.json()
    assert.equal(response.status, 400)
    assert.match(errorMessage(payload), new RegExp(`${field} is not supported`))
  }

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
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.name conflicts/)

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
  assert.match(errorMessage(oversizedSamplePayload), /audio_sample must be 10 MiB or smaller/)
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
  assert.match(errorMessage(temperaturePayload), /temperature must be between 0 and 1/)

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
  assert.match(errorMessage(timestampsPayload), /timestamp_granularities requires response_format "verbose_json"/)

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
  assert.match(errorMessage(formatPayload), /response_format must be one of/)

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
  assert.match(errorMessage(streamPayload), /stream must be a boolean/)

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
  assert.match(errorMessage(conflictingExtraParamsPayload), /extra_params\.response_format conflicts/)
})

test('POST /v1/audio/transcriptions only accepts multipart file input', async () => {
  for (const field of ['url', 'audioData', 'mimeType']) {
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
    assert.match(errorMessage(payload), new RegExp(`${field} is not supported`))
  }
})

test('POST /v1/audio/transcriptions rejects legacy model aliases', async () => {
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
    assert.match(errorMessage(payload), new RegExp(`${field} is not supported`))
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

test('POST /v1/audio/transcriptions returns OpenAI-style verbose JSON words', async () => {
  const form = new FormData()
  form.set('provider', 'mock-asr')
  form.set('model', 'mock-asr-model')
  form.set('response_format', 'verbose_json')
  form.set('timestamp_granularities[]', 'word')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.text, 'Mock transcript for inline audio')
  assert.deepEqual(payload.words, [
    { word: 'Mock', start: 0, end: 0.25 },
    { word: 'transcript', start: 0.25, end: 0.75 },
  ])
  assert.equal(payload.words[0].from, undefined)
  assert.equal(payload.words[0].content, undefined)
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
  assert.match(errorMessage(payload), /Provider does not support streaming transcription/)
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
  assert.match(errorMessage(payload), /openai api_key is required/)
})

test('POST /v1/audio/transcriptions routes provider model ids to their provider', async () => {
  const form = new FormData()
  form.set('model', 'mimo-v2.5-asr')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(errorMessage(payload), /mimo api_key is required/)
})

test('POST /v1/audio/transcriptions routes StepFun model ids to StepFun', async () => {
  const form = new FormData()
  form.set('model', 'stepaudio-2.5-asr')
  form.set('file', new Blob([Buffer.alloc(256, 1)], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${base_url}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(errorMessage(payload), /stepfun api_key is required/)
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

function createFreesoundServer() {
  return createHttpServer((req, res) => {
    const url = new URL(req.url, freesoundBaseUrl)
    freesoundLastRequest = {
      pathname: url.pathname,
      searchParams: url.searchParams,
      authorization: req.headers.authorization,
    }
    if (url.pathname !== '/apiv2/search/') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ detail: 'not found' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      count: 1,
      next: null,
      previous: null,
      results: [{
        id: 123,
        name: 'Rain loop',
        tags: ['rain'],
        username: 'tester',
        license: 'Creative Commons 0',
        url: 'https://freesound.org/s/123/',
        previews: { 'preview-hq-mp3': 'https://example.com/rain.mp3' },
        duration: 2.5,
        type: 'wav',
      }],
    }))
  })
}

function createTinyWav() {
  return Buffer.from('UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=', 'base64')
}

function errorMessage(payload) {
  const error = payload?.error
  if (typeof error === 'string') return error
  if (error && typeof error.message === 'string') return error.message
  return ''
}
