import type { AsrProvider, JsonObject, JsonValue, ProviderContext, ProviderFieldDefinition, TranscribeRequest, TranscribeResult } from '../../types.js'
import {
  fetchWithProviderTimeout,
  getConfigNumber,
  getConfigString,
  logProviderResponseError,
  logProviderUpstreamError,
  readJsonResponse,
  trimTrailingSlash,
} from '../provider-utils.js'

const DEFAULT_BASE_URL = 'https://member.bilibili.com/x/bcut/rubick-interface'
const DEFAULT_MODEL_ID = '8'
const DEFAULT_ASR_MODEL = 'default-asr'
const DEFAULT_POLL_INTERVAL_MS = 5000
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
const SUPPORTED_FORMATS = new Set(['flac', 'aac', 'm4a', 'mp3', 'wav', 'mp4', 'm4s'])
const MIME_FORMATS: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/x-m4a': 'm4a',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
}

interface BcutResourceCreatePayload {
  resource_id?: string
  in_boss_key?: string
  upload_id?: string
  upload_urls?: string[]
  per_size?: number
}

interface BcutResourceCompletePayload {
  download_url?: string
}

interface BcutTaskCreatePayload {
  task_id?: string
}

interface BcutTaskResultPayload {
  state?: number
  result?: string
  remark?: string
}

interface BcutApiPayload<T> {
  code?: number
  message?: string
  data?: T
}

interface BcutResultDocument {
  utterances?: Array<{
    start_time?: number
    end_time?: number
    transcript?: string
    words?: unknown[]
  }>
  version?: string
}

export class BilibiliBcutAsrProvider implements AsrProvider {
  readonly id: string
  readonly name: string
  readonly capabilities = { asr: true }
  readonly fields: ProviderFieldDefinition[] = [
    { key: 'asr_model', label: 'ASR Model', type: 'text', placeholder: DEFAULT_ASR_MODEL, options: [DEFAULT_ASR_MODEL] },
    { key: 'bcut_model_id', label: 'Bcut Model ID', type: 'text', placeholder: DEFAULT_MODEL_ID },
    { key: 'bcut_base_url', label: 'Bcut Base URL', type: 'url', placeholder: DEFAULT_BASE_URL },
    { key: 'bcut_poll_interval_ms', label: 'ASR Poll Interval (ms)', type: 'number', placeholder: String(DEFAULT_POLL_INTERVAL_MS) },
  ]

  constructor(id = 'default', name = 'Bilibili Bcut ASR') {
    this.id = id
    this.name = name
  }

  async transcribe(request: TranscribeRequest, context: ProviderContext = {}): Promise<TranscribeResult> {
    const model_id = getModelId(this.id, request, context)
    const file_format = getFileFormat(request.file.file_name, request.file.mime_type)
    const resource = await createResource(request, context, model_id, file_format)
    const etags = await uploadParts(request.file.data, resource.upload_urls, resource.per_size, context)
    const download_url = await completeResource(resource, etags, context, model_id)
    const task_id = await createTask(download_url, context, model_id, request.extra_params)
    const task = await pollTask(task_id, context, model_id)
    const parsed = parseTaskResult(task)
    const segments = (parsed.utterances ?? [])
      .filter(item => typeof item.transcript === 'string')
      .map(item => ({
        from: Number(item.start_time ?? 0) / 1000,
        to: Number(item.end_time ?? item.start_time ?? 0) / 1000,
        content: String(item.transcript ?? ''),
      }))
    const text = segments.map(segment => segment.content).join('').trim()
    if (!text) throw new Error('Bilibili Bcut ASR response did not include transcribed text.')
    return {
      provider: this.id,
      format: request.format ?? 'txt',
      text,
      segments,
      raw: request.format === 'raw' ? parsed : undefined,
    }
  }
}

