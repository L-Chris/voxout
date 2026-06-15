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
  audioDir = await mkdtemp(join(tmpdir(), 'voxout-head-'))
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

test('HEAD returns headers without a body for public files', async () => {
  const response = await fetch(`${base_url}/`, { method: 'HEAD' })

  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^text\/html/)
  assert.ok(Number(response.headers.get('content-length')) > 0)
  assert.equal(await response.text(), '')
})

test('HEAD returns headers without a body for JSON endpoints', async () => {
  for (const pathname of ['/health', '/api/providers', '/v1/models']) {
    const response = await fetch(`${base_url}${pathname}`, { method: 'HEAD' })

    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /^application\/json/)
    assert.ok(Number(response.headers.get('content-length')) > 0)
    assert.equal(await response.text(), '')
  }
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
