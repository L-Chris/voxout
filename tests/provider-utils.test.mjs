import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { logProviderResponseError } from '../dist/providers/provider-utils.js'

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
