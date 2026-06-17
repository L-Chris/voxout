import { Service } from 'typedi'

const FREESOUND_SEARCH_PARAMS = new Set([
  'query',
  'filter',
  'sort',
  'similar_to',
  'similar_space',
  'group_by_pack',
  'weights',
  'fields',
  'page',
  'page_size',
])
const DEFAULT_FREESOUND_FIELDS = 'id,name,tags,username,license,url,previews,duration,type'
const PREVIEW_KEYS = ['preview-hq-mp3', 'preview-lq-mp3', 'preview-hq-ogg', 'preview-lq-ogg']

@Service()
export class SearchService {
  async search(input: string | Record<string, unknown>) {
    const url = new URL('/apiv2/search/', getFreesoundBaseUrl())
    const params = normalizeSearchParams(input)
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value)
    }

    const token = process.env.FREESOUND_API_KEY?.trim()
    if (!token) throw httpError('FREESOUND_API_KEY is required for Freesound token authentication.', 400)
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Token ${token}`,
    }

    const response = await fetch(url, { headers })
    const payload = await readFreesoundJson(response)
    if (!response.ok) {
      throw httpError(formatFreesoundError(payload) || `Freesound search failed: ${response.status}`, response.status >= 500 ? 502 : response.status)
    }
    return addPreviewUrls(payload)
  }
}

function normalizeSearchParams(input: string | Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {}
  const entries = typeof input === 'string'
    ? [...new URLSearchParams(input).entries()]
    : Object.entries(input)
  let minDuration: number | undefined
  let maxDuration: number | undefined
  for (const [key, rawValue] of entries) {
    if (rawValue == null || rawValue === '') continue
    const normalizedKey = key === 'q' ? 'query' : key
    if (normalizedKey === 'min_duration' || normalizedKey === 'duration_min') {
      minDuration = normalizeDuration(rawValue)
      continue
    }
    if (normalizedKey === 'max_duration' || normalizedKey === 'duration_max') {
      maxDuration = normalizeDuration(rawValue)
      continue
    }
    if (!FREESOUND_SEARCH_PARAMS.has(normalizedKey)) continue
    const value = Array.isArray(rawValue) ? rawValue.at(-1) : rawValue
    if (value == null || value === '') continue
    params[normalizedKey] = String(value)
  }
  const filter = appendDurationFilter(params.filter, minDuration, maxDuration)
  if (filter) params.filter = filter
  params.fields = ensurePreviewField(params.fields || DEFAULT_FREESOUND_FIELDS)
  params.page = normalizePositiveInteger(params.page, 1, Number.MAX_SAFE_INTEGER)
  params.page_size = normalizePositiveInteger(params.page_size, 15, 150)
  return params
}

function normalizeDuration(value: unknown): number | undefined {
  const parsed = Number(Array.isArray(value) ? value.at(-1) : value)
  if (!Number.isFinite(parsed) || parsed < 0) return undefined
  return parsed
}

function appendDurationFilter(filter: string | undefined, minDuration: number | undefined, maxDuration: number | undefined): string | undefined {
  if (minDuration == null && maxDuration == null) return filter
  if (minDuration != null && maxDuration != null && minDuration > maxDuration) {
    throw httpError('min_duration cannot be greater than max_duration.', 400)
  }
  const min = minDuration == null ? '*' : formatDurationFilterValue(minDuration)
  const max = maxDuration == null ? '*' : formatDurationFilterValue(maxDuration)
  const durationFilter = `duration:[${min} TO ${max}]`
  return [filter?.trim(), durationFilter].filter(Boolean).join(' ')
}

function formatDurationFilterValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(value)
}

function ensurePreviewField(fields: string): string {
  const fieldList = fields.split(',').map(field => field.trim()).filter(Boolean)
  return fieldList.includes('previews') ? fieldList.join(',') : [...fieldList, 'previews'].join(',')
}

function normalizePositiveInteger(value: string | undefined, fallback: number, max: number): string {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1) return String(fallback)
  return String(Math.min(max, Math.floor(parsed)))
}

function getFreesoundBaseUrl(): string {
  return process.env.FREESOUND_API_BASE_URL?.trim() || 'https://freesound.org'
}

async function readFreesoundJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    return { detail: text.slice(0, 500) }
  }
}

function formatFreesoundError(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const record = payload as Record<string, unknown>
  for (const key of ['detail', 'message', 'error']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function addPreviewUrls(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return payload
  const record = payload as Record<string, unknown>
  if (!Array.isArray(record.results)) return payload
  return {
    ...record,
    results: record.results.map(result => {
      if (!result || typeof result !== 'object') return result
      const item = result as Record<string, unknown>
      return {
        ...item,
        preview_url: getPreviewUrl(item.previews),
      }
    }),
  }
}

function getPreviewUrl(previews: unknown): string | undefined {
  if (!previews || typeof previews !== 'object') return undefined
  const record = previews as Record<string, unknown>
  for (const key of PREVIEW_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value
  }
  return undefined
}

function httpError(message: string, status: number): Error {
  const error = new Error(message) as Error & { httpCode: number }
  error.httpCode = status
  return error
}
