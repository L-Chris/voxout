import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { BilibiliAsrProvider } from '../dist/providers/bilibili-asr.js'
import { listProviderDefinitions } from '../dist/providers/registry.js'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('Bilibili ASR provider sends media subtitle requests', async () => {
  let captured
  globalThis.fetch = async (url, init) => {
    captured = {
      url: String(url),
      method: init.method,
      body: JSON.parse(init.body),
    }
    return new Response(JSON.stringify({
      url: 'https://example.com/audio.m4a',
      subtitle: '转写文本',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const provider = new BilibiliAsrProvider()
  const result = await provider.transcribe(
    { url: 'https://example.com/audio.m4a', format: 'txt' },
    { config: { baseUrl: 'http://bilibili-mcp:8001' }, secrets: {} },
  )

  assert.equal(captured.url, 'http://bilibili-mcp:8001/api/media/subtitle')
  assert.equal(captured.method, 'POST')
  assert.deepEqual(captured.body, { url: 'https://example.com/audio.m4a', format: 'txt' })
  assert.equal(result.provider, 'bilibili-asr')
  assert.equal(result.text, '转写文本')
})

test('Provider definitions include ASR providers', () => {
  const providers = listProviderDefinitions()
  const asr = providers.find(item => item.id === 'bilibili-asr')
  assert.equal(asr.capabilities.asr, true)
  assert.ok(asr.fields.some(field => field.key === 'baseUrl'))
})