async function createResource(
  request: TranscribeRequest,
  context: ProviderContext,
  model_id: string,
  file_format: string,
): Promise<Required<BcutResourceCreatePayload>> {
  const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/resource/create`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: createFormBody({
      type: 2,
      name: request.file.file_name || `audio.${file_format}`,
      size: request.file.data.length,
      resource_file_type: file_format,
      model_id,
    }, request.extra_params),
  }, context)
  const payload = await readBcutData<BcutResourceCreatePayload>(response, 'Bilibili Bcut resource create')
  if (!payload.resource_id || !payload.in_boss_key || !payload.upload_id || !payload.upload_urls?.length || !payload.per_size) {
    throw new Error('Bilibili Bcut resource create response was incomplete.')
  }
  return {
    resource_id: payload.resource_id,
    in_boss_key: payload.in_boss_key,
    upload_id: payload.upload_id,
    upload_urls: payload.upload_urls,
    per_size: payload.per_size,
  }
}

async function uploadParts(
  data: Buffer,
  upload_urls: string[],
  per_size: number,
  context: ProviderContext,
): Promise<string[]> {
  const etags: string[] = []
  for (const [index, upload_url] of upload_urls.entries()) {
    const start = index * per_size
    const end = Math.min(start + per_size, data.length)
    const response = await fetchWithProviderTimeout(upload_url, {
      method: 'PUT',
      headers: getHeaders(),
      body: data.subarray(start, end),
    }, context)
    if (!response.ok) {
      const detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 500)
      logProviderResponseError('default', 'bilibili_bcut_upload_part', response, detail)
      throw new Error(detail || `Bilibili Bcut upload part failed: ${response.status}`)
    }
    const etag = response.headers.get('etag')
    if (!etag) throw new Error('Bilibili Bcut upload response did not include Etag.')
    etags.push(etag)
  }
  return etags
}

async function completeResource(
  resource: Required<BcutResourceCreatePayload>,
  etags: string[],
  context: ProviderContext,
  model_id: string,
): Promise<string> {
  const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/resource/create/complete`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    },
    body: createFormBody({
      in_boss_key: resource.in_boss_key,
      resource_id: resource.resource_id,
      etags: etags.join(','),
      upload_id: resource.upload_id,
      model_id,
    }),
  }, context)
  const payload = await readBcutData<BcutResourceCompletePayload>(response, 'Bilibili Bcut resource complete')
  if (!payload.download_url) throw new Error('Bilibili Bcut resource complete response did not include download_url.')
  return payload.download_url
}

async function createTask(
  resource: string,
  context: ProviderContext,
  model_id: string,
  extra_params?: JsonObject,
): Promise<string> {
  const response = await fetchWithProviderTimeout(`${getBaseUrl(context)}/task`, {
    method: 'POST',
    headers: {
      ...getHeaders(),
      'content-type': 'application/json',
    },
    body: JSON.stringify(mergeBcutJson({ resource, model_id }, extra_params)),
  }, context)
  const payload = await readBcutData<BcutTaskCreatePayload>(response, 'Bilibili Bcut task create')
  if (!payload.task_id) throw new Error('Bilibili Bcut task create response did not include task_id.')
  return payload.task_id
}

async function pollTask(task_id: string, context: ProviderContext, model_id: string): Promise<BcutTaskResultPayload> {
  const timeout = getTimeoutMs(context)
  const poll_interval_ms = Math.max(250, getConfigNumber(context, 'bcut_poll_interval_ms') ?? DEFAULT_POLL_INTERVAL_MS)
  const deadline = Date.now() + timeout
  while (Date.now() <= deadline) {
    const url = new URL(`${getBaseUrl(context)}/task/result`)
    url.searchParams.set('model_id', model_id)
    url.searchParams.set('task_id', task_id)
    const response = await fetchWithProviderTimeout(url, {
      method: 'GET',
      headers: getHeaders(),
    }, context)
    const payload = await readBcutData<BcutTaskResultPayload>(response, 'Bilibili Bcut task result')
    if (payload.state === 3) {
      logProviderUpstreamError({
        provider: 'default',
        operation: 'bilibili_bcut_task_result',
        url: response.url,
        detail: payload.remark || payload,
      })
      throw new Error(payload.remark || 'Bilibili Bcut ASR task failed.')
    }
    if (payload.state === 4) return payload
    await sleep(Math.min(poll_interval_ms, Math.max(0, deadline - Date.now())))
  }
  throw new Error(`Bilibili Bcut ASR task timed out after ${timeout}ms.`)
}

