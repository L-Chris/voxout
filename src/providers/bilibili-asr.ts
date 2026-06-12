import type { AsrProvider, ProviderContext, TranscribeRequest, TranscribeResult } from '../types.js'

const DEFAULT_BASE_URL = 'http://bilibili-mcp:8001'

export class BilibiliAsrProvider implements AsrProvider {
  readonly id = 'bilibili-asr'
  readonly name = 'Bilibili MCP ASR'
  readonly capabilities = { asr: true }
  readonly fields = [
    { key: 'baseUrl', label: 'Bilibili MCP Base URL', type: 'url' as const, placeholder: DEFAULT_BASE_URL },
  ]

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}) {
    const baseUrl = trimTrailingSlash(getConfigString(context, 'baseUrl') ?? DEFAULT_BASE_URL)
    const format = normalizeFormat(request.format)
    const response = request.bvid
      ? await fetch(`${baseUrl}/api/video/subtitle/${encodeURIComponent(request.bvid)}?format=${encodeURIComponent(format)}`)
      : await fetch(`${baseUrl}/api/media/subtitle`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: request.url, format }),
      })

    const payload = await readJson(response)
    if (!response.ok) {
      throw new Error(getPayloadError(payload) || `Bilibili ASR request failed: ${response.status}`)
    }
    const subtitle = (payload as { subtitle?: unknown }).subtitle
    return normalizeResult(this.id, format, subtitle)
  }
}

function normalizeResult(provider: string, format: string, subtitle: unknown): TranscribeResult {
  if (Array.isArray(subtitle)) {
    return {
      provider,
      format: 'raw',
      segments: subtitle.map(item => ({
        from: Number((item as { from?: unknown }).from ?? 0),
        to: Number((item as { to?: unknown }).to ?? 0),
        content: String((item as { content?: unknown }).content ?? ''),
      })),
      text: subtitle.map(item => String((item as { content?: unknown }).content ?? '')).join(''),
      raw: subtitle,
    }
  }
  const text = typeof subtitle === 'string' ? subtitle : JSON.stringify(subtitle ?? '')
  return {
    provider,
    format,
    text,
    raw: subtitle,
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { error: text }
  }
}

function getPayloadError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const error = (payload as { error?: unknown }).error
  return typeof error === 'string' ? error : undefined
}

function normalizeFormat(format: string | undefined): 'txt' | 'srt' | 'raw' {
  return format === 'srt' || format === 'raw' ? format : 'txt'
}

function getConfigString(context: ProviderContext, key: string): string | undefined {
  const value = context.config?.[key]
  if (typeof value === 'string' && value.trim()) return value.trim()
  return undefined
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
