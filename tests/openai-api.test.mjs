import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, before, test } from 'node:test'

let serverProcess
let baseUrl
let audioDir
let serverStdout = ''
let serverStderr = ''

before(async () => {
  const port = await getFreePort()
  audioDir = await mkdtemp(join(tmpdir(), 'voxout-openai-'))
  baseUrl = `http://127.0.0.1:${port}`
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
  const response = await fetch(`${baseUrl}/v1/models`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, 'list')
  const mimo = payload.data.find(model => model.id === 'mimo')
  assert.equal(mimo.object, 'model')
  assert.equal(mimo.owned_by, 'voxout')
  assert.equal(mimo.capabilities.tts, true)
  assert.equal(mimo.capabilities.asr, true)
  const openai = payload.data.find(model => model.id === 'openai')
  assert.equal(openai.capabilities.tts, true)
  assert.equal(openai.capabilities.asr, true)
  assert.equal(openai.capabilities.voiceClone, true)
  const defaultProvider = payload.data.find(model => model.id === 'default')
  assert.equal(defaultProvider.capabilities.tts, true)
  assert.equal(defaultProvider.capabilities.asr, true)
  const modelIds = payload.data.map(model => model.id)
  assert.ok(!modelIds.includes('edge'))
  assert.ok(!modelIds.includes('bilibili-asr'))
  assert.ok(!modelIds.includes('mock'))
  assert.ok(!modelIds.includes('mock-asr'))
})

test('GET /api/providers does not expose internal test providers', async () => {
  const response = await fetch(`${baseUrl}/api/providers`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  const providerIds = payload.providers.map(provider => provider.id)
  assert.ok(!providerIds.includes('mock'))
  assert.ok(!providerIds.includes('mock-asr'))
})

test('GET /api/providers/:id/voices returns provider voices', async () => {
  const response = await fetch(`${baseUrl}/api/providers/default/voices`)
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.ok(payload.voices.length > 0)
  assert.ok(payload.voices.some(voice => voice.id === 'zh-CN-XiaoyiNeural'))
})

test('POST /v1/audio/speech returns generated audio bytes', async () => {
  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
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

test('POST /v1/audio/speech streams generated audio bytes', async () => {
  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
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
  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
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

test('POST /v1/audio/effect returns generated audio bytes', async () => {
  const response = await fetch(`${baseUrl}/v1/audio/effect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
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

test('POST /v1/audio/isolation returns processed audio bytes', async () => {
  const form = new FormData()
  form.set('model', 'mock')
  form.set('audio', new Blob([createTinyWav()], { type: 'audio/wav' }), 'input.wav')

  const response = await fetch(`${baseUrl}/v1/audio/isolation`, {
    method: 'POST',
    body: form,
  })
  const audio = Buffer.from(await response.arrayBuffer())

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^audio\/wav/)
  assert.equal(audio.subarray(0, 4).toString('ascii'), 'RIFF')
})

test('POST /v1/audio/design persists generated voices', async () => {
  const response = await fetch(`${baseUrl}/v1/audio/design`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'mock',
      input: 'A calm narrator voice with a clean tone.',
      name: 'Calm Mock',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.provider, 'mock')
  assert.equal(payload.voices.length, 1)
  assert.equal(payload.voices[0].name, 'Calm Mock')
  assert.match(payload.voices[0].preview_audio, /^data:audio\/wav;base64,/)
  assert.equal(payload.voices[0].provider_links[0].provider, 'mock')
  assert.equal(payload.voices[0].provider_links[0].provider_voice_key, payload.voices[0].voice_id)

  const voicesResponse = await fetch(`${baseUrl}/api/voices?provider=mock`)
  const voicesPayload = await voicesResponse.json()
  assert.equal(voicesResponse.status, 200)
  assert.ok(voicesPayload.voices.some(voice => voice.voice_id === payload.voices[0].voice_id))
})

test('POST /v1/audio/voices clones and persists provider-linked voices', async () => {
  const form = new FormData()
  form.set('model', 'mock')
  form.set('name', 'Uploaded Mock')
  form.set('description', 'Uploaded voice sample')
  form.set('audio_sample', new Blob([createTinyWav()], { type: 'audio/wav' }), 'voice.wav')

  const response = await fetch(`${baseUrl}/v1/audio/voices`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.equal(payload.object, 'audio.voice')
  assert.equal(payload.name, 'Uploaded Mock')
  assert.match(payload.id, /^mock-clone-/)
  assert.equal(payload.voice.provider_links[0].provider, 'mock')
  assert.equal(payload.voice.provider_links[0].provider_voice_id, payload.id)

  const voicesResponse = await fetch(`${baseUrl}/api/voices?provider=mock`)
  const voicesPayload = await voicesResponse.json()
  assert.equal(voicesResponse.status, 200)
  assert.ok(voicesPayload.voices.some(voice => voice.voice_id === payload.id))
})

test('POST /v1/audio/speech rejects unsupported voice_id providers', async () => {
  const response = await fetch(`${baseUrl}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'default',
      input: 'hello',
      voice_id: 'not-supported',
    }),
  })
  const payload = await response.json()

  assert.equal(response.status, 400)
  assert.match(payload.error, /voice_id is not supported/)
})

test('POST /v1/audio/transcriptions accepts multipart file uploads', async () => {
  const form = new FormData()
  form.set('model', 'mock-asr')
  form.set('response_format', 'json')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const payload = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(payload, { text: 'Mock transcript for inline audio' })
})

test('POST /v1/audio/transcriptions supports text response format', async () => {
  const form = new FormData()
  form.set('model', 'mock-asr')
  form.set('response_format', 'text')
  form.set('file', new Blob([Buffer.from('fake audio bytes')], { type: 'audio/wav' }), 'sample.wav')

  const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
  })
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/plain/)
  assert.equal(text, 'Mock transcript for inline audio')
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