async function readBcutData<T>(response: Response, label: string): Promise<T> {
  const payload = await readJsonResponse<BcutApiPayload<T>>(response, 'errorMessageObject')
  if (!response.ok) {
    logProviderResponseError('default', label.replace(/^Bilibili Bcut\s+/i, 'bilibili_bcut_').replace(/\s+/g, '_').toLowerCase(), response, payload.message ?? payload)
    throw new Error(payload.message || `${label} request failed: ${response.status}`)
  }
  if (payload.code) {
    logProviderUpstreamError({
      provider: 'default',
      operation: label.replace(/^Bilibili Bcut\s+/i, 'bilibili_bcut_').replace(/\s+/g, '_').toLowerCase(),
      url: response.url,
      detail: payload.message ?? payload,
    })
    throw new Error(payload.message || `${label} returned code ${payload.code}`)
  }
  if (!payload.data) throw new Error(`${label} response did not include data.`)
  return payload.data
}

function parseTaskResult(payload: BcutTaskResultPayload): BcutResultDocument {
  if (!payload.result) throw new Error(payload.remark || 'Bilibili Bcut ASR task result was empty.')
  try {
    const parsed = JSON.parse(payload.result) as BcutResultDocument
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    throw new Error('Bilibili Bcut ASR task result was not valid JSON.')
  }
}

function createFormBody(fields: Record<string, string | number>, extra_params?: JsonObject): URLSearchParams {
  const body = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) body.set(key, String(value))
  appendJsonParamsToSearchParams(body, extra_params)
  return body
}

function appendJsonParamsToSearchParams(body: URLSearchParams, params?: JsonObject): void {
  if (!params) return
  for (const [key, value] of Object.entries(params)) {
    if (body.has(key)) continue
    appendJsonParamToSearchParams(body, key, value)
  }
}

function appendJsonParamToSearchParams(body: URLSearchParams, key: string, value: JsonValue): void {
  const array_key = key.endsWith('[]') ? key : `${key}[]`
  if (Array.isArray(value)) {
    for (const item of value) body.append(array_key, stringifyFormValue(item))
    return
  }
  body.set(key, stringifyFormValue(value))
}

function mergeBcutJson(base: Record<string, JsonValue>, extra_params?: JsonObject): Record<string, JsonValue> {
  return {
    ...(extra_params ?? {}),
    ...base,
  }
}

function stringifyFormValue(value: JsonValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function getModelId(provider_id: string, request: TranscribeRequest, context: ProviderContext): string {
  const model = request.model?.trim()
  if (model && model !== provider_id && model !== DEFAULT_ASR_MODEL) return model
  return getConfigString(context, 'bcut_model_id') ?? normalizeConfiguredModelId(getConfigString(context, 'asr_model')) ?? DEFAULT_MODEL_ID
}

function normalizeConfiguredModelId(value: string | undefined): string | undefined {
  if (!value || value === DEFAULT_ASR_MODEL) return undefined
  return value
}

function getFileFormat(file_name: string, mime_type: string): string {
  const extension = file_name.split('?')[0]?.split('.').pop()?.toLowerCase()
  if (extension && SUPPORTED_FORMATS.has(extension)) return extension
  const format = MIME_FORMATS[mime_type.toLowerCase()]
  if (format) return format
  throw new Error(`Bilibili Bcut ASR does not support file type "${mime_type || file_name}"`)
}

function getBaseUrl(context: ProviderContext): string {
  return trimTrailingSlash(getConfigString(context, 'bcut_base_url') ?? DEFAULT_BASE_URL)
}

function getHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-cache',
    'user-agent': USER_AGENT,
  }
}

function getTimeoutMs(context: ProviderContext): number {
  return Math.max(1, getConfigNumber(context, 'timeout') ?? 45000)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
