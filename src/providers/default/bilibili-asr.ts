import type { AsrProvider, TranscribeRequest, TranscribeResult } from '../../types.js'
import { getPayloadError, readJsonResponse } from '../provider-utils.js'

const API_BASE_URL = 'https://member.bilibili.com/x/bcut/rubick-interface'
const API_CREATE_TASK = `${API_BASE_URL}/task`
const API_QUERY_RESULT = `${API_BASE_URL}/task/result`
const BCUT_MODEL_ID = '8'
const POLL_INTERVAL_MS = 5000
const DEFAULT_TIMEOUT_MS = 180000
const REQUEST_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  'cache-control': 'no-cache',
}

interface BcutApiResponse<T> {
  code?: number
  message?: string
  data?: T
}

interface BcutTaskCreatePayload {
  task_id?: string
}

interface BcutTaskResultPayload {
  task_id?: string
  result?: string
  remark?: string
  state?: number
}

interface BcutAsrData {
  utterances?: Array<{
    start_time?: number
    end_time?: number
    transcript?: string
  }>
}

export class BilibiliAsrProvider implements AsrProvider {
  readonly id: string
  readonly name: string
  readonly capabilities = { asr: true }
  readonly fields = []

  constructor(id = 'default', name = 'Bilibili ASR') {
    this.id = id
    this.name = name
  }

  async transcribe(request: TranscribeRequest) {
    const format = normalizeFormat(request.format)
    const url = request.url?.trim()
    if (!url) throw new Error('Bilibili ASR requires a media url.')
    const subtitle = await getAudioSubtitle(url, format)
    return normalizeResult(this.id, format, subtitle)
  }
}

async function getAudioSubtitle(url: string, format: 'txt' | 'srt' | 'raw'): Promise<string | Array<{ from: number, to: number, content: string }>> {
  const taskId = await createTask(url)
  const result = await pollTaskResult(taskId)
  const asrData = parseAsrData(result.result)
  if (format === 'srt') return toSrt(asrData)
  if (format === 'raw') return toRawSegments(asrData)
  return toText(asrData)
}

async function createTask(url: string): Promise<string> {
  const payload = await postJson<BcutTaskCreatePayload>(API_CREATE_TASK, {
    resource: url,
    model_id: BCUT_MODEL_ID,
  })
  if (!payload.task_id) throw new Error('Bilibili ASR task response did not include task_id.')
  return payload.task_id
}

async function pollTaskResult(taskId: string): Promise<BcutTaskResultPayload> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const result = await getJson<BcutTaskResultPayload>(`${API_QUERY_RESULT}?model_id=${encodeURIComponent(BCUT_MODEL_ID)}&task_id=${encodeURIComponent(taskId)}`)
    if (result.state === 3) throw new Error(result.remark || 'Bilibili ASR task failed.')
    if (result.state === 4) return result
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error('Bilibili ASR task timed out.')
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...REQUEST_HEADERS,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  return readBcutResponse<T>(response)
}

async function getJson<T>(url: string): Promise<T> {
  return readBcutResponse<T>(await fetch(url, { headers: REQUEST_HEADERS }))
}

async function readBcutResponse<T>(response: Response): Promise<T> {
  const payload = await readJsonResponse<BcutApiResponse<T>>(response)
  if (!response.ok) throw new Error(getPayloadError(payload) || `Bilibili ASR request failed: ${response.status}`)
  if (payload.code) throw new Error(payload.message || `Bilibili ASR request failed: ${payload.code}`)
  if (!payload.data) throw new Error('Bilibili ASR response did not include data.')
  return payload.data
}

function parseAsrData(value: string | undefined): BcutAsrData {
  if (!value) throw new Error('Bilibili ASR result was empty.')
  return JSON.parse(value) as BcutAsrData
}

function toText(data: BcutAsrData): string {
  return (data.utterances ?? []).map(segment => segment.transcript ?? '').join('')
}

function toSrt(data: BcutAsrData): string {
  return (data.utterances ?? [])
    .map(segment => `[${formatTimestamp(segment.start_time ?? 0)}_${formatTimestamp(segment.end_time ?? 0)}]${segment.transcript ?? ''}`)
    .join('\n')
}

function toRawSegments(data: BcutAsrData): Array<{ from: number, to: number, content: string }> {
  return (data.utterances ?? []).map(segment => ({
    from: Number(segment.start_time ?? 0) / 1000,
    to: Number(segment.end_time ?? 0) / 1000,
    content: segment.transcript ?? '',
  }))
}

function formatTimestamp(ms: number): string {
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  const milli = Math.floor(ms % 1000)
  return `${pad(h)}:${pad(m)}:${pad(s)}.${String(milli).padStart(3, '0')}`
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

function normalizeFormat(format: string | undefined): 'txt' | 'srt' | 'raw' {
  return format === 'srt' || format === 'raw' ? format : 'txt'
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
