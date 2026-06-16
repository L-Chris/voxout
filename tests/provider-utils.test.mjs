import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { logProviderResponseError } from '../dist/providers/provider-utils.js'
import { getProviderRetryCount } from '../dist/timeout.js'
import { withProviderRetry } from '../dist/server/audio.service.js'

const originalConsoleError = console.error

afterEach(() => {
  console.error = originalConsoleError
})

test('provider upstream error logs are structured and redact sensitive URL params', () => {
  const logs = []
  console.error = message => logs.push(message)

  const response = new Response('bad request', {
    status: 400,
    statusText: 'Bad Request',
  })
  Object.defineProperty(response, 'url', {
    value: 'https://example.com/audio?api_key=secret&model=test&token=private',
  })

  logProviderResponseError('openai', 'speech', response, 'upstream said no')

  assert.equal(logs.length, 1)
  const payload = JSON.parse(logs[0])
  assert.equal(payload.event, 'provider_upstream_error')
  assert.equal(payload.provider, 'openai')
  assert.equal(payload.operation, 'speech')
  assert.equal(payload.status, 400)
  assert.equal(payload.status_text, 'Bad Request')
  assert.equal(payload.detail, 'upstream said no')
  assert.equal(payload.url, 'https://example.com/audio?api_key=%5Bredacted%5D&model=test&token=%5Bredacted%5D')
})

test('provider retry count requires auto_retry and is capped', () => {
  assert.equal(getProviderRetryCount({ config: {} }), 0)
  assert.equal(getProviderRetryCount({ config: { auto_retry: true } }), 2)
  assert.equal(getProviderRetryCount({ config: { auto_retry: true, retry_count: 3 } }), 3)
  assert.equal(getProviderRetryCount({ config: { auto_retry: true, retry_count: 99 } }), 5)
  assert.equal(getProviderRetryCount({ config: { auto_retry: false, retry_count: 3 } }), 0)
})

test('provider retry wrapper retries transient failures when enabled', async () => {
  const logs = []
  console.error = message => logs.push(message)
  let attempts = 0
  const result = await withProviderRetry('mock', 'speech', {
    config: { auto_retry: true, retry_count: 1 },
    secrets: {},
    enabled: true,
  }, 1000, async () => {
    attempts += 1
    if (attempts === 1) throw new Error('transient')
    return 'ok'
  }, 'timed out')

  assert.equal(result, 'ok')
  assert.equal(attempts, 2)
  assert.equal(JSON.parse(logs[0]).event, 'provider_upstream_error')
  assert.equal(JSON.parse(logs[0]).operation, 'speech_retry')
})

test('provider retry wrapper does not retry when disabled', async () => {
  let attempts = 0
  await assert.rejects(
    withProviderRetry('mock', 'speech', {
      config: { auto_retry: false, retry_count: 3 },
      secrets: {},
      enabled: true,
    }, 1000, async () => {
      attempts += 1
      throw new Error('transient')
    }, 'timed out'),
    /transient/,
  )
  assert.equal(attempts, 1)
})

test('provider retry wrapper retries service timeout at most once', async () => {
  const logs = []
  console.error = message => logs.push(message)
  let attempts = 0

  await assert.rejects(
    withProviderRetry('mock', 'speech', {
      config: { auto_retry: true, retry_count: 5 },
      secrets: {},
      enabled: true,
    }, 5, async () => {
      attempts += 1
      return new Promise(() => {})
    }, 'timed out'),
    /timed out/,
  )

  assert.equal(attempts, 2)
  assert.equal(logs.length, 1)
  assert.match(JSON.parse(logs[0]).detail, /after timeout/)
})

test('provider retry wrapper supports voice design operations', async () => {
  const logs = []
  console.error = message => logs.push(message)
  let attempts = 0
  const result = await withProviderRetry('mimo', 'voice_design', {
    config: { auto_retry: true, retry_count: 1 },
    secrets: {},
    enabled: true,
  }, 1000, async () => {
    attempts += 1
    if (attempts === 1) throw new Error('transient')
    return 'preview'
  }, 'timed out')

  assert.equal(result, 'preview')
  assert.equal(attempts, 2)
  assert.equal(JSON.parse(logs[0]).operation, 'voice_design_retry')
})
