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
    return payload
  }
}

function normalizeSearchParams(input: string | Record<string, unknown>): Record<string, string> {
  const params: Record<string, string> = {}
  const entries = typeof input === 'string'
    ? [...new URLSearchParams(input).entries()]
    : Object.entries(input)
  for (const [key, rawValue] of entries) {
    if (rawValue == null || rawValue === '') continue
    const normalizedKey = key === 'q' ? 'query' : key
    if (!FREESOUND_SEARCH_PARAMS.has(normalizedKey)) continue
    const value = Array.isArray(rawValue) ? rawValue.at(-1) : rawValue
    if (value == null || value === '') continue
    params[normalizedKey] = String(value)
  }
  params.fields = params.fields || DEFAULT_FREESOUND_FIELDS
  params.page = normalizePositiveInteger(params.page, 1, Number.MAX_SAFE_INTEGER)
  params.page_size = normalizePositiveInteger(params.page_size, 15, 150)
  return params
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

function httpError(message: string, status: number): Error {
  const error = new Error(message) as Error & { httpCode: number }
  error.httpCode = status
  return error
}
